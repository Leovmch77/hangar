"""Terminais dos atalhos "shell": cada execucao ganha uma sessao tmux escondida propria.

O tmux e a unica fonte de verdade: dono, id e rotulo moram em opcoes de usuario da sessao
(`@cp_shortcut_*`), entao a lista sobrevive a restart do backend sem arquivo de estado. A marca
`@cp_hidden` e a mesma do shell do painel (`tmux.new_hidden_shell`): sem ela a sessao viraria card.

`remain-on-exit` mantem o pane depois que o comando sai, com a saida na tela (o codigo de saida vai
na aba) — e o que deixa a pessoa conferir o que o atalho fez e fechar quando quiser.
"""
import logging
import os
import re
import secrets
import signal
import time

from app import tmux

_log = logging.getLogger(__name__)

PREFIX = "shortcut-"
_OWNER, _ID, _LABEL = "@cp_shortcut_owner", "@cp_shortcut_id", "@cp_shortcut_label"
# Nanossegundos da criacao: o `session_created` do tmux e por segundo, e dois cliques no mesmo
# segundo trocariam de ordem na barra de abas.
_SEQ = "@cp_shortcut_seq"
_ID_RE = re.compile(r"^[0-9a-f]{6}$")
_LABEL_MAX = 80


def _slug(owner: str) -> str:
    # O nome vira alvo do tmux: `.` e `:` separam janela/pane la, e o resto fica curto e legivel.
    return re.sub(r"[^A-Za-z0-9_-]", "_", owner)[:40] or "s"


def _clean_label(label: str) -> str:
    # Uma linha so: o rotulo volta pelo `-F` separado por tab e acaba num botao de aba.
    text = " ".join(label.split())
    return text[:_LABEL_MAX]


def start(owner: str, cwd: str, command: str, label: str, env: dict[str, str]) -> dict | None:
    """Cria a sessao escondida rodando `argv` do shell do usuario. None = o tmux recusou."""
    ident = secrets.token_hex(3)
    target = f"{PREFIX}{_slug(owner)}-{ident}"
    shell = os.environ.get("SHELL") or "/bin/sh"
    label = _clean_label(label) or _clean_label(command)
    args = [*tmux._scope_prefix(), "tmux", "new-session", "-d", "-s", target, "-c", cwd]
    for key, value in env.items():
        args += ["-e", f"{key}={value}"]
    # Tudo numa invocacao so: o tmux executa a lista inteira antes de tratar a saida do filho, entao
    # um comando que morre na hora ainda encontra o remain-on-exit ligado, e a lista de sessoes
    # nunca ve a sessao sem a marca de escondida.
    args += ["--", shell, "-c", command]
    for opt, value in (("@cp_hidden", "1"), (_OWNER, owner), (_ID, ident), (_SEQ, str(time.time_ns())),
                       (_LABEL, label)):
        args += [";", "set-option", "-t", f"={target}:", opt, value]
    args += [";", "set-option", "-w", "-t", f"={target}:", "remain-on-exit", "on"]
    # Linha "Pane is dead" vazia: com texto o tmux a escreve no rodape e rola a tela uma linha,
    # levando a primeira linha da saida pro historico. A aba ja diz "saiu com N".
    args += [";", "set-option", "-w", "-t", f"={target}:", "remain-on-exit-format", ""]
    # Sem a barra de status do tmux: o painel e so a saida do comando.
    args += [";", "set-option", "-t", f"={target}:", "status", "off"]
    cp = tmux._run(args)
    if cp.returncode != 0 and not tmux.has_session(target):
        _log.warning("shortcut: tmux recusou criar %r: %s", target, (cp.stderr or "").strip()[:200])
        return None
    return {"id": ident, "label": label, "tmux": target}


def _rows() -> list[dict]:
    cp = tmux._run(["tmux", "list-sessions", "-F",
                    f"#{{session_name}}\t#{{{_OWNER}}}\t#{{{_ID}}}\t#{{session_created}}"
                    f"\t#{{pane_dead}}\t#{{pane_dead_status}}\t#{{pane_pid}}\t#{{{_SEQ}}}\t#{{{_LABEL}}}"])
    if cp.returncode != 0:
        return []
    out = []
    for line in cp.stdout.splitlines():
        parts = line.split("\t", 8)
        if len(parts) != 9 or not parts[0].startswith(PREFIX) or not _ID_RE.match(parts[2]):
            continue
        name, owner, ident, created, dead, status, pid, seq, label = parts
        out.append({"tmux": name, "owner": owner, "id": ident,
                    "created": int(created) if created.isdigit() else 0,
                    "alive": dead != "1",
                    "exit_code": int(status) if dead == "1" and status.lstrip("-").isdigit() else None,
                    "pid": int(pid) if pid.isdigit() else None, "label": label,
                    "seq": int(seq) if seq.isdigit() else 0})
    return out


def list_for(owner: str) -> list[dict]:
    """Terminais de atalho da sessao `owner`, do mais antigo pro mais novo."""
    rows = [r for r in _rows() if r["owner"] == owner]
    rows.sort(key=lambda r: (r["created"], r["seq"], r["tmux"]))
    return [{k: r[k] for k in ("id", "label", "alive", "exit_code", "created")} for r in rows]


def find(owner: str, ident: str) -> str | None:
    """Alvo tmux do terminal `ident` SE ele pertence a `owner`. O dono e conferido aqui, no
    servidor: o id vem do cliente e nunca pode alcancar a sessao de outra conversa."""
    if not _ID_RE.match(ident or ""):
        return None
    return next((r["tmux"] for r in _rows() if r["owner"] == owner and r["id"] == ident), None)


def status(target: str) -> tuple[bool, int | None]:
    """(vivo, codigo de saida). Sem resposta do tmux conta como vivo: nada a relatar ainda."""
    cp = tmux._run(["tmux", "display", "-p", "-t", f"={target}:", "#{pane_dead}\t#{pane_dead_status}"])
    dead, _, code = cp.stdout.strip().partition("\t")
    if cp.returncode != 0 or dead != "1":
        return True, None
    return False, int(code) if code.lstrip("-").isdigit() else None


def output(target: str) -> str:
    # O "Pane is dead" do remain-on-exit e do tmux, nao do comando: fica fora do resumo do erro.
    text = tmux.capture_pane(target, lines=200)
    return "\n".join(l for l in text.splitlines() if not l.startswith("Pane is dead"))


def _kill_group(pid: int) -> None:
    # O pane e lider de sessao e de grupo (o tmux faz setsid): o grupo leva junto o que o comando
    # abriu em primeiro plano (o xfreerdp do atalho do RDP). O kill-session so fecha o pty, e
    # programa que ignora SIGHUP sobreviveria a ele.
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    limit = time.monotonic() + 1.0
    while time.monotonic() < limit:
        try:
            os.killpg(pid, 0)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _close_row(row: dict) -> bool:
    if row["alive"] and row["pid"]:
        _kill_group(row["pid"])
    return tmux.kill_session(row["tmux"])


def close(owner: str, ident: str) -> bool | None:
    """None = nao existe (ou nao e dessa sessao); False = a sessao tmux sobreviveu."""
    row = next((r for r in _rows() if r["owner"] == owner and r["id"] == ident), None)
    if row is None:
        return None
    return _close_row(row)


def close_all(owner: str) -> None:
    """Best-effort, chamado quando a conversa fecha: falhar aqui nao pode desfazer o kill dela."""
    for row in _rows():
        if row["owner"] == owner and not _close_row(row):
            _log.debug("shortcut: %r nao saiu ao fechar %r", row["tmux"], owner)


def rename_owner(old: str, new: str) -> None:
    # O dono e a opcao, nao o nome tmux: basta reapontar a opcao pra lista seguir a conversa.
    for row in _rows():
        if row["owner"] == old:
            tmux._run(["tmux", "set-option", "-t", f"={row['tmux']}:", _OWNER, new])
