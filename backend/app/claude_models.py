"""Catálogo de modelos de uma conta Claude sem sessão viva: um `claude` efêmero em stdio.

Irmão do `app/codex_appserver.py` + `app/codex_models.py`, e pelo mesmo motivo: a tela de ABERTURA
precisa da lista antes de existir sessão. O caminho que já existia era o picker do Claude Code
dirigido no terminal de uma sessão VIVA (`terminal_input.list_model_options`) — inútil aqui, e pior
que inútil se fosse tentado sozinho, porque abriria o `/model` na tela de quem estivesse usando.

O que existe sem sessão é o `control_request` `list_models` do próprio protocolo stream-json: a
mesma fonte que `ClaudeHeadlessAdapter.list_models` usa no processo da sessão, só que num processo
que sobe, responde e morre. Medido em 18/09/2026 (Claude Code do PATH): 0,88s com
`--setting-sources ""`, contra 4,3s com os settings do usuário — a diferença são os hooks de
`SessionStart`, que aqui não servem a nada e ainda teriam efeito colateral. Nenhum `.jsonl` é
escrito: sem mensagem de usuário, não nasce transcript.

Só stdlib, como o irmão do Codex.
"""
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

_TIMEOUT = 30.0


class ClaudeIndisponivel(RuntimeError):
    """O processo não pôde responder ao pedido."""


class ClaudeAusente(ClaudeIndisponivel):
    """`claude` não está no PATH deste backend — ausência do binário, não falha do comando."""


def _binario() -> str:
    exe = shutil.which("claude")
    if exe is None:
        raise ClaudeAusente("nao achei o executavel `claude` no PATH deste servidor")
    return exe


def listar(config_dir: str | Path | None = None, timeout: float = _TIMEOUT) -> list[dict]:
    """Os modelos da conta em `config_dir` (None = a padrão), no formato cru do `list_models`.

    O `initialize` vai junto porque o `list_models` só é atendido depois dele (mesma ordem do
    handshake da sessão viva). O stdin fica ABERTO até a resposta chegar, pela lição que o Codex já
    tinha dado: fechado junto com a entrada, o processo sai com rc=0 antes do segundo pedido.
    """
    argv = [_binario(), "-p", "--output-format", "stream-json", "--input-format", "stream-json",
            "--verbose",
            # Vazio de propósito: sem settings não rodam os hooks de SessionStart. São 3,4s dos 4,3s
            # medidos, e nenhum deles muda a lista — ela vem da conta, não da config.
            "--setting-sources", ""]
    env = dict(os.environ)
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = str(Path(config_dir).expanduser())
    # Backend subido de dentro de um tmux (dev) passaria o pane do operador adiante.
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    try:
        proc = subprocess.Popen(
            argv, cwd=str(Path.home()), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1,
            env=env)
    except OSError as exc:
        raise ClaudeIndisponivel(f"claude nao iniciou: {exc}") from exc
    # Mata em vez de embrulhar o `readline`: conta deslogada deixa o processo pendurado esperando
    # login, e quem paga é a tela de abertura de quem pediu.
    carrasco = threading.Timer(timeout, proc.kill)
    carrasco.daemon = True
    carrasco.start()
    try:
        proc.stdin.write("\n".join([
            json.dumps({"type": "control_request", "request_id": "hangar_cat_1",
                        "request": {"subtype": "initialize"}}),
            json.dumps({"type": "control_request", "request_id": "hangar_cat_2",
                        "request": {"subtype": "list_models"}}),
        ]) + "\n")
        proc.stdin.flush()
        for linha in proc.stdout:
            try:
                ev = json.loads(linha)
            except ValueError:
                continue  # o stream também carrega log e notificação; linha torta não é erro
            if not isinstance(ev, dict) or ev.get("type") != "control_response":
                continue
            r = ev.get("response") or {}
            if r.get("request_id") != "hangar_cat_2":
                continue
            if r.get("subtype") == "error":
                raise ClaudeIndisponivel(f"claude recusou list_models: {r.get('error')}")
            modelos = [m for m in ((r.get("response") or {}).get("models") or [])
                       if isinstance(m, dict) and m.get("value")]
            if not modelos:
                # Zero modelo é falha do provedor (login vencido, schema novo), não "sua conta não
                # tem modelo". Estoura pra quem chamou cair no fallback em vez de CACHEAR o vazio.
                raise ClaudeIndisponivel("claude nao devolveu modelo nenhum em list_models")
            return modelos
        # Mata ANTES de ler o stderr: o `read()` vai até o EOF, e um processo vivo penduraria
        # justamente o caminho de falha.
        proc.kill()
        detalhe = (proc.stderr.read() or "").strip()[-500:]
        raise ClaudeIndisponivel(detalhe or "claude nao respondeu list_models")
    except OSError as exc:
        raise ClaudeIndisponivel(f"claude perdeu o transporte: {exc}") from exc
    finally:
        carrasco.cancel()
        proc.kill()
        proc.wait()


def para_tela(modelos: list[dict], atual: str | None = None) -> list[dict]:
    """A resposta do `list_models` no formato do `ModelOption` da tela."""
    return [{"id": m.get("value"), "name": m.get("displayName") or m.get("value"),
             "desc": m.get("description") or "",
             # Sem escolha gravada, a CLI usa o "default" dela.
             "active": (atual in (m.get("value"), m.get("resolvedModel"))) if atual
                       else m.get("value") == "default"}
            for m in modelos if m.get("value")]
