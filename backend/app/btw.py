"""Pergunta lateral (`/btw`) numa sessão Claude de terminal.

O `/btw` do Claude Code responde num overlay da TUI e não grava a resposta em lugar nenhum
(só a pergunta vai pro `history.jsonl`). O que a TUI oferece é a tecla `c`, que copia a
resposta INTEIRA por OSC 52 — e o tmux guarda isso num buffer. É daí que a resposta sai:
sem corte na largura da janela e sem rolar o overlay. O overlay aceita o `/btw` no meio de um
turno, e o Esc que o fecha não interrompe o turno principal.
"""

import json
import logging
import time
from pathlib import Path

from app import tmux
from app.config import settings
from app.pqueue import _sanitize
from app.terminal_input import _SETTLE, _esvaziar_composer_claude, _pane_tail, _send_lock

_log = logging.getLogger(__name__)

# Rodapé do overlay: `· Answering…` enquanto responde; `c to copy` só quando a resposta terminou.
_PRONTO = "c to copy"
_ABERTO = "Esc to close"
_COPIADO = "Copied to clipboard"
_POLL = 0.3
_PRAZO_ABRIR = 6.0
_PRAZO_COPIA = 3.0
_RODAPE_LINHAS = 3
MAX_HISTORICO = 50


class BtwError(RuntimeError):
    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


def _rodape(name: str) -> str:
    return _pane_tail(tmux.capture_pane(name, lines=60), _RODAPE_LINHAS)


def _buffers() -> list[str]:
    cp = tmux._run(["tmux", "list-buffers", "-F", "#{buffer_name}"])
    return [b for b in (cp.stdout or "").split("\n") if b]


def _resposta_do_pane(name: str, pergunta: str) -> str:
    """Plano B (multiplexador que não vira OSC 52 em buffer): o overlay como está na tela."""
    linhas = tmux.capture_pane(name, lines=200).rstrip("\n").split("\n")
    inicio = next((i for i in range(len(linhas) - 1, -1, -1)
                   if linhas[i].strip().startswith("/btw ")), None)
    fim = next((i for i in range(len(linhas) - 1, -1, -1) if _ABERTO in linhas[i]), None)
    if inicio is None or fim is None or fim <= inicio:
        return ""
    return "\n".join(l[6:] if l.startswith("      ") else l.strip() for l in linhas[inicio + 1:fim]).strip()


def perguntar(name: str, pergunta: str, timeout: float = 120.0) -> dict:
    """Digita `/btw <pergunta>`, espera a resposta, copia pelo `c`, fecha o overlay e devolve.

    Segura o `_send_lock` da sessão o tempo todo: um drain da fila digitando no meio do overlay
    cairia dentro dele. Um Enter só — o `/btw` é imediato, e um 2º Enter num overlay já aberto
    seria tecla dentro dele.
    """
    pergunta = " ".join(pergunta.split())
    if not pergunta:
        raise BtwError(400, "erro_btw_vazia", "pergunta vazia")
    with _send_lock(name):
        _esvaziar_composer_claude(name)
        tmux.send_keys(name, "/btw " + pergunta, literal=True)
        time.sleep(_SETTLE)
        tmux.send_keys(name, "Enter")

        inicio = time.monotonic()
        aberto = False
        while True:
            time.sleep(_POLL)
            rodape = _rodape(name)
            if _ABERTO in rodape:
                aberto = True
                if _PRONTO in rodape:
                    break
            decorrido = time.monotonic() - inicio
            if not aberto and decorrido > _PRAZO_ABRIR:
                raise BtwError(409, "erro_btw_nao_abriu", "o /btw não abriu no terminal da sessão")
            if decorrido > timeout:
                tmux.send_keys(name, "Escape")
                raise BtwError(504, "erro_btw_sem_resposta", "o /btw não respondeu a tempo")

        antes = set(_buffers())
        tmux.send_keys(name, "c")
        fim = time.monotonic() + _PRAZO_COPIA
        novo = None
        while time.monotonic() < fim:
            time.sleep(_POLL)
            novo = next((b for b in _buffers() if b not in antes), None)
            if novo or _COPIADO in _rodape(name):
                break
        if novo:
            resposta = tmux._run(["tmux", "show-buffer", "-b", novo]).stdout or ""
            tmux._run(["tmux", "delete-buffer", "-b", novo])
            fonte = "buffer"
        else:
            resposta = _resposta_do_pane(name, pergunta)
            fonte = "pane"
            _log.warning("btw de %r: OSC 52 não virou buffer; resposta lida do pane", name)
        tmux.send_keys(name, "Escape")
        time.sleep(_SETTLE)  # overlay ainda fechando engolia o próximo `/btw` digitado em seguida
    resposta = resposta.rstrip("\n")
    if not resposta:
        raise BtwError(502, "erro_btw_ilegivel", "o /btw respondeu, mas não consegui ler a resposta")
    return {"question": pergunta, "answer": resposta, "fonte": fonte, "ts": time.time()}


def _arquivo(name: str) -> Path:
    d = Path(settings.projects_dir).parent / ".hangar-btw"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{_sanitize(name)}.jsonl"


def registrar(name: str, item: dict) -> None:
    with _arquivo(name).open("a", encoding="utf-8") as f:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")


def historico(name: str) -> list[dict]:
    p = _arquivo(name)
    if not p.exists():
        return []
    itens = []
    for linha in p.read_text(encoding="utf-8").split("\n"):
        if linha.strip():
            try:
                itens.append(json.loads(linha))
            except ValueError:
                continue
    return itens[-MAX_HISTORICO:]
