"""Pergunta lateral (`/btw`) numa sessão Claude de terminal.

O `/btw` do Claude Code responde num overlay da TUI e não grava a resposta em lugar nenhum
(só a pergunta vai pro `history.jsonl`). O que a TUI oferece é a tecla `c`, que copia a
resposta INTEIRA por OSC 52 — e o tmux guarda isso num buffer. É daí que a resposta sai:
sem corte na largura da janela e sem rolar o overlay. O overlay aceita o `/btw` no meio de um
turno, e o Esc que o fecha não interrompe o turno principal.
"""

import json
import logging
import threading
import time
from pathlib import Path

from app import tmux
from app.config import settings
from app.pqueue import _sanitize
from app.terminal_input import (_SETTLE, _esvaziar_composer_claude, _pane_tail, _send_lock,
                                _texto_composer_claude)

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
# Buffers do tmux são do SERVIDOR, não do pane: dois `c` em sessões diferentes na mesma janela
# trocariam as respostas. O `_send_lock` é por sessão, então o trecho "c → achar → apagar" tem
# trava própria, global.
_COPIA_LOCK = threading.Lock()


class BtwError(RuntimeError):
    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


def _rodape(name: str) -> str:
    return _pane_tail(tmux.capture_pane(name, lines=60), _RODAPE_LINHAS)


def _limpar_composer_as_cegas(name: str) -> None:
    """Às cegas: com a tela desalinhada a leitura não vê o resto, e o próximo envio normal sairia
    grudado nele. C-u num composer vazio não faz nada."""
    for _ in range(3):
        if not tmux.send_keys(name, "C-u"):
            _log.warning("btw de %r: o C-u da limpeza não chegou ao terminal; pode ter sobrado texto "
                         "no composer", name)


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


def perguntar(name: str, pergunta: str, timeout: float = 60.0) -> dict:
    """Digita `/btw <pergunta>`, espera a resposta, copia pelo `c`, fecha o overlay e devolve.

    Segura o `_send_lock` da sessão o tempo todo: um drain da fila digitando no meio do overlay
    cairia dentro dele. O custo é que um envio normal pra ESTA sessão espera a resposta — por
    isso o teto é curto (respostas normais levam segundos) e o overlay que some por fora aborta
    na hora, sem esperar o teto. Roda fora do pool de envio (`_send_thread`) de propósito: um
    worker de lá preso por um minuto derrubaria o envio de todas as sessões.
    Um Enter só — o `/btw` é imediato, e um 2º Enter num overlay já aberto seria tecla dentro dele.
    """
    pergunta = " ".join(pergunta.split())
    if not pergunta:
        raise BtwError(400, "erro_btw_vazia", "pergunta vazia")
    with _send_lock(name):
        # Overlay de uma pergunta anterior ainda fechando: digitar agora perdia a `/` e a TUI
        # desenhava o texto em cima da régua (medido ao vivo, pergunta logo depois de outra).
        fim_espera = time.monotonic() + _PRAZO_ABRIR
        while _ABERTO in _rodape(name):
            if time.monotonic() >= fim_espera:
                # Preso aberto (um /btw feito à mão no terminal): digitar agora cairia dentro dele.
                raise BtwError(409, "erro_btw_overlay_aberto",
                               "há um /btw aberto no terminal da sessão; feche antes de perguntar")
            time.sleep(_POLL)
        _esvaziar_composer_claude(name)
        # Texto que sobrou no composer viraria "<rascunho>/btw …" submetido como MENSAGEM real
        # pelo Enter abaixo. Ilegível (None) segue, como o envio normal.
        if _texto_composer_claude(name):
            raise BtwError(409, "erro_btw_composer_ocupado",
                           "há texto parado no terminal da sessão; envie ou apague antes")
        # Confere o composer ANTES do Enter: no Windows a `/` inicial sumiu e o Enter submeteu
        # "btw <pergunta>" como mensagem da conversa (o overlay nunca abriu). Uma segunda tentativa;
        # errado de novo, apaga e para sem Enter. Vazio ou ilegível seguem, como antes.
        for tentativa in range(2):
            if not tmux.send_keys(name, "/btw " + pergunta, literal=True):
                raise BtwError(502, "erro_btw_nao_digitou", "não consegui digitar o /btw no terminal da sessão")
            time.sleep(_SETTLE)
            digitado = _texto_composer_claude(name)
            if digitado is None:
                # Ilegível não confirma nada: com Enter às cegas a pergunta podia cair na conversa.
                time.sleep(_SETTLE)
                digitado = _texto_composer_claude(name)
                if digitado is None:
                    _log.warning("btw de %r: composer ilegível depois de digitar; parado sem Enter", name)
                    _limpar_composer_as_cegas(name)
                    raise BtwError(502, "erro_btw_composer_ilegivel",
                                   "não consegui conferir o /btw digitado; nada foi enviado pra conversa")
            if digitado == "" or digitado.startswith("/btw"):
                break
            _log.warning("btw de %r: o composer recebeu sem a barra (%d/2); apagando", name, tentativa + 1)
            _esvaziar_composer_claude(name)
        else:
            _limpar_composer_as_cegas(name)
            raise BtwError(502, "erro_btw_barra_perdida",
                           "o terminal perdeu a / do /btw; nada foi enviado pra conversa")
        if not tmux.send_keys(name, "Enter"):
            # Sem isto o Enter perdido só aparecia 6s depois como "não abriu", culpando o overlay.
            _limpar_composer_as_cegas(name)
            raise BtwError(502, "erro_btw_enter_nao_enviado",
                           "o Enter do /btw não chegou ao terminal; nada foi enviado pra conversa")

        inicio = time.monotonic()
        aberto = False
        while True:
            time.sleep(_POLL)
            rodape = _rodape(name)
            if _ABERTO in rodape:
                aberto = True
                if _PRONTO in rodape:
                    break
            elif aberto:
                # Alguém fechou o overlay por fora (Esc no terminal, interrupt do app). Sem overlay
                # não há resposta pra ler — e um Esc nosso agora cairia no turno principal.
                raise BtwError(409, "erro_btw_fechado", "o /btw foi fechado no terminal antes de eu ler a resposta")
            decorrido = time.monotonic() - inicio
            if not aberto and decorrido > _PRAZO_ABRIR:
                raise BtwError(409, "erro_btw_nao_abriu", "o /btw não abriu no terminal da sessão")
            if decorrido > timeout:
                tmux.send_keys(name, "Escape")
                raise BtwError(504, "erro_btw_sem_resposta", "o /btw não respondeu a tempo")

        with _COPIA_LOCK:
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
        if novo:
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


def _linhas(p: Path) -> list[str]:
    if not p.exists():
        return []
    return [l for l in p.read_text(encoding="utf-8").split("\n") if l.strip()]


def registrar(name: str, item: dict) -> None:
    p = _arquivo(name)
    linhas = _linhas(p) + [json.dumps(item, ensure_ascii=False)]
    p.write_text("\n".join(linhas[-MAX_HISTORICO:]) + "\n", encoding="utf-8")


def historico(name: str) -> list[dict]:
    itens = []
    for linha in _linhas(_arquivo(name)):
        try:
            itens.append(json.loads(linha))
        except ValueError:
            continue
    return itens[-MAX_HISTORICO:]
