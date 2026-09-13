"""Claude SEM terminal: o `claude` como processo filho do backend, falando stream-json.

Sem pane, sem tmux, sem raspar tela. O que muda em relação à sessão Claude comum é só a FONTE
do que é vivo: estado, prévia, permissão, pergunta e statusline vêm do stdout do processo, e a
entrada vai pelo stdin. O histórico continua no `.jsonl` que o próprio Claude grava, lido pelo
mesmo parser (`TranscriptTailer`) das sessões no tmux — bolhas, tool cards, thinking, imagens,
`/history`, estatísticas e o `reset` do `/clear` não sabem que não há pane.

Protocolo (medido contra a CLI, ver docs/research/claude-sem-terminal-monocode.md):
- stdin: `{"type":"user","message":{...}}` manda prompt; `{"type":"control_request",...}` com
  `initialize`, `interrupt`, `set_model`, `set_permission_mode`, `list_models`; e
  `{"type":"control_response",...}` responde permissão/pergunta.
- stdout: `system/init` (session_id, modelo, modo), `stream_event` (deltas), `assistant`,
  `user` (tool_result), `control_request can_use_tool` (permissão e AskUserQuestion), `result`
  (fim de turno, custo, uso), `rate_limit_event`, `conversation_reset` (/clear).

O processo morre com o backend; o próximo prompt sobe outro com `--resume <sid>`. Tudo que
precisa sobreviver está no sidecar (sessions.py).
"""
from __future__ import annotations

import asyncio
import base64
import collections
import json
import logging
import os
import re
import shutil
import signal
import sys
import time
import uuid
from pathlib import Path
from typing import AsyncIterator, Callable, Optional

from app import atomico, cotas, model_args
from app.adapters.claude_headless import cano as cano_mod
from app.adapters.claude_headless import sessions as hl_sessions
from app.adapters.codex.adapter import _fmt_tok, _format_reset
from app.adapters.preview_push import PushPreviewSource
from app.config import settings
from app.pqueue import PromptQueue
from app.procinfo import pid_vivo
from app.state import StateEvent
from app.transcript import ChatEvent, TranscriptTailer

_log = logging.getLogger("hangar.claude_headless")

# Mesma regra de app.registry.sanitize_cwd (duplicada pelo mesmo motivo do adapters/claude.py).
_SANITIZE_RE = re.compile(r"[^A-Za-z0-9]")

# Chave interna do adapter no registro de providers. O `provider` da sessão continua "claude"
# (é Claude para o front, comandos, estatísticas e cotas); só o transporte é outro.
CHAVE = "claude-headless"

# Os hooks de SessionStart rodam antes do initialize responder, e com muitos plugins passam de 20s.
# Até o aviso a sessão só aparece "Iniciando…"; depois dele o problema fica à vista, mas a espera
# segue até o teto — resposta tardia limpa o problema.
_AVISO_INIT_S = 60.0
_TETO_INIT_S = 180.0
_TETO_CTRL_S = 15.0
_TETO_CANO_S = 10.0        # do spawn do cano até ele escutar
_LIMITE_LINHA = 16 << 20   # uma linha do stream-json (initialize responde >100 KB)
# Env do cano (e do claude, que herda): a chave do sidecar. É por ela que a varredura de órfãos
# distingue "cano de sessão viva" de "cano cuja sessão foi encerrada com o backend fora".
_MARCADOR_CANO = "HANGAR_CANO_KEY"
_CANO_PY = Path(__file__).with_name("cano.py")
# Valores literais, não `subprocess.CREATE_*`: os atributos só existem no Windows (ver atualizar.py).
_FLAGS_WINDOWS = 0x00000200 | 0x08000000   # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

OPCOES_PERMISSAO = ["Permitir", "Negar"]
# 3ª opção só quando a CLI mandou `permission_suggestions` (a regra que a TUI ofereceria como
# "sempre permitir"); a resposta leva as regras em `updatedPermissions` e a CLI grava no settings.
OPCAO_SEMPRE = "Sempre permitir"


class _CanoOcupado(RuntimeError):
    """Cano vivo que não respondeu: há outro cliente nele. Não se mata nem se substitui."""


class _Ligacao:
    """Conexão com o cano — o que o adapter antes chamava de processo. Mesma forma (stdin,
    stdout, pid, returncode, wait) pra o resto do adapter não saber que há um socket no meio."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, pid: int | None):
        self.stdout = reader
        self.stdin = writer
        self.pid = pid
        self.returncode: int | None = None
        self._fim = asyncio.Event()

    def saiu(self, rc: int | None) -> None:
        self.returncode = rc
        self._fim.set()

    async def wait(self) -> int | None:
        await self._fim.wait()
        return self.returncode


class _Sessao:
    def __init__(self, name: str, meta: dict):
        self.name = name
        self.meta = meta
        self.proc: _Ligacao | None = None
        self.leitor: asyncio.Task | None = None
        self.desligando = False    # backend saindo: fecha a conexão, o cano continua
        self.state = "idle"
        self.label: str | None = None
        self.in_progress = False
        self.model: str | None = meta.get("model")
        self.effort: str | None = meta.get("effort")
        self.permission_mode: str | None = meta.get("permission_mode")
        # Último modo que não era `plan`: é pra onde "Implementar o plano" volta.
        self.modo_nao_plan: str | None = meta.get("previous_non_plan")
        self.context_window: int | None = meta.get("context_window")
        self.usage: dict | None = None
        self.cost: float | None = None
        self.limited = False
        self.limit_reset: str | None = None
        # Pedidos de permissão em aberto, na ordem em que chegaram: request_id -> request.
        self.pending: dict[str, dict] = {}
        self.question: dict | None = None      # AskUserQuestion pendente (payload pro front)
        self.previa = ""
        self.version = 0
        self.cond = asyncio.Condition()
        self.waiters: dict[str, asyncio.Future] = {}
        self.n_req = 0
        self.initialized = asyncio.Event()
        # Código + detalhe do último problema (turno com erro, processo caiu, sem resposta):
        # vai pro StateEvent e pro card. Limpa quando um turno fecha bem.
        self.problema: str | None = None
        self.problema_detalhe: str | None = None
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=20)
        self.linhas_ruins = 0
        self.loop: asyncio.AbstractEventLoop | None = None
        self.encerrando = False    # SIGTERM nosso: sair não é "caiu"
        # Janelas de cota da CONTA (⚡5h/📅7d), lidas pelo mesmo leitor da faixa de contas — o
        # stream só diz "allowed" e o reset, não o percentual.
        self.janelas: list = []
        self.janelas_ts = 0.0
        self.drenador: asyncio.Task | None = None   # referência viva do drain de fim de turno
        self.tarefas: dict[str, dict] = {}          # subagentes em voo: task_id -> {tipo, passo}
        self.effort_pendente: str | None = None     # `/effort` pedido com turno em voo: sai no result
        self.effort_aguardando: str | None = None   # `/effort` já no stdin, esperando a CLI confirmar
        self.tipos_desconhecidos: set[str] = set()  # eventos do stdout já avisados (uma nota por tipo)
        self.iniciando = False     # processo novo esperando o `initialize` (hooks de SessionStart)
        # Contadores do turno em voo, pro rótulo "(7s · ↓ 334 tokens · thought for 2s)" da TUI.
        self.turno_inicio: float | None = None
        self.tokens_fechados = 0      # output_tokens das mensagens já fechadas do turno
        self.tokens_msg: int | None = None   # output_tokens real da mensagem em voo (message_delta)
        self.tokens_msg_chars = 0     # caracteres da mensagem em voo, até o real chegar
        self.pensando_desde: float | None = None
        self.pensou_s = 0.0
        # Lista do `/` vinda da própria CLI: nomes+descrição do initialize; os só-de-TUI do init.
        self.comandos: list[dict] | None = None
        self.comandos_terminal: frozenset[str] = frozenset()

    def iniciar_turno(self) -> None:
        self.turno_inicio = time.monotonic()
        self.tokens_fechados = self.tokens_msg_chars = 0
        self.tokens_msg = self.pensando_desde = None
        self.pensou_s = 0.0

    def fechar_mensagem(self) -> None:
        self.tokens_fechados += self._tokens_da_mensagem()
        self.tokens_msg, self.tokens_msg_chars = None, 0

    def _tokens_da_mensagem(self) -> int:
        return self.tokens_msg if self.tokens_msg is not None else self.tokens_msg_chars // 4

    def rotulo_turno(self) -> str | None:
        if self.turno_inicio is None:
            return None
        agora = time.monotonic()
        seg = int(agora - self.turno_inicio)
        partes = [f"{seg // 60}m {seg % 60}s" if seg >= 60 else f"{seg}s"]
        tokens = self.tokens_fechados + self._tokens_da_mensagem()
        if tokens:
            partes.append(f"↓ {tokens / 1000:.1f}k tokens" if tokens >= 1000 else f"↓ {tokens} tokens")
        pensou = self.pensou_s + (agora - self.pensando_desde if self.pensando_desde is not None else 0)
        if pensou >= 1:
            partes.append(f"thought for {int(pensou)}s")
        return f"({' · '.join(partes)})"

    @property
    def sid(self) -> str:
        return self.meta["session_id"]

    @property
    def vivo(self) -> bool:
        return self.proc is not None and self.proc.returncode is None


class ClaudeHeadlessAdapter:
    provider = "claude"

    def __init__(self) -> None:
        self._sessions: dict[str, _Sessao] = {}
        self._delivery_locks: dict[str, asyncio.Lock] = {}
        # Problema da última vida do processo, por nome: a sessão sai de `_sessions` quando o
        # processo morre, e o card/chat ainda precisam dizer por quê.
        self._problemas: dict[str, tuple[str, str | None]] = {}
        self._spawn_locks: dict[str, asyncio.Lock] = {}
        self._tarefas: set[asyncio.Task] = set()
        self._religadas: dict[str, float] = {}

    # ── contrato Adapter ────────────────────────────────────────────────────────────────────

    def transcript_stream(self, path: str, start_offset: int | None = None) -> AsyncIterator[ChatEvent]:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        return TranscriptTailer(path).follow(start_offset)

    def state_monitor(self, name: str, sid_get: Callable[[], str]) -> AsyncIterator[StateEvent]:
        return self._state_stream(name)

    def spawn_command(self, cwd: str, session_id: str,
                      model: str | None = None, effort: str | None = None,
                      permission_mode: str | None = None) -> list[str]:
        return self._argv(session_id, resume=False, model=model, effort=effort, permission_mode=permission_mode)

    def transcript_path(self, cwd: str, session_id: str, config_dir: str | None = None) -> str:
        base = (Path(config_dir) / "projects") if config_dir else Path(settings.projects_dir)
        return str(base / _SANITIZE_RE.sub("-", cwd) / f"{session_id}.jsonl")

    def transcript_path_de(self, meta: dict) -> str:
        return self.transcript_path(meta["cwd"], meta["session_id"], meta.get("config_dir"))

    def delivery_lock(self, name: str) -> asyncio.Lock:
        return self._delivery_locks.setdefault(name, asyncio.Lock())

    async def deliverable(self, name: str) -> bool:
        # Parada ou subindo: o prompt vai pra fila e a resposta HTTP sai na hora. Quem sobe é o
        # `acordar`, e quem entrega é o fim do `initialize` — nunca o POST esperando os hooks.
        sess = self._sessions.get(name)
        if sess is None:
            return False
        return not (sess.iniciando or sess.in_progress or sess.pending or sess.question)

    def acordar(self, name: str) -> None:
        """Sobe (ou religa) a sessão em segundo plano e entrega a fila quando ela estiver pronta."""
        sess = self._sessions.get(name)
        if sess is not None and sess.vivo:
            return
        t = asyncio.get_running_loop().create_task(self._acordar(name))
        self._tarefas.add(t)
        t.add_done_callback(self._tarefas.discard)

    async def _acordar(self, name: str) -> None:
        try:
            sess = await self.ensure_running(name, esperar_pronta=False)
        except Exception:
            return   # ensure_running já registrou o problema que a tela mostra
        if sess is not None and not sess.iniciando:
            # Religou num cano vivo (sem initialize a esperar): ninguém mais drenaria a fila.
            await self._drenar_fim_de_turno(sess)

    async def send_prompt(self, name: str, text: str) -> str:
        sess = await self.ensure_running(name, esperar_pronta=False)
        if sess is None or not await self.deliverable(name):
            return "deferred"
        try:
            await self._escrever_prompt(sess, text)
        except Exception:
            _log.exception("claude headless: escrita no stdin falhou name=%s", name)
            return "deferred"
        sess.in_progress = True
        sess.state = "working"
        sess.label = None
        sess.iniciar_turno()
        await self._notify(sess)
        return "sent"

    async def _escrever_prompt(self, sess: _Sessao, text: str) -> None:
        blocos, avisos = await asyncio.to_thread(_blocos_do_prompt, text)
        await self._write(sess, {
            "type": "user", "session_id": "", "parent_tool_use_id": None,
            "message": {"role": "user", "content": blocos},
        })
        for aviso in avisos:
            await self._nota_local(sess, aviso)

    async def drain(self, name: str, path: str) -> int:
        async with self.delivery_lock(name):
            q = PromptQueue(name)
            if not any(e.get("delivered") is False for e in await asyncio.to_thread(q.load)):
                return 0
            sent = 0
            while True:
                claimed = await asyncio.to_thread(q.claim_undelivered, limit=1)
                if not claimed:
                    return sent
                entry = claimed[0]
                try:
                    result = await self.send_prompt(name, entry["text"])
                except Exception:
                    _log.exception("claude headless drain: falha entry=%s name=%s", entry.get("id"), name)
                    result = "deferred"
                if result != "sent":
                    # claim_undelivered marcou entregue de forma otimista; nada saiu, reverte.
                    try:
                        await asyncio.to_thread(q.set_delivered, entry["id"], False)
                    except OSError:
                        pass
                    return sent
                sent += 1

    async def steer(self, name: str, text: str) -> None:
        """Mensagem no MEIO do turno: a CLI aceita `user` com turno em voo e injeta no próximo
        passo (medido no MonoCode e na sonda). Sem turno em voo é um envio comum. Sob a mesma
        trava de entrega do /input e do drain — todo escritor do stdin passa por ela."""
        async with self.delivery_lock(name):
            sess = await self.ensure_running(name)
            if sess is None:
                raise RuntimeError("sessão indisponível")
            await self._steer_vivo(sess, text)

    async def _steer_vivo(self, sess: _Sessao, text: str) -> None:
        # Só no processo que está aí: subir outro "pra orientar" seria começar outra conversa.
        if not sess.vivo:
            raise RuntimeError("o processo encerrou antes de receber a mensagem")
        await self._escrever_prompt(sess, text)
        if not sess.in_progress:
            sess.in_progress = True
            sess.state = "working"
            await self._notify(sess)

    async def steer_queue(self, name: str, *, entry_id: str | None = None) -> list[str]:
        """Promove a fila durável pro turno em curso (o "mandar agora" do chip). Devolve os ids
        entregues. Sem turno em voo não há o que promover: o drain normal entrega."""
        async with self.delivery_lock(name):
            sess = self._sessions.get(name)
            if sess is None or not sess.vivo or not sess.in_progress:
                raise RuntimeError("Não há turno em andamento para orientar")
            if sess.pending or sess.question:
                # Parada numa permissão/pergunta a CLI não lê o stdin de mensagens: a fila iria
                # sumir da tela e ficar invisível até alguém responder. Melhor dizer.
                raise RuntimeError("Responda a permissão ou pergunta pendente antes de orientar")
            q = PromptQueue(name)
            sent: list[str] = []
            while claimed := await asyncio.to_thread(q.claim_undelivered, limit=1, entry_id=entry_id):
                entry = claimed[0]
                try:
                    await self._steer_vivo(sess, entry["text"])
                except BaseException:
                    await asyncio.to_thread(q.set_delivered, entry["id"], False)
                    raise
                sent.append(entry["id"])
                try:
                    await asyncio.to_thread(q.set_delivered, entry["id"], True, steered=True)
                except OSError:
                    _log.exception("claude headless: orientação aceita, recibo falhou name=%s entry=%s", name, entry["id"])
                    return sent
            return sent

    # ── controles ───────────────────────────────────────────────────────────────────────────

    async def interrupt(self, name: str) -> bool:
        sess = self._sessions.get(name)
        if sess is None or not sess.vivo or not (sess.in_progress or sess.pending or sess.question):
            return False
        # Pedido pendente some junto com o turno: negar antes evita a tool rodar depois do Esc.
        for rid in list(sess.pending):
            await self._responder(sess, rid, {"behavior": "deny", "message": "Interrompido pelo usuário."})
        sess.pending.clear()   # já respondido: um cancel da CLI depois disto não é "decisão de hook"
        if sess.question:
            await self._responder(sess, sess.question["request_id"],
                                  {"behavior": "deny", "message": "Interrompido pelo usuário."})
            sess.question = None
        try:
            await self._ctrl(sess, "interrupt", esperar=False)
        except Exception:
            _log.exception("claude headless: interrupt falhou name=%s", name)
            return False
        return True

    async def select(self, name: str, option: int) -> bool:
        """Resposta ao pedido de permissão em aberto: 1 = permitir, 2 = negar."""
        sess = self._sessions.get(name)
        if sess is None or not sess.pending:
            return False
        rid, req = next(iter(sess.pending.items()))
        sugestoes = _sugestoes_de(req)
        if option == 1:
            resposta = {"behavior": "allow", "updatedInput": req.get("input") or {}}
        elif option == 3 and sugestoes:
            resposta = {"behavior": "allow", "updatedInput": req.get("input") or {},
                        "updatedPermissions": sugestoes}
        else:
            resposta = {"behavior": "deny", "message": "Usuário recusou."}
        await self._responder(sess, rid, resposta)
        sess.pending.pop(rid, None)
        self._recalcular_estado(sess)
        await self._notify(sess)
        return True

    async def answer_questions(self, name: str, request_id: int | str | None, answers: list[dict]) -> None:
        sess = self._sessions.get(name)
        if sess is None or not sess.question:
            raise ValueError("nenhuma pergunta pendente")
        q = sess.question
        if request_id is not None and str(request_id) != str(q["request_id"]):
            raise ValueError("a pergunta mudou")
        perguntas = q["questions"]
        respostas: dict[str, str] = {}
        for i, item in enumerate(perguntas):
            a = answers[i] if i < len(answers) else None
            if not a:
                raise ValueError("responda a todas as perguntas")
            if a.get("kind") == "text":
                texto = (a.get("value") or "").strip()
            else:
                opcoes = item.get("options") or []
                idx = a.get("indices") or []
                rotulos = a.get("labels") or [opcoes[j]["label"] for j in idx if 0 <= j < len(opcoes)]
                texto = ", ".join(rotulos)
            if not texto:
                raise ValueError("responda a todas as perguntas")
            respostas[item["question"]] = texto
        await self._responder(sess, q["request_id"], {
            "behavior": "allow",
            "updatedInput": {"questions": perguntas, "answers": respostas},
        })
        sess.question = None
        self._recalcular_estado(sess)
        await self._notify(sess)

    async def set_permission_mode(self, name: str, mode: str) -> str:
        sess = await self.ensure_running(name)
        if sess is None:
            raise ValueError("sessão indisponível")
        r = await self._ctrl(sess, "set_permission_mode", mode=mode)
        self._definir_modo(sess, (r or {}).get("mode") or mode)
        hl_sessions.update(name, permission_mode=sess.permission_mode)
        await self._notify(sess)
        return sess.permission_mode

    @staticmethod
    def _definir_modo(sess: _Sessao, modo: str) -> None:
        sess.permission_mode = _modo_do_app(modo)
        if sess.permission_mode != "plan" and sess.permission_mode != sess.modo_nao_plan:
            sess.modo_nao_plan = sess.permission_mode
            hl_sessions.update(sess.name, previous_non_plan=sess.modo_nao_plan)

    async def set_model(self, name: str, model: str | None, effort: str | None) -> bool:
        """Troca modelo em voo (`set_model`). Esforço vai como o comando local `/effort <x>` pelo
        stdin — medido: a CLI responde "Set effort level to <x> (this session only)" sem chamar a
        API, igual à TUI. Com turno em voo fica guardado e sai no `result`.
        Devolve se o esforço já vale (False = vai valer no fim do turno)."""
        sess = await self.ensure_running(name)
        if sess is None:
            raise ValueError("sessão indisponível")
        if model:
            await self._ctrl(sess, "set_model", model=model)
            sess.model = model
        esforco_ja_vale = True
        if effort and effort != sess.effort:
            # `sess.effort` só muda quando a CLI confirmar (ver `_confirmar_effort`).
            if await self.deliverable(name):
                await self._comando_local(sess, f"/effort {effort}")
            else:
                sess.effort_pendente = effort
                esforco_ja_vale = False
        hl_sessions.update(name, model=sess.model)
        await self._notify(sess)
        return esforco_ja_vale

    def _confirmar_effort(self, sess: _Sessao, texto: str) -> None:
        """Resposta do `/effort`: "Set effort level to X" confirma; qualquer outra coisa (Usage…)
        é recusa — o valor não muda e o problema aparece, em vez de um status line mentindo."""
        pedido, sess.effort_aguardando = sess.effort_aguardando, None
        if pedido is None:
            return
        if texto.startswith("Set effort level to"):
            sess.effort = pedido
            hl_sessions.update(sess.name, effort=pedido)
        else:
            self._registrar_problema(sess, "headless_turno_erro", f"esforço {pedido!r} não aceito: {texto[:200]}")

    async def _comando_local(self, sess: _Sessao, texto: str) -> None:
        """Comando local da CLI (`/effort`, `/compact`…) direto no stdin, fora da fila: a
        resposta volta como `assistant` + `result` sem chamada à API, e vira nota no chat.
        Sob a trava de entrega, como todo escritor do stdin."""
        async with self.delivery_lock(sess.name):
            if texto.startswith("/effort "):
                sess.effort_aguardando = texto.split(" ", 1)[1].strip()
            await self._write(sess, {
                "type": "user", "session_id": "", "parent_tool_use_id": None,
                "message": {"role": "user", "content": [{"type": "text", "text": texto}]},
            })
            sess.in_progress = True
            sess.state = "working"

    async def list_models(self, name: str) -> list[dict]:
        sess = await self.ensure_running(name)
        if sess is None:
            return []
        r = await self._ctrl(sess, "list_models")
        return list((r or {}).get("models") or [])

    async def _reabrir(self, sess: _Sessao) -> None:
        """Mata o processo e sobe outro com `--resume` (mesma conversa, flags novas)."""
        self._matar(sess)
        if self._sessions.get(sess.name) is sess:
            self._sessions.pop(sess.name, None)
        if sess.leitor is not None:
            try:
                await asyncio.wait_for(sess.leitor, 5)
            except (asyncio.TimeoutError, Exception):
                pass
        await self.ensure_running(sess.name)

    # ── processo ────────────────────────────────────────────────────────────────────────────
    # O `claude` não é filho do backend: é filho do CANO (cano.py), um processo por sessão que
    # segura stdin/stdout e escuta num socket local. O backend conecta, e reconecta quando volta
    # de um restart — o processo, o turno em voo e a permissão pendente sobrevivem. Ver o
    # snapshot em cano.py e a decisão em docs/decisoes/harnesses.md.

    async def ensure_running(self, name: str, *, so_reconectar: bool = False,
                             esperar_pronta: bool = True) -> _Sessao | None:
        sess = await self._ligar(name, so_reconectar=so_reconectar)
        if sess is not None and esperar_pronta and sess.iniciando:
            # Controles (set_model, modo, lista de modelos) só valem depois do `initialize`.
            await asyncio.wait_for(sess.initialized.wait(), _TETO_INIT_S + 5)
        return sess

    async def _ligar(self, name: str, *, so_reconectar: bool = False) -> _Sessao | None:
        # Um spawn por nome de cada vez: prompt e troca de modelo chegando juntos numa sessão
        # parada subiriam dois `claude` no mesmo .jsonl.
        async with self._spawn_locks.setdefault(name, asyncio.Lock()):
            sess = self._sessions.get(name)
            if sess is not None and sess.vivo:
                return sess
            meta = hl_sessions.load(name)
            if meta is None:
                return None
            if so_reconectar and not meta.get("cano"):
                return None
            sess = _Sessao(name, meta)
            sess.loop = asyncio.get_running_loop()
            self._sessions[name] = sess
            try:
                if not await self._spawn(sess, so_reconectar=so_reconectar):
                    self._sessions.pop(name, None)
                    return None
            except Exception as e:
                _log.exception("claude headless: não subiu name=%s", name)
                if self._sessions.get(name) is sess:
                    self._sessions.pop(name, None)
                if not isinstance(e, _CanoOcupado):
                    # Ocupado é passageiro (a religada resolve): gravar o problema o deixaria na
                    # lista depois de a sessão voltar.
                    self._matar(sess)
                    self._problemas[name] = ("headless_nao_subiu", str(e)[:300])
                raise
            return sess

    async def reconectar_todas(self) -> int:
        """Na subida do backend: religa em todo cano que ficou vivo (sidecar com `cano`). Sem
        isto a lista mostraria "ociosa" uma sessão parada numa permissão."""
        n = 0
        for meta in hl_sessions.list_all():
            if not meta.get("cano"):
                continue
            try:
                if await self.ensure_running(meta["name"], so_reconectar=True):
                    n += 1
            except Exception:
                _log.warning("claude headless: reconexão falhou name=%s", meta["name"], exc_info=True)
        return n

    def _agendar_religar(self, name: str) -> None:
        # ponytail: uma religada por nome a cada 10s; dois backends vivos no mesmo HOME ficariam
        # tomando a conexão um do outro — o teto só impede que isso vire laço apertado.
        agora = time.monotonic()
        if agora - self._religadas.get(name, 0.0) < 10:
            return
        self._religadas[name] = agora

        async def _religar() -> None:
            await asyncio.sleep(1.0)
            try:
                await self.ensure_running(name, so_reconectar=True)
            except Exception:
                _log.warning("claude headless: religar falhou name=%s", name, exc_info=True)
        t = asyncio.get_running_loop().create_task(_religar())
        self._tarefas.add(t)
        t.add_done_callback(self._tarefas.discard)

    def desligar_todas(self) -> None:
        """Backend saindo: fecha as conexões e deixa os canos vivos pro próximo backend."""
        for sess in list(self._sessions.values()):
            sess.desligando = True
            if sess.proc is not None:
                try:
                    sess.proc.stdin.close()
                except Exception:
                    pass

    @staticmethod
    def _matar(sess: _Sessao, meta: dict | None = None) -> None:
        """Mata o cano (e com ele o claude, mesmo grupo de processos). Idempotente; o leitor vê
        o EOF e fecha o resto. `meta` serve quando a sessão nem chegou a conectar."""
        # As duas fontes: o meta passado (sidecar já apagado) pode não ter `cano`; o da memória tem.
        cano = ((meta or {}).get("cano")) or ((sess.meta or {}).get("cano")) or {}
        pid = cano.get("pid")
        if pid is None:
            return      # nunca ligou num cano: não há o que matar
        sess.encerrando = True
        _matar_grupo(int(pid), sess.name)

    def _argv(self, sid: str, *, resume: bool, model=None, effort=None, permission_mode=None) -> list[str]:
        base = ["claude", "-p", "--output-format", "stream-json", "--input-format", "stream-json",
                "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio",
                "--setting-sources", "user,project,local"]
        base += ["--resume", sid] if resume else ["--session-id", sid]
        # A CLI nasce no `permissions.defaultMode` do settings.json da conta, não num padrão dela;
        # passar o modo explícito é o que faz a sessão nascer no modo que o Hangar mostra.
        return base + model_args.args_de("claude", model, effort, permission_mode)

    async def _spawn(self, sess: _Sessao, *, so_reconectar: bool = False) -> bool:
        """Liga a sessão a um cano: o que já existe (sidecar com `cano`), ou um novo. Devolve
        False só em `so_reconectar` sem cano vivo."""
        meta = sess.meta
        cano = meta.get("cano")
        if cano:
            ligado = await self._conectar(cano)
            if ligado is not None:
                lig, snap = ligado
                sess.proc = lig
                sess.leitor = asyncio.create_task(self._ler(sess))
                await self._aplicar_snapshot(sess, snap)
                _log.info("claude headless: religou name=%s pid=%s aberto=%s pendentes=%d",
                          sess.name, snap.get("pid"), snap.get("aberto"), len(snap.get("pendentes") or []))
                if (snap.get("versao") != cano_mod.VERSAO and not snap.get("aberto")
                        and not snap.get("pendentes") and snap.get("saiu") is None):
                    # Cano de outra versão e sessão ociosa: troca agora, que não custa nada.
                    _log.info("claude headless: cano versão %s != %s, reabrindo name=%s",
                              snap.get("versao"), cano_mod.VERSAO, sess.name)
                    await self._reabrir(sess)
                self._agendar_cota(sess)
                return True
            # Sem snapshot com o cano vivo: outro cliente está preso nele (cano antigo atende em
            # série). Matar derrubaria um claude saudável; subir outro poria dois no mesmo .jsonl.
            if cano.get("pid") is not None and pid_vivo(int(cano["pid"])):
                raise _CanoOcupado("o processo da sessão está ocupado por outra conexão; tente de novo")
            _esquecer_cano(sess.name, cano.get("pid"))
            meta = sess.meta = hl_sessions.load(sess.name) or {**meta, "cano": None}
        if so_reconectar:
            return False
        await self._subir_cano(sess)
        return True

    async def _subir_cano(self, sess: _Sessao) -> None:
        meta = sess.meta
        transcript = self.transcript_path_de(meta)
        resume = Path(transcript).exists()
        # Modo de permissão TAMBÉM no --resume: sem a flag a CLI volta ao defaultMode da conta
        # (medido: sessão "manual" reaberta após restart rodou Bash sem perguntar).
        argv = self._argv(sess.sid, resume=resume, model=sess.model, effort=sess.effort,
                          permission_mode=sess.permission_mode)
        if meta.get("engine"):
            pre = ["hangar-engine", "--exec", meta["engine"]]
            if sess.model:
                pre += ["--model", sess.model]
                if sess.context_window:
                    pre += ["--context", str(sess.context_window)]
            argv = pre + ["--"] + argv
        env = dict(os.environ)
        # Backend subido de dentro de um tmux (dev) passaria o pane do OPERADOR pro processo, e
        # o hangar-send de dentro da sessão se identificaria como a sessão dele.
        env.pop("TMUX", None)
        env.pop("TMUX_PANE", None)
        env["CP_SESSION_NAME"] = sess.name
        if not meta.get("key"):
            meta = sess.meta = hl_sessions.update(sess.name, key=uuid.uuid4().hex) or meta
        if meta.get("key"):
            env["CP_SESSION_KEY"] = meta["key"]
        env[_MARCADOR_CANO] = meta["key"]
        if meta.get("config_dir"):
            env["CLAUDE_CONFIG_DIR"] = meta["config_dir"]
        if shutil.which(argv[0]) is None:
            raise RuntimeError(f"binário não encontrado: {argv[0]}")
        escuta, token = _escuta_nova(meta["key"])
        log = hl_sessions._dir() / f"cano-{meta['key'][:16]}.log"
        cmd = [sys.executable, str(_CANO_PY), "--escuta", escuta, "--log", str(log), "--cwd", meta["cwd"]]
        if token:
            cmd += ["--token", token]
        cmd += ["--", *argv]
        extra: dict = {}
        if os.name == "nt":
            extra["creationflags"] = _FLAGS_WINDOWS
        else:
            extra["start_new_session"] = True
            # Escopo transiente do systemd: fora do cgroup do serviço, senão o `systemctl restart`
            # mata o cano junto (mesmo motivo do tmux._scope_prefix).
            from app import tmux
            cmd = tmux._scope_prefix() + cmd
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=meta["cwd"], env=env,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            **extra)
        ceifador = asyncio.create_task(proc.wait())      # só pra não deixar zumbi
        self._tarefas.add(ceifador)
        ceifador.add_done_callback(self._tarefas.discard)
        cano = {"pid": proc.pid, "escuta": escuta, "token": token}
        sess.meta = hl_sessions.update(sess.name, cano=cano) or {**meta, "cano": cano}
        ligado = await self._conectar(cano, esperar=_TETO_CANO_S)
        if ligado is None:
            cauda = _cauda(log)
            _matar_grupo(proc.pid, sess.name)
            hl_sessions.update(sess.name, cano=None)
            raise RuntimeError(f"cano não escutou em {_TETO_CANO_S:.0f}s: {cauda}")
        sess.proc, snap = ligado
        sess.leitor = asyncio.create_task(self._ler(sess))
        for linha in snap.get("stderr_tail") or []:
            sess.stderr_tail.append(linha)
        _log.info("claude headless: subiu name=%s cano=%s claude=%s resume=%s", sess.name, proc.pid, sess.proc.pid, resume)
        sess.iniciando = True
        sess.iniciar_turno()      # relógio do "Iniciando sessão… (Ns)"
        t = asyncio.create_task(self._esperar_initialize(sess))
        self._tarefas.add(t)
        t.add_done_callback(self._tarefas.discard)

    async def _esperar_initialize(self, sess: _Sessao) -> None:
        pedido = asyncio.ensure_future(self._ctrl(sess, "initialize"))
        try:
            feito, _ = await asyncio.wait({pedido}, timeout=_AVISO_INIT_S)
            if not feito:
                # Normalmente é a CLI parada numa pergunta que só o terminal responderia (confiança
                # na pasta, login). A espera continua: hook lento responde e limpa o problema.
                _log.warning("claude headless: initialize sem resposta em %.0fs name=%s", _AVISO_INIT_S, sess.name)
                self._registrar_problema(sess, "headless_sem_resposta", "\n".join(sess.stderr_tail) or None)
                await self._notify(sess)
            resposta = await pedido
            validos = [c for c in (resposta or {}).get("commands") or [] if isinstance(c, dict) and isinstance(c.get("name"), str)]
            if validos:
                sess.comandos = validos
            else:
                _log.warning("claude headless: initialize sem lista de comandos name=%s; / usa a sonda ou a lista fixa", sess.name)
        except asyncio.TimeoutError:
            _log.warning("claude headless: initialize desistiu em %.0fs name=%s", _TETO_INIT_S, sess.name)
        except RuntimeError as e:
            _log.warning("claude headless: initialize falhou name=%s: %s", sess.name, e)
            if sess.vivo:
                # Vivo = a CLI recusou o initialize. Morto = o leitor já registrou a queda.
                self._registrar_problema(sess, "headless_nao_subiu", str(e)[:300])
        except Exception:
            _log.exception("claude headless: initialize quebrou name=%s", sess.name)
            self._registrar_problema(sess, "headless_nao_subiu", "falha interna ao iniciar a sessão")
        else:
            if sess.problema == "headless_sem_resposta":
                self._limpar_problema(sess)
        finally:
            sess.iniciando = False
            if not sess.in_progress:
                sess.turno_inicio = None
            sess.initialized.set()
        await self._notify(sess)
        self._agendar_cota(sess)
        # O que chegou enquanto subia está na fila: sai agora, na ordem.
        await self._drenar_fim_de_turno(sess)

    async def _conectar(self, cano: dict, *, esperar: float = 0.0) -> tuple[_Ligacao, dict] | None:
        """Abre a conexão com o cano e lê o snapshot. None = não há cano escutando ali (morto, ou
        ainda subindo além de `esperar` segundos)."""
        escuta, token = cano.get("escuta") or "", cano.get("token")
        fim = time.monotonic() + esperar
        while True:
            try:
                # limit: o `control_response` do initialize passa de 100 KB numa linha só; o teto
                # padrão do asyncio (64 KB) estourava a leitura e o leitor ficava pendurado.
                if escuta.startswith("unix:"):
                    reader, writer = await asyncio.wait_for(
                        asyncio.open_unix_connection(escuta[5:], limit=_LIMITE_LINHA), 3)
                elif escuta.startswith("tcp:"):
                    host, porta = escuta[4:].rsplit(":", 1)
                    reader, writer = await asyncio.wait_for(
                        asyncio.open_connection(host, int(porta), limit=_LIMITE_LINHA), 3)
                else:
                    return None
                break
            except (OSError, asyncio.TimeoutError):
                if time.monotonic() >= fim:
                    return None
                await asyncio.sleep(0.1)
        try:
            if token:
                writer.write((token + "\n").encode())
                await writer.drain()
            linha = await asyncio.wait_for(reader.readline(), 5)
            snap = json.loads(linha)
            if not isinstance(snap, dict) or snap.get("type") != "cano_snapshot":
                raise ValueError("primeira linha não é snapshot")
        except (OSError, ValueError, asyncio.TimeoutError):
            _log.warning("claude headless: cano em %s não deu snapshot", escuta, exc_info=True)
            writer.close()
            return None
        return _Ligacao(reader, writer, snap.get("pid")), snap

    async def _aplicar_snapshot(self, sess: _Sessao, snap: dict) -> None:
        # O que estava em aberto quando o backend anterior saiu — na ordem em que aconteceu.
        for linha in snap.get("stderr_tail") or []:
            sess.stderr_tail.append(linha)
        for chave in ("init", "ultimo_result", "rate_limit"):
            bruto = snap.get(chave)
            if not bruto:
                continue
            try:
                ev = json.loads(bruto)
            except ValueError:
                continue
            if chave == "ultimo_result":
                self._aplicar_uso(sess, ev)
            else:
                await self._on_event(sess, ev)
        if sess.usage is None:
            # O snapshot só guarda o `result`, que não diz o contexto: a última chamada está no .jsonl.
            try:
                uso = await asyncio.to_thread(_uso_da_ultima_chamada, self.transcript_path_de(sess.meta))
            except Exception:
                # Contexto é contabilidade: falhar aqui não pode virar "a sessão não subiu".
                _log.warning("claude headless: contexto do transcript ilegível name=%s", sess.name, exc_info=True)
                uso = None
            _aplicar_uso_da_chamada(sess, uso)
        sess.initialized.set()
        if snap.get("aberto"):
            sess.in_progress = True
        for bruto in snap.get("pendentes") or []:
            try:
                await self._on_control_request(sess, json.loads(bruto))
            except ValueError:
                continue
        self._recalcular_estado(sess)
        await self._notify(sess)

    async def _ler(self, sess: _Sessao) -> None:
        assert sess.proc and sess.proc.stdout
        try:
            while True:
                try:
                    linha = await sess.proc.stdout.readline()
                except (OSError, ValueError, asyncio.IncompleteReadError) as e:
                    # Conexão quebrou (ou linha acima do teto): sem tratar, o leitor morria com a
                    # exceção e o `wait()` do finally esperava pra sempre — sessão presa em working.
                    _log.warning("claude headless: leitura do cano falhou name=%s: %s", sess.name, e)
                    linha = b""
                if not linha:
                    # EOF sem `cano_saiu`: fomos nós (desligando/encerrando) ou o cano sumiu.
                    sess.proc.saiu(None if (sess.desligando or sess.encerrando) else -1)
                    break
                try:
                    ev = json.loads(linha)
                except ValueError:
                    sess.linhas_ruins += 1
                    if sess.linhas_ruins <= 3:
                        _log.warning("claude headless: linha não-JSON no stdout name=%s: %r", sess.name, linha[:200])
                    continue
                t = ev.get("type")
                if t == "cano_stderr":
                    sess.stderr_tail.append(str(ev.get("linha") or ""))
                    continue
                if t == "cano_saiu":
                    for l in ev.get("stderr_tail") or []:
                        if l not in sess.stderr_tail:
                            sess.stderr_tail.append(l)
                    sess.proc.saiu(ev.get("rc"))
                    break
                try:
                    await self._on_event(sess, ev)
                except Exception:
                    _log.exception("claude headless: evento mal digerido name=%s tipo=%s", sess.name, ev.get("type"))
        finally:
            rc = await sess.proc.wait() if sess.proc else None
            try:
                sess.proc.stdin.close()
            except Exception:
                pass
            cano_pid = ((sess.meta or {}).get("cano") or {}).get("pid")
            perdeu_conexao = (rc == -1 and not sess.encerrando and cano_pid is not None
                              and pid_vivo(int(cano_pid)))
            if sess.desligando:
                _log.info("claude headless: desligou name=%s (cano segue vivo)", sess.name)
            elif perdeu_conexao:
                # Outro cliente tomou a conexão (o cano troca de cliente); o claude segue vivo lá.
                # Esquecer o cano aqui deixava-o órfão e o próximo prompt subia um segundo claude.
                _log.warning("claude headless: conexão com o cano perdida, cano vivo name=%s pid=%s; religando",
                             sess.name, cano_pid)
                rc = None
                self._agendar_religar(sess.name)
            else:
                _log.info("claude headless: processo saiu name=%s rc=%s", sess.name, rc)
                # Processo foi embora: o próximo prompt sobe outro cano, não tenta este.
                _esquecer_cano(sess.name, ((sess.meta or {}).get("cano") or {}).get("pid"))
            # A CLI apanha o SIGTERM e sai com 143 (128+15), não com -15 — só o nosso encerramento
            # marca `encerrando`; qualquer outra saída não-zero é queda (-1 = o cano sumiu).
            caiu = not sess.encerrando and not sess.desligando and rc not in (0, None, -signal.SIGTERM, -getattr(signal, "SIGKILL", signal.SIGTERM))
            if caiu:
                self._registrar_problema(sess, "headless_processo_caiu",
                                         f"rc={rc}\n" + "\n".join(sess.stderr_tail))
            for fut in sess.waiters.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("processo encerrou"))
            sess.waiters.clear()
            sess.in_progress = False
            sess.pending.clear()
            sess.question = None
            # Queda vira marcador `dead` (push de "caiu", como no tmux); saída nossa com espera
            # em aberto só desfaz o `awaiting_input` que o adapter gravou.
            if caiu:
                self._gravar_marcador(sess, "dead")
            elif sess.state == "awaiting_input":
                self._gravar_marcador(sess, "idle")
            sess.state = "dead"
            await PushPreviewSource.get(sess.name).push("")
            await self._notify(sess)

    async def _write(self, sess: _Sessao, obj: dict) -> None:
        if not sess.vivo or sess.proc is None or sess.proc.stdin is None:
            raise RuntimeError("processo não está vivo")
        sess.proc.stdin.write((json.dumps(obj) + "\n").encode())
        await sess.proc.stdin.drain()

    async def _ctrl(self, sess: _Sessao, subtype: str, *, esperar: bool = True, **req) -> dict | None:
        sess.n_req += 1
        rid = f"hangar_{sess.n_req}"
        fut: asyncio.Future | None = None
        if esperar:
            fut = asyncio.get_running_loop().create_future()
            sess.waiters[rid] = fut
        try:
            await self._write(sess, {"type": "control_request", "request_id": rid,
                                     "request": {"subtype": subtype, **req}})
            if fut is None:
                return None
            return await asyncio.wait_for(fut, _TETO_CTRL_S if subtype != "initialize" else _TETO_INIT_S)
        finally:
            sess.waiters.pop(rid, None)

    async def _responder(self, sess: _Sessao, rid: str, resposta: dict) -> None:
        await self._write(sess, {"type": "control_response",
                                 "response": {"subtype": "success", "request_id": rid, "response": resposta}})

    # ── eventos do stdout ──────────────────────────────────────────────────────────────────

    async def _on_event(self, sess: _Sessao, ev: dict) -> None:
        t = ev.get("type")
        if ev.get("parent_tool_use_id") and not str(t).startswith("control_"):
            # Conversa de subagente: fica fora do rótulo e da prévia do principal (o transcript
            # dele mora em subagents/agent-*.jsonl; o que ele faz agora vem por task_progress).
            # Vale pra qualquer tipo: um `result` de filho fechando o turno do pai seria pior.
            return
        if t == "control_response":
            r = ev.get("response") or {}
            fut = sess.waiters.get(r.get("request_id"))
            if fut is not None and not fut.done():
                if r.get("subtype") == "error":
                    fut.set_exception(RuntimeError(r.get("error") or "control_request recusado"))
                else:
                    fut.set_result(r.get("response") or {})
            return
        if t == "system":
            await self._on_system(sess, ev)
            return
        if t == "stream_event":
            await self._on_stream(sess, ev.get("event") or {})
            return
        if t == "assistant":
            blocos = (ev.get("message") or {}).get("content") or []
            if ev.get("local_command_source") is not None:
                # Saída de comando local (/context, /cost…): a CLI responde no stdout e NÃO grava
                # no .jsonl — no terminal ela aparece na tela; aqui, sem tela, vai pra fila
                # durável como bolha do assistente (histórico, reload e SSE já sabem lê-la).
                texto = "\n".join(b.get("text", "") for b in blocos
                                  if isinstance(b, dict) and b.get("type") == "text").strip()
                if sess.effort_aguardando is not None:
                    self._confirmar_effort(sess, texto)
                if texto:
                    await self._nota_local(sess, texto)
                return
            _aplicar_uso_da_chamada(sess, (ev.get("message") or {}).get("usage"))
            tools = [b.get("name") for b in blocos if isinstance(b, dict) and b.get("type") == "tool_use"]
            if tools:
                sess.label = f"{tools[-1]}…"
            if any(isinstance(b, dict) and b.get("type") == "text" for b in blocos):
                # O bloco fechou: o .jsonl já tem a mensagem, a prévia sai de cena.
                sess.previa = ""
                await PushPreviewSource.get(sess.name).push("")
            await self._notify(sess)
            return
        if t == "user":
            sess.label = None
            await self._notify(sess)
            return
        if t in ("control_request", "sdk_control_request"):
            await self._on_control_request(sess, ev)
            return
        if t == "control_cancel_request":
            rid = str(ev.get("request_id"))
            req = sess.pending.pop(rid, None)
            nota = None
            if req is not None:
                nota = f"⚙️ {self._permissao_texto(req)} — decidido por hook, sem você"
            elif sess.question and str(sess.question["request_id"]) == rid:
                perguntas = sess.question.get("questions") or []
                primeira = (perguntas[0].get("question") if perguntas and isinstance(perguntas[0], dict) else "") or ""
                nota = f"⚙️ Pergunta cancelada antes da resposta: {primeira[:120]}".rstrip(": ")
                sess.question = None
            self._recalcular_estado(sess)
            await self._notify(sess)
            if nota:
                # Alguém decidiu antes do usuário (hook PermissionRequest, ou a CLI desistiu):
                # no terminal isso aparece como uma linha; aqui a pergunta sumiria calada.
                await self._nota_local(sess, nota)
            return
        if t == "result":
            sess.in_progress = False
            sess.turno_inicio = None
            sess.pending.clear()
            sess.question = None
            sess.label = None
            sess.tarefas.clear()
            sess.previa = ""
            sub = ev.get("subtype") or ""
            if ev.get("local_command"):
                # Comando local não vira linha `user` no .jsonl (só `<command-name>`, às vezes com
                # outro nome: /cost grava /usage), então o reconcile nunca o acharia e o
                # redigitaria até desistir — medido: /context executado 3 vezes. A CLI já o
                # consumiu; a entrada está confirmada. Só a de slash: um prompt comum entregue
                # há pouco continua com o reconcile normal (confirmado só quando cair no .jsonl).
                await asyncio.to_thread(PromptQueue(sess.name).confirm_delivered,
                                        lambda r: str(r.get("text") or "").lstrip().startswith("/"))
            if ev.get("is_error") or (sub.startswith("error") and sub != "error_during_execution"):
                # `error_during_execution` é o interrupt (medido); o resto é falha de verdade
                # (limite de turnos, credencial, API) e some calado se não for dito aqui.
                detalhe = str(ev.get("result") or "")
                # Sem login a CLI responde `success` + is_error com este texto (medido) e segue
                # viva; o app precisa dizer o que fazer, não só "deu erro".
                codigo = "headless_sem_login" if "not logged in" in detalhe.lower() else "headless_turno_erro"
                self._registrar_problema(sess, codigo, f"{sub}: {detalhe[:300]}")
            elif sub == "success" and not ev.get("local_command"):
                # Comando local "dando certo" não diz nada da saúde da sessão (e apagaria o
                # problema que a própria resposta dele acabou de registrar, ex.: /effort recusado).
                self._limpar_problema(sess)
            # `permission_denials` (hook, regra deny, dontAsk) NÃO vira nota: cada negação já está no
            # .jsonl como tool_result com o motivo, e o card da ferramenta mostra igual ao terminal.
            self._aplicar_uso(sess, ev)
            self._recalcular_estado(sess)
            await PushPreviewSource.get(sess.name).push("")
            await self._notify(sess)
            if time.time() - sess.janelas_ts > 300:
                self._agendar_cota(sess)
            if sess.effort_pendente:
                # Esforço pedido no meio do turno: agora, antes da fila, pra o próximo prompt já
                # sair no nível novo. O `result` desse comando volta aqui com `effort_pendente`
                # já vazio (ou com um pedido mais novo, que sai na sequência).
                pendente, sess.effort_pendente = sess.effort_pendente, None
                await self._comando_local(sess, f"/effort {pendente}")
                await self._notify(sess)
                return
            # Fim de turno é o momento certo de entregar o que ficou na fila. O hook Stop também
            # dispara o drain server-side, mas pode correr ANTES deste `result` chegar — aí o
            # adapter ainda se acha em turno e devolve "deferred".
            sess.drenador = asyncio.create_task(self._drenar_fim_de_turno(sess))
            self._tarefas.add(sess.drenador)
            sess.drenador.add_done_callback(self._tarefas.discard)
            return
        if t == "rate_limit_event":
            info = ev.get("rate_limit_info") or {}
            # Só `rejected` é bloqueio. `allowed_warning` é a janela passando de um patamar com
            # a cota ainda livre — pintá-lo como limite mostrava "volta HH:MM" sem limite nenhum.
            sess.limited = info.get("status") == "rejected"
            sess.limit_reset = _hora_local(info.get("resetsAt")) if sess.limited else None
            await self._notify(sess)
            return
        if t not in ("keep_alive", "conversation_reset", "tool_progress") and t not in sess.tipos_desconhecidos:
            # Evento que este adapter não conhece: no terminal teria tela, aqui sumiria calado.
            # Uma nota por tipo por sessão, senão vira spam.
            sess.tipos_desconhecidos.add(str(t))
            _log.warning("claude headless: evento não tratado name=%s tipo=%s", sess.name, t)
            await self._nota_local(sess, f"⚙️ Evento desconhecido da CLI: {t}")

    async def _on_system(self, sess: _Sessao, ev: dict) -> None:
        sub = ev.get("subtype")
        if sub == "init":
            sid = ev.get("session_id")
            if sid and sid != sess.sid:
                # /clear (ou resume que trocou de id): o transcript agora é outro arquivo. O
                # sidecar é a fonte da lista, e o jsonl_watcher do SSE faz o reset a partir dela.
                sess.meta = hl_sessions.update(sess.name, session_id=sid) or {**sess.meta, "session_id": sid}
            if ev.get("model"):
                sess.model = ev["model"]
            if ev.get("permissionMode"):
                self._definir_modo(sess, ev["permissionMode"])
            if isinstance(ev.get("terminal_slash_commands"), list):
                sess.comandos_terminal = frozenset(str(c) for c in ev["terminal_slash_commands"])
            sess.initialized.set()
        elif sub == "status":
            if ev.get("permissionMode"):
                self._definir_modo(sess, ev["permissionMode"])
            if ev.get("status") == "requesting" and sess.in_progress:
                sess.label = "Pensando…"
        elif sub == "thinking_tokens":
            if sess.in_progress:
                sess.label = "Pensando…"
        elif sub and sub.startswith("compact"):
            sess.label = "Compactando…"
        elif sub == "task_started":
            # Subagente (tool Agent/skill que forka): o rótulo passa a dizer o que ELE faz, que é
            # o que o terminal mostra em vez de "Agent…" parado até o fim.
            sess.tarefas[str(ev.get("task_id"))] = {
                "tipo": ev.get("subagent_type") or ev.get("task_type") or "agente",
                "passo": ev.get("description") or "",
            }
            sess.label = self._rotulo_tarefas(sess)
        elif sub == "task_progress":
            t = sess.tarefas.get(str(ev.get("task_id")))
            if t is not None:
                t["passo"] = ev.get("description") or t["passo"]
                sess.label = self._rotulo_tarefas(sess)
        elif sub in ("task_notification", "task_updated"):
            status = ev.get("status") or (ev.get("patch") or {}).get("status")
            if status in ("completed", "failed", "killed", "cancelled"):
                sess.tarefas.pop(str(ev.get("task_id")), None)
                sess.label = self._rotulo_tarefas(sess)   # None quando era o último
        else:
            return
        await self._notify(sess)

    def _rotulo_tarefas(self, sess: _Sessao) -> str | None:
        vivas = list(sess.tarefas.values())
        if not vivas:
            return None
        t = vivas[-1]
        passo = t["passo"].removeprefix("Running ").strip()
        rotulo = f"{t['tipo']}: {passo}" if passo else f"{t['tipo']}…"
        if len(vivas) > 1:
            rotulo = f"{len(vivas)} agentes · {rotulo}"
        return rotulo[:120]

    async def _on_stream(self, sess: _Sessao, e: dict) -> None:
        tipo = e.get("type")
        if tipo == "content_block_start":
            bloco = e.get("content_block") or {}
            if bloco.get("type") == "text":
                sess.previa = ""
                sess.label = None
            elif bloco.get("type") in ("tool_use", "server_tool_use", "mcp_tool_use"):
                sess.label = f"{bloco.get('name') or 'tool'}…"
            elif bloco.get("type") == "thinking":
                sess.label = "Pensando…"
                sess.pensando_desde = time.monotonic()
            await self._notify(sess)
        elif tipo == "content_block_delta":
            d = e.get("delta") or {}
            pedaco = d.get("text") or d.get("thinking") or d.get("partial_json") or ""
            # Estimativa enquanto a mensagem escreve (o `output_tokens` real só chega no fim dela);
            # o tique de 1s do stream leva o número pra tela, sem notificar a cada delta.
            sess.tokens_msg_chars += len(pedaco)
            if d.get("type") == "text_delta" and d.get("text"):
                sess.previa += d["text"]
                await PushPreviewSource.get(sess.name).push(sess.previa)
        elif tipo == "content_block_stop":
            if sess.pensando_desde is not None:
                sess.pensou_s += time.monotonic() - sess.pensando_desde
                sess.pensando_desde = None
        elif tipo == "message_delta":
            real = (e.get("usage") or {}).get("output_tokens")
            if isinstance(real, int):
                sess.tokens_msg = real
        elif tipo == "message_start":
            sess.fechar_mensagem()
            if sess.turno_inicio is None:
                sess.iniciar_turno()
            if not sess.in_progress:
                # Turno iniciado por outro caminho (steer, hook): o estado acompanha o stream.
                sess.in_progress = True
                sess.state = "working"
                await self._notify(sess)

    async def _on_control_request(self, sess: _Sessao, ev: dict) -> None:
        rid = str(ev.get("request_id"))
        req = ev.get("request") or {}
        sub = req.get("subtype")
        if sub != "can_use_tool":
            # Subtype que não tratamos: responder vazio destrava a CLI (mesma escolha do MonoCode),
            # mas a pessoa precisa saber que algo foi pedido e decidido sem ela.
            await self._responder(sess, rid, {})
            if sub not in sess.tipos_desconhecidos:
                sess.tipos_desconhecidos.add(str(sub))
                await self._nota_local(sess, f"⚙️ A CLI pediu `{sub}`; respondi vazio")
            return
        if req.get("tool_name") == "AskUserQuestion":
            perguntas = (req.get("input") or {}).get("questions") or []
            sess.question = {"provider": "claude", "request_id": rid, "questions": perguntas}
        else:
            sess.pending[rid] = req
        self._recalcular_estado(sess)
        await self._notify(sess)

    @staticmethod
    def _aplicar_uso(sess: _Sessao, ev: dict) -> None:
        """Custo e janela de contexto de um `result` — também do que veio no snapshot. O `usage`
        dele é a SOMA das chamadas do turno (cada uma relê o cache inteiro), não o contexto: o
        contexto sai da última chamada (`_aplicar_uso_da_chamada`)."""
        if isinstance(ev.get("total_cost_usd"), (int, float)):
            sess.cost = float(ev["total_cost_usd"])
        for m, dados in (ev.get("modelUsage") or {}).items():
            if isinstance(dados, dict) and dados.get("contextWindow"):
                sess.model = sess.model or m
                sess.context_window = int(dados["contextWindow"])

    def _recalcular_estado(self, sess: _Sessao) -> None:
        antes = sess.state
        if not sess.vivo:
            sess.state = "dead"
        elif sess.pending or sess.question:
            sess.state = "awaiting_input"
        elif sess.in_progress:
            sess.state = "working"
        else:
            sess.state = "idle"
        # Sem pane não há hook `Notification`: é o adapter que sabe que a sessão está esperando.
        # Gravar o marcador do state_hook põe a espera na mesma esteira das sessões no tmux
        # (push de "aguardando", pausa do loop) sem outro caminho. O state_hook continua
        # escrevendo working/idle no mesmo arquivo, sem corrida: a CLI espera o PreToolUse
        # terminar antes de pedir permissão, e o PostToolUse só roda depois da resposta.
        if sess.state != antes and "awaiting_input" in (sess.state, antes):
            self._gravar_marcador(sess, sess.state)

    def _gravar_marcador(self, sess: _Sessao, state: str) -> None:
        base = _dir_marcadores(sess.meta)
        try:
            base.mkdir(parents=True, exist_ok=True)
            tmp = base / f"{sess.sid}.json.tmp"
            tmp.write_text(json.dumps({"state": state, "ts": time.time()}), encoding="utf-8")
            atomico.substituir(tmp, base / f"{sess.sid}.json")
        except OSError:
            _log.warning("claude headless: marcador de estado não gravado name=%s", sess.name, exc_info=True)

    async def _notify(self, sess: _Sessao) -> None:
        async with sess.cond:
            sess.version += 1
            sess.cond.notify_all()

    # ── estado pro SSE ─────────────────────────────────────────────────────────────────────

    def _permissao_texto(self, req: dict) -> str:
        tool, detalhe = _alvo_da_permissao(req)
        return f"Permitir {tool}? {detalhe}".strip()

    async def _nota_local(self, sess: _Sessao, texto: str) -> None:
        """Bolha do assistente fora do transcript (comando local, aviso de permissão): vai pela
        fila durável, que o histórico e o SSE já sabem ler. Falha vira log e problema visível."""
        try:
            await asyncio.to_thread(PromptQueue(sess.name).append_saida_local, texto)
        except Exception:
            _log.exception("claude headless: nota local não gravada name=%s", sess.name)
            if not sess.problema:   # um problema real (login, turno) não pode ser coberto por este
                self._registrar_problema(sess, "headless_turno_erro", f"aviso perdido: {texto[:120]}")

    def status_line(self, sess: _Sessao) -> str | None:
        parts: list[str] = []
        if sess.model:
            seg = f"🤖 {_rotulo_modelo(sess.model)}"
            esforco = sess.effort or _esforco_padrao(sess.meta.get("config_dir"))
            if esforco:
                seg += f" ({esforco})"
            parts.append(seg)
        u = sess.usage or {}
        usado = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
        if usado and sess.context_window:
            parts.append(f"💬 {_fmt_tok(usado)}/{_fmt_tok(u.get('output_tokens') or 0)} "
                         f"{_fmt_tok(usado)}/{_fmt_tok(sess.context_window)}")
        if sess.cost is not None:
            parts.append(f"💵 ${sess.cost:.2f}")
        agora = time.time()
        for j in sess.janelas:
            emoji = {"5h": "⚡", "7d": "📅"}.get(j.rotulo)
            if not emoji:
                continue
            seg = f"{emoji}{j.rotulo}:{round(j.pct)}%"
            if j.reset_ts:
                seg += f" ↺{_format_reset(j.reset_ts, agora)}"
            parts.append(seg)
        return " │ ".join(parts) or None

    async def _drenar_fim_de_turno(self, sess: _Sessao) -> None:
        try:
            await self.drain(sess.name, self.transcript_path_de(sess.meta))
        except Exception:
            # A fila segue pendente (nada foi marcado); o próximo fim de turno tenta de novo.
            _log.exception("claude headless: drain de fim de turno falhou name=%s", sess.name)

    def _agendar_cota(self, sess: _Sessao) -> None:
        # Referência guardada e falha logada: tarefa solta some com a exceção junto.
        t = asyncio.get_running_loop().create_task(self._atualizar_cota(sess))
        self._tarefas.add(t)
        t.add_done_callback(self._tarefas.discard)

    async def _atualizar_cota(self, sess: _Sessao) -> None:
        """Janelas da conta desta sessão, pelo leitor da faixa (cache de 5 min, rede na thread)."""
        sess.janelas_ts = time.time()   # também sem achar a conta: a cadência é a mesma
        try:
            alvo = Path(sess.meta.get("config_dir") or Path.home() / ".claude").resolve()
            contas = await asyncio.to_thread(cotas.listar_cotas)
            for c in contas:
                if c.provedor != "claude" or ":" not in c.id:
                    continue
                if Path(c.id.split(":", 1)[1]).resolve() == alvo:
                    sess.janelas = [j for j in c.janelas if not j.por_modelo]
                    await self._notify(sess)
                    return
            _log.info("claude headless: conta %s não está na faixa de cotas — sem ⚡/📅 name=%s", alvo, sess.name)
        except Exception:
            _log.warning("claude headless: leitura de cota falhou name=%s", sess.name, exc_info=True)

    def _evento(self, sess: _Sessao) -> StateEvent:
        question = options = None
        if sess.pending and not sess.question:
            req = next(iter(sess.pending.values()))
            question = self._permissao_texto(req)
            options = list(OPCOES_PERMISSAO) + ([OPCAO_SEMPRE] if _sugestoes_de(req) else [])
        label, state = sess.label, sess.state
        if sess.iniciando and state == "idle":
            # Sem terminal, este é o único sinal de que o prompt foi aceito e a sessão está subindo.
            state, label = "working", "Iniciando sessão…"
        if state == "working" and (contas := sess.rotulo_turno()):
            label = f"{label or 'Trabalhando…'} {contas}"
        return StateEvent(session=sess.name, state=state, label=label, headless=True,
                          question=question, options=options,
                          status_line=self.status_line(sess),
                          claude_permission_mode=sess.permission_mode,
                          claude_previous_non_plan=sess.modo_nao_plan,
                          limited=sess.limited, limit_reset=sess.limit_reset,
                          codex_question=sess.question,
                          problema=sess.problema, problema_detalhe=sess.problema_detalhe)

    def comandos(self, name: str) -> tuple[list[dict] | None, frozenset[str]]:
        """Lista do `/` que a CLI desta sessão informou (None = ainda não subiu) e os nomes que só
        rodam na TUI."""
        sess = self._sessions.get(name)
        if sess is None:
            return None, frozenset()
        return sess.comandos, sess.comandos_terminal

    def problema_de(self, name: str) -> tuple[str, str | None] | None:
        sess = self._sessions.get(name)
        if sess is not None and sess.problema:
            return sess.problema, sess.problema_detalhe
        return self._problemas.get(name)

    def _registrar_problema(self, sess: _Sessao, codigo: str, detalhe: str | None) -> None:
        sess.problema, sess.problema_detalhe = codigo, (detalhe or None)
        self._problemas[sess.name] = (codigo, detalhe or None)
        _log.warning("claude headless: %s name=%s %s", codigo, sess.name, (detalhe or "")[:200])

    def _limpar_problema(self, sess: _Sessao) -> None:
        sess.problema = sess.problema_detalhe = None
        self._problemas.pop(sess.name, None)

    def snapshot(self, name: str) -> StateEvent | None:
        """Estado atual sem abrir stream (lista/board). None = sem processo vivo (sessão parada)."""
        sess = self._sessions.get(name)
        if sess is None or not sess.vivo:
            return None
        return self._evento(sess)

    async def _state_stream(self, name: str) -> AsyncIterator[StateEvent]:
        while True:
            if not hl_sessions.exists(name):
                yield StateEvent(session=name, state="dead", headless=True)
                return
            sess = self._sessions.get(name)
            if sess is None or not sess.vivo:
                # Sessão parada (o processo morre com o backend): ociosa até o próximo prompt
                # subir outro. Não sobe aqui — abrir o chat não deve custar um processo.
                meta = hl_sessions.load(name) or {}
                prob = self._problemas.get(name)
                yield StateEvent(session=name, state="idle", headless=True,
                                 claude_permission_mode=meta.get("permission_mode"),
                                 claude_previous_non_plan=meta.get("previous_non_plan"),
                                 status_line=_linha_parada(meta),
                                 problema=prob[0] if prob else None,
                                 problema_detalhe=prob[1] if prob else None)
                while True:
                    await asyncio.sleep(1.0)
                    sess = self._sessions.get(name)
                    if sess is not None and sess.vivo:
                        break
                    if self._problemas.get(name) != prob:
                        # Subida em segundo plano (acordar) falhou com o chat já aberto: sem
                        # reemitir, o problema só apareceria numa conexão nova.
                        break
                    if not hl_sessions.exists(name):
                        yield StateEvent(session=name, state="dead", headless=True)
                        return
                if sess is None or not sess.vivo:
                    continue
            last = -1
            while True:
                async with sess.cond:
                    # Turno em voo: tique de 1s, senão o relógio e os tokens do rótulo ficam parados
                    # entre dois eventos (uma tool longa não emite nada).
                    try:
                        await asyncio.wait_for(sess.cond.wait_for(lambda: sess.version != last),
                                               1.0 if sess.turno_inicio is not None else None)
                    except TimeoutError:
                        pass
                    last = sess.version
                    ev = self._evento(sess)
                if ev.state == "dead":
                    # Processo caiu (ou o backend o matou). Com sidecar, a sessão segue existindo
                    # e volta ociosa (laço de fora); sem sidecar (kill), morreu de vez.
                    if self._sessions.get(name) is sess:
                        self._sessions.pop(name, None)
                    break
                yield ev

    # ── encerramento ───────────────────────────────────────────────────────────────────────

    def close_sync(self, name: str, meta: dict | None = None) -> None:
        """Mata o cano da sessão (chamado do registry.kill, numa thread). O leitor vê o EOF e
        fecha o resto; o sidecar é apagado por quem chamou — ANTES de chamar aqui, senão um drain
        no meio acha o sidecar e sobe outro processo — e vem em `meta`, porque é nele que está o
        pid do cano (que pode estar vivo sem este backend nunca ter conectado).

        Os dicionários são do event loop: mexer neles daqui é corrida. A retirada vai pro loop
        por `call_soon_threadsafe`; o sinal pode sair já, é só `os.kill`."""
        _limpar_rastros_do_cano(meta)
        sess = self._sessions.get(name)
        if sess is None:
            PushPreviewSource._sources.pop(name, None)
            self._problemas.pop(name, None)
            pid = ((meta or {}).get("cano") or {}).get("pid")
            if pid is not None:
                _matar_grupo(int(pid), name)
            return

        def _retirar() -> None:
            if self._sessions.get(name) is sess:
                self._sessions.pop(name, None)
            PushPreviewSource._sources.pop(name, None)
            self._problemas.pop(name, None)

        loop = sess.loop
        try:
            no_loop = loop is not None and loop.is_running() and asyncio.get_running_loop() is loop
        except RuntimeError:
            no_loop = False
        if no_loop or loop is None or not loop.is_running():
            _retirar()
        else:
            loop.call_soon_threadsafe(_retirar)
        self._matar(sess, meta)

    def rename(self, old: str, new: str) -> None:
        sess = self._sessions.pop(old, None)
        if sess is not None:
            sess.name = new
            sess.meta["name"] = new
            self._sessions[new] = sess
        lock = self._delivery_locks.pop(old, None)
        if lock is not None:
            self._delivery_locks[new] = lock


# Anexo de imagem do composer ("legenda — 📎 imagem: <path>"). No terminal a TUI reconhece o path
# e anexa a imagem de verdade; aqui é o adapter que anexa, como bloco `image` ao lado do texto.
# O texto vai inteiro (com o path): é o que o .jsonl grava e o que a fila usa pra confirmar.
_IMG_RE = re.compile(r"📎\s*imagem:\s*(.+?)(?=\s*📎|$)", re.M)
_IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".gif": "image/gif", ".webp": "image/webp"}
_IMG_TETO = 5 * 1024 * 1024   # teto da API por imagem; acima disso fica só o path (o Read abre)


def _caminho_de_imagem(trecho: str) -> Path | None:
    # O que vem depois de "📎 imagem:" até o próximo marcador: path gerado pelo upload (sem espaço)
    # ou digitado à mão (pode ter espaço, ou texto colado depois). Tenta o trecho inteiro e
    # depois só a primeira palavra; pontuação colada no fim (vírgula, ponto) não conta.
    for cand in (trecho.strip(), trecho.split()[0] if trecho.split() else ""):
        cand = cand.rstrip(".,;:)")
        if cand and Path(cand).suffix.lower() in _IMG_MIME:
            return Path(cand)
    return None


def _blocos_do_prompt(text: str) -> tuple[list[dict], list[str]]:
    """(blocos da mensagem `user`, avisos de imagem que ficou só como path)."""
    blocos: list[dict] = [{"type": "text", "text": text}]
    avisos: list[str] = []
    for trecho in _IMG_RE.findall(text):
        caminho = _caminho_de_imagem(trecho)
        if caminho is None:
            continue
        mime = _IMG_MIME[caminho.suffix.lower()]
        try:
            dados = caminho.read_bytes()
        except OSError as e:
            avisos.append(f"⚠️ Imagem não anexada (não abre: {e.strerror or e}); só o path foi: {caminho.name}")
            continue
        if len(dados) > _IMG_TETO:
            avisos.append(f"⚠️ Imagem não anexada ({len(dados) // (1024 * 1024)} MB, teto 5 MB); só o path foi: {caminho.name}")
            continue
        blocos.append({"type": "image", "source": {"type": "base64", "media_type": mime,
                                                   "data": base64.b64encode(dados).decode("ascii")}})
    return blocos, avisos


def _alvo_da_permissao(req: dict) -> tuple[str, str]:
    """(ferramenta, detalhe curto) de um pedido de permissão ou de uma negação do `result`."""
    tool = req.get("tool_name") or "ferramenta"
    inp = req.get("input") or {}
    detalhe = req.get("description") or inp.get("command") or inp.get("file_path") or inp.get("path") or ""
    detalhe = str(detalhe)
    if len(detalhe) > 200:
        detalhe = detalhe[:200] + "…"
    return str(tool), detalhe


def _modo_do_app(modo: str) -> str:
    # A CLI aceita `--permission-mode manual` mas reporta "default" no stream; o app (e a flag do
    # próximo processo) só conhecem "manual".
    return "manual" if modo == "default" else modo


def _dir_marcadores(meta: dict) -> Path:
    # Mesmo diretório que o state_hook da conta usa (`<config_dir>/.hangar-state`).
    return Path(meta.get("config_dir") or Path.home() / ".claude") / ".hangar-state"


def _sugestoes_de(req: dict) -> list[dict]:
    s = req.get("permission_suggestions")
    return [x for x in s if isinstance(x, dict)] if isinstance(s, list) else []


def _aplicar_uso_da_chamada(sess: _Sessao, u) -> None:
    """Contexto = o que UMA chamada mandou pro modelo. Uso zerado (interrupt, comando local) não
    apaga o contexto anterior."""
    if isinstance(u, dict) and any(u.get(k) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")):
        sess.usage = u


_TAIL_TRANSCRIPT = 512 << 10


def _uso_da_ultima_chamada(path: str) -> dict | None:
    """`usage` da última mensagem do assistente no .jsonl (fora de subagente), ou None."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - _TAIL_TRANSCRIPT))
            linhas = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for linha in reversed(linhas):
        if '"assistant"' not in linha:
            continue
        try:
            o = json.loads(linha)
        except ValueError:
            continue   # a primeira linha do corte, ou uma escrita em andamento
        if o.get("type") != "assistant" or o.get("isSidechain"):
            continue
        u = (o.get("message") or {}).get("usage")
        if isinstance(u, dict) and any(u.get(k) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")):
            return u
    return None


_FAMILIAS = ("opus", "sonnet", "haiku", "fable")


def _rotulo_modelo(modelo: str) -> str:
    """`claude-opus-5[1m]` -> `Opus5·1M`, a mesma grafia da statusline das sessões no tmux (que
    parte do display_name). Id que não é de família conhecida (motor, alias) passa como veio."""
    base = modelo.strip()
    um = base.lower().endswith("[1m]")
    if um:
        base = base[:-4]
    partes = base.lower().removeprefix("claude-").split("-")
    if not partes or partes[0] not in _FAMILIAS:
        return modelo
    versao = ".".join(p for p in partes[1:] if p.isdigit() and len(p) < 8)   # 8 dígitos = data
    familia = partes[0].capitalize()
    rotulo = (f"{familia}{versao}" if familia == "Opus" else f"{familia} {versao}").strip()
    return rotulo + ("·1M" if um else "")


def _linha_parada(meta: dict) -> str | None:
    """Sessão sem processo: modelo e esforço escolhidos na abertura, no mesmo formato da viva."""
    if not meta.get("model"):
        return None
    esforco = meta.get("effort") or _esforco_padrao(meta.get("config_dir"))
    return f"🤖 {_rotulo_modelo(meta['model'])}" + (f" ({esforco})" if esforco else "")


def _esforco_padrao(config_dir: str | None) -> str | None:
    """Esforço que a CLI usa quando a sessão não escolheu nenhum: env, depois o settings da conta."""
    env = os.environ.get("CLAUDE_CODE_EFFORT_LEVEL")
    if env:
        return env
    base = Path(config_dir) if config_dir else Path.home() / ".claude"
    try:
        nivel = json.loads((base / "settings.json").read_text(encoding="utf-8")).get("effortLevel")
    except (OSError, ValueError, AttributeError):
        return None
    return nivel if isinstance(nivel, str) and nivel else None


def _hora_local(epoch) -> str | None:
    if not isinstance(epoch, (int, float)):
        return None
    return time.strftime("%H:%M", time.localtime(epoch))


def _matar_grupo(pid: int, name: str) -> None:
    """SIGTERM no grupo do cano (cano + claude, que é filho dele no mesmo grupo). Idempotente."""
    if os.name == "nt":
        import subprocess
        exe = shutil.which("taskkill")
        if exe is None:
            _log.warning("claude headless: taskkill não encontrado; cano name=%s pid=%s segue vivo", name, pid)
            return
        try:
            r = subprocess.run([exe, "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            _log.warning("claude headless: taskkill falhou name=%s pid=%s", name, pid, exc_info=True)
            return
        # 128 = processo não existe (já morreu): não é falha. Outro código é.
        if r.returncode not in (0, 128):
            _log.warning("claude headless: taskkill rc=%s name=%s pid=%s: %s", r.returncode, name, pid,
                         (r.stderr or b"").decode(errors="replace").strip()[:200])
        return
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError:
        _log.warning("claude headless: não matou o cano name=%s pid=%s", name, pid, exc_info=True)


def _esquecer_cano(name: str, pid: int | None) -> None:
    """Tira o `cano` do sidecar SÓ se ainda for este (pid): o leitor de um cano velho terminando
    tarde não pode apagar o cano novo que `_reabrir` acabou de subir — senão o novo vira um
    processo invisível escrevendo no mesmo .jsonl."""
    meta = hl_sessions.load(name)
    atual = ((meta or {}).get("cano") or {}).get("pid")
    if meta is not None and (pid is None or atual == pid):
        hl_sessions.update(name, cano=None)


def _escuta_nova(key: str) -> tuple[str, str | None]:
    """Endereço do cano de uma sessão nova: socket unix na pasta dos sidecars (Linux/mac), TCP em
    loopback com token onde não há socket unix ou o caminho passa do limite do kernel."""
    if os.name != "nt":
        # Sufixo por subida: o cano anterior (mesma chave) pode ainda estar morrendo, e um path
        # igual faria o novo roubar o socket dele. A limpeza vai por `cano-<chave>*`.
        caminho = hl_sessions._dir() / f"cano-{key[:16]}-{uuid.uuid4().hex[:4]}.sock"
        if len(str(caminho).encode()) < 100:
            return f"unix:{caminho}", None
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        porta = s.getsockname()[1]
    return f"tcp:127.0.0.1:{porta}", uuid.uuid4().hex


def _limpar_rastros_do_cano(meta: dict | None) -> None:
    """Sessão encerrada: socket e log do cano vão junto (o log fica só enquanto a sessão vive)."""
    key = (meta or {}).get("key")
    if not key:
        return
    for arq in hl_sessions._dir().glob(f"cano-{key[:16]}*"):
        try:
            arq.unlink()
        except OSError:
            pass


def _cauda(log: Path, n: int = 5) -> str:
    try:
        return "\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
    except OSError:
        return ""


def matar_orfaos() -> int:
    """Canos cuja sessão já não existe (encerrada com o backend fora, ou sidecar perdido). Os
    outros são de propósito: sobreviveram ao restart e o backend religa neles. Chamado na subida.
    Só Linux (/proc); sem ele não há varredura, e o kill de sessão continua matando pelo pid."""
    mortos = 0
    proc = Path("/proc")
    if not proc.exists():
        return 0
    vivas = {m.get("key") for m in hl_sessions.list_all() if m.get("key")}
    meu_uid = os.getuid()
    sem_permissao = 0
    marca = f"{_MARCADOR_CANO}=".encode()
    for p in proc.iterdir():
        if not p.name.isdigit():
            continue
        try:
            if p.stat().st_uid != meu_uid:
                continue      # processo de outro usuário: não é meu e o environ nem seria legível
            env = (p / "environ").read_bytes()
        except PermissionError:
            sem_permissao += 1
            continue
        except OSError:
            continue
        for item in env.split(b"\0"):
            if item.startswith(marca):
                chave = item[len(marca):].decode(errors="replace")
                if chave and chave not in vivas:
                    try:
                        os.kill(int(p.name), signal.SIGTERM)
                        mortos += 1
                    except OSError:
                        _log.warning("claude headless: órfão pid=%s não morreu", p.name, exc_info=True)
                break
    if sem_permissao:
        _log.info("claude headless: varredura de órfãos sem permissão em %d processo(s) meus", sem_permissao)
    return mortos
