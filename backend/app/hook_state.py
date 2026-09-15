import json
import logging
import re
from pathlib import Path
from typing import Callable, Optional

from watchfiles import Change, awatch

from app import atomico
from app.procinfo import pid_vivo

_log = logging.getLogger("hangar.hook_state")

_SUBDIR = ".hangar-state"
# Registro nativo do Claude Code: `<config>/sessions/<pid>.json`, escrito pelo proprio REPL a cada
# mudanca de estado da TUI e apagado na saida. `waiting` cobre permissao, AskUserQuestion, recado
# de par segurado E dialogo aberto (/model, /config) — pra este ultimo o pane rebaixa (demote).
_REGISTRO_DIR = "sessions"
_REGISTRO_RE = re.compile(r"^\d+\.json$")
_ESTADO_REGISTRO = {"idle": "idle", "busy": "working", "waiting": "awaiting_input"}


class HookState:
    """Estado da LISTA por sessao, vindo dos hooks do Claude (state_hook.py grava marcadores).
    Mapa em memoria session_id -> (state, ts). get_state() devolve None se nao ha marcador
    (o caller cai no fallback de raspar o pane)."""

    def __init__(self) -> None:
        self._map: dict[str, tuple[str, float]] = {}
        # Registro nativo por session_id -> (state, ts, pid). Vence o marcador enquanto o pid vive:
        # e o estado que a TUI tem, sem depender de hook instalado nem de evento que nao existe
        # (Esc num pedido de permissao nao dispara Stop e deixava o marcador preso em working).
        self._registro: dict[str, tuple[str, float, int]] = {}
        self._registro_arquivo: dict[str, str] = {}  # caminho -> session_id (pra remover na saida)
        # Dirs registrados (load_existing/watch) — demote_awaiting precisa achar o sidecar.
        self._dirs: list[Path] = []
        # Disparado na transicao -> awaiting_input (so no watch ao vivo, nao no load_existing do boot).
        # Wiring em api.py manda o push. Recebe o session_id (uuid); best-effort, nunca levanta.
        self.on_awaiting: Optional[Callable[[str], None]] = None
        # Disparado em QUALQUER mudanca de estado ao vivo: (session_id, state). Wiring em api.py:
        # drain server-side (entrega a fila sem depender de conexao SSE) + confirmacao de entrega.
        self.on_transition: Optional[Callable[[str, str], None]] = None

    def get_state(self, session_id: Optional[str]) -> Optional[tuple[str, float]]:
        if not session_id:
            return None
        r = self._registro.get(session_id)
        if r is not None and pid_vivo(r[2]):
            return (r[0], r[1])
        return self._map.get(session_id)

    def _apply(self, path: Path, notify: bool = False) -> None:
        # Le UM marcador pro mapa. Falha-soft: marcador parcial/corrompido e ignorado.
        try:
            o = json.loads(path.read_text(encoding="utf-8"))
            state, ts = o["state"], float(o["ts"])
        except Exception:
            return
        prev = self.get_state(path.stem)
        self._map[path.stem] = (state, ts)
        if notify:
            self._notificar(path.stem, prev, self.get_state(path.stem))

    def _apply_registro(self, path: Path, notify: bool = False) -> None:
        # Le UM arquivo do registro nativo. Status fora do mapa (desconhecido) nao vale mais que o
        # marcador: fica de fora. Falha-soft como o marcador.
        try:
            o = json.loads(path.read_text(encoding="utf-8"))
            sid, pid = str(o["sessionId"]), int(o["pid"])
            state = _ESTADO_REGISTRO[o["status"]]
            ts = float(o.get("statusUpdatedAt") or o["updatedAt"]) / 1000.0
        except Exception:
            return
        prev = self.get_state(sid)
        self._registro[sid] = (state, ts, pid)
        self._registro_arquivo[str(path)] = sid
        if notify:
            self._notificar(sid, prev, self.get_state(sid))

    def _remover_registro(self, path: Path, notify: bool = False) -> None:
        sid = self._registro_arquivo.pop(str(path), None)
        if sid is None:
            return
        prev = self.get_state(sid)
        self._registro.pop(sid, None)
        if notify:
            self._notificar(sid, prev, self.get_state(sid))

    def _notificar(self, sid: str, prev: Optional[tuple[str, float]],
                   cur: Optional[tuple[str, float]]) -> None:
        if cur is None:
            return
        state = cur[0]
        # Transicao -> awaiting_input (so ao vivo). prev None = marcador novo aparecendo ja awaiting
        # (sessao acabou de pedir input) tambem conta. awaiting->awaiting (so o ts mudou) nao re-dispara.
        if state == "awaiting_input" and (prev is None or prev[0] != "awaiting_input"):
            cb = self.on_awaiting
            if cb:
                try:
                    cb(sid)
                except Exception:
                    pass
        # Mudanca de estado (qualquer) ao vivo -> on_transition (drain server-side / confirmacao).
        if prev is None or prev[0] != state:
            cb2 = self.on_transition
            if cb2:
                try:
                    cb2(sid, state)
                except Exception:
                    pass

    def demote_awaiting(self, session_id: str) -> None:
        """Rebaixa um marcador awaiting_input pra idle — mapa E sidecar. Chamado quando o pane
        raspado contradiz o marcador: o state_hook mapeia QUALQUER Notification pra awaiting, e a
        Notification de "idle 60s" do Claude Code chega DEPOIS do Stop sem nenhum evento posterior
        que corrija -> sem isto a sessao parada fica "aguardando" pra sempre na lista. Persistir no
        sidecar importa: o boot re-semeia o mapa de la (load_existing). ts original preservado."""
        r = self._registro.get(session_id)
        if r is not None and r[0] == "awaiting_input":
            # So em memoria: o arquivo e do Claude. O proximo `waiting` real regrava.
            self._registro[session_id] = ("idle", r[1], r[2])
        cur = self._map.get(session_id)
        if not cur or cur[0] != "awaiting_input":
            return
        self._map[session_id] = ("idle", cur[1])
        for base in self._dirs:
            f = base / _SUBDIR / f"{session_id}.json"
            if f.is_file():
                try:
                    tmp = f.with_suffix(".json.tmp")
                    tmp.write_text(json.dumps({"state": "idle", "ts": cur[1]}), encoding="utf-8")
                    atomico.substituir(tmp, f)  # atomico, mesmo padrao do state_hook
                except OSError:
                    # Mapa ja esta idle mas o sidecar ficou awaiting: proximo BOOT re-semeia o
                    # fantasma (load_existing le do disco). Logar e o rastro pra entender o retorno.
                    _log.warning("demote_awaiting: falha ao regravar sidecar %s", f, exc_info=True)

    @staticmethod
    def _registro_dirs(dirs: list[Path]) -> list[Path]:
        # As contas (`~/.claude-<nome>/sessions`) sao symlink pro principal: um so, resolvido.
        return list(dict.fromkeys((base / _REGISTRO_DIR).resolve() for base in dirs))

    def load_existing(self, dirs: list[Path]) -> None:
        # Semeia o mapa com os marcadores ja presentes (no startup do backend).
        self._dirs = list(dict.fromkeys([*self._dirs, *dirs]))
        for base in dirs:
            sd = base / _SUBDIR
            if not sd.is_dir():
                continue
            for f in sd.glob("*.json"):
                self._apply(f)
        for rd in self._registro_dirs(dirs):
            if not rd.is_dir():
                continue
            for f in rd.iterdir():
                if _REGISTRO_RE.match(f.name):
                    self._apply_registro(f)

    async def watch(self, dirs: list[Path]) -> None:
        # Loop longo: observa cada <config>/.hangar-state e o registro nativo, aplica cada mudanca.
        self._dirs = list(dict.fromkeys([*self._dirs, *dirs]))
        watched = []
        for base in dirs:
            sd = base / _SUBDIR
            sd.mkdir(parents=True, exist_ok=True)  # garante existir pro awatch nao falhar
            watched.append(str(sd))
        for rd in self._registro_dirs(dirs):
            rd.mkdir(parents=True, exist_ok=True)
            watched.append(str(rd))
        async for changes in awatch(*watched):
            for change, p in changes:
                path = Path(p)
                if path.parent.name == _REGISTRO_DIR:
                    if not _REGISTRO_RE.match(path.name):
                        continue
                    if change == Change.deleted:
                        self._remover_registro(path, notify=True)
                    else:
                        self._apply_registro(path, notify=True)
                elif path.suffix == ".json":
                    self._apply(path, notify=True)


# Singleton de modulo (igual ao padrao do registry/installer).
hook_state = HookState()
