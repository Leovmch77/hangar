"""Caminho NATIVO de entrada nas sessões Claude: o function-hook do plugin `hangar`.

O que muda em relação ao pane: o texto não é digitado. O plugin mantém um
long-poll aberto aqui e entrega por `$.prompt.submit`, a mesma chamada que o
engine faz para um prompt digitado. A fila durável, a poda e o claim continuam
sendo do `pqueue`/`terminal_input.drain` — aqui é só o transporte.

Fallback é por AUSÊNCIA, não por erro: sem um long-poll vivo para a sessão,
`aguardando()` é falso e o `drain` segue pelo caminho de tecla de sempre. Vale
para toda sessão que não é Claude, para a que nasceu antes do flag e para a
que carregou o plugin e ele morreu.

A identidade é o `CP_SESSION_NAME` que o pane já carrega, e o segredo é um
token por sessão cunhado no nascimento — o bearer do app NUNCA entra no
ambiente do pane.
"""
import asyncio
import hashlib
import hmac
import logging
import secrets
import shutil
import subprocess
import threading
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

_log = logging.getLogger("hangar.plugin_bridge")

plugin_router = APIRouter(prefix="/api/plugin")

# Quanto o backend segura o long-poll antes de responder 204. Curto o bastante
# para a morte da sessão aparecer, longo o bastante para a espera não virar poll.
ESPERA_S = 25.0

_lock = threading.Lock()
_waiters: dict[str, asyncio.Queue] = {}
_loop: asyncio.AbstractEventLoop | None = None


# Capacidade do CLI, não versão: o número seria um palpite sobre qual release ganhou a flag, e
# quem derruba a sessão é a flag desconhecida — `claude --plugin-dir` inexistente sai com erro e o
# pane morre no nascimento, com o `tmux new-session` ainda devolvendo 0 (o app reportaria sucesso).
# `--help` custa 0,20 s (medido) e responde direto; o cache evita pagar isso a cada sessão.
_TTL_CAPACIDADE_S = 600.0
_capacidade: tuple[float, bool] | None = None


def aceita_plugin_dir() -> bool:
    """O `claude` desta máquina conhece `--plugin-dir`? Em cache, com prazo."""
    global _capacidade
    if _capacidade is not None and time.monotonic() - _capacidade[0] < _TTL_CAPACIDADE_S:
        return _capacidade[1]
    exe = shutil.which("claude")
    ok = False
    if exe:
        try:
            r = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=10,
                               encoding="utf-8", errors="replace")
            ok = "--plugin-dir" in (r.stdout or "")
        except (OSError, subprocess.SubprocessError) as e:
            # Sonda que não respondeu vira NÃO: o preço de errar para o não é o caminho de sempre,
            # e o de errar para o sim é sessão que não nasce.
            _log.warning("plugin: `claude --help` falhou: %r", e)
    _capacidade = (time.monotonic(), ok)
    return ok


def esquecer_capacidade() -> None:
    """Descarta a sonda. Quem acabou de atualizar o CLI precisa disto."""
    global _capacidade
    _capacidade = None


def ligado() -> bool:
    """Mesmo interruptor do `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`: sem function hook
    na sessão não há plugin para ouvir, e o caminho novo não existe.

    Com o interruptor ligado ainda é preciso o CLI aceitar `--plugin-dir`; sem isso a sessão
    sequer nasceria, e a promessa aqui é que o caminho novo degrade para o tmux, nunca quebre."""
    from app import runtime_config
    return bool(runtime_config.get("claude_function_hooks")) and aceita_plugin_dir()


def raizes_dos_plugins() -> list[str]:
    """O plugin do caminho nativo, ou nada com o portão fechado."""
    if not ligado():
        return []
    from pathlib import Path
    return [str(Path(__file__).resolve().parents[2] / "plugins" / "hangar")]


def env_da_sessao(name: str) -> dict[str, str]:
    """O que o pane precisa para achar a ponte: endereço e o token DESTA sessão.

    O bearer do app não entra aqui — quem roda dentro do pane não é o app."""
    if not ligado():
        return {}
    from app.config import settings
    return {
        "HANGAR_PLUGIN_URL": f"http://127.0.0.1:{settings.port}/api/plugin",
        "HANGAR_PLUGIN_TOKEN": mint(name),
    }


def mint(name: str) -> str:
    """Token desta sessão, para o `-e` do pane.

    DERIVADO, não sorteado: sorteado ele viveria só na memória do backend, e todo restart deixava
    a sessão viva batendo 403 para sempre — o envio caía no tmux (certo), mas o caminho nativo só
    voltava recriando a sessão (medido em 18/09/2026). O segredo do servidor é estável, então o
    valor se refaz igual depois do restart.

    Não é o bearer do app: é um HMAC dele, de mão única, e é ele que vai para o ambiente do pane.
    Sessão recriada com o MESMO nome recebe o mesmo token, o que é aceitável — quem responde por
    aquele nome é uma sessão só, e a anterior já morreu.
    """
    from app.config import settings
    segredo = (settings.auth_token or "hangar").encode()
    return hmac.new(segredo, f"plugin:{name}".encode(), hashlib.sha256).hexdigest()[:32]


def esquecer(name: str) -> None:
    with _lock:
        _waiters.pop(name, None)
        _estados.pop(name, None)
        _perguntas.pop(name, None)
        _batidas.pop(name, None)
        _fechadas.pop(name, None)
        _sugestoes.pop(name, None)
        _confirmacoes.pop(name, None)
        _preenchido.pop(name, None)
    _eventos.pop(name, None)


def _confere(name: str, token: str) -> None:
    if not secrets.compare_digest(mint(name), token):
        raise HTTPException(403, detail="token do plugin invalido")


def aguardando(name: str) -> bool:
    """Há um long-poll ABERTO para esta sessão agora?

    É o gate do caminho feliz. Falso enquanto o plugin processa uma entrega
    anterior — e isso é de propósito: nesse instante ele não pode receber outra,
    e a fila espera o próximo poll em vez de cair para a tecla no meio do caminho.
    """
    with _lock:
        return name in _waiters


# Como o texto entra na sessão:
#  - `submit`: `$.prompt.submit`, sem tecla nenhuma. O engine carimba a origem
#    `plugin` e ENVOLVE a mensagem numa moldura ("The hangar plugin sent a
#    message: …") que nenhum hook consegue tirar — medido, o engine recusa.
#  - `fill`: `$.prompt.fill` põe o rascunho no composer e o Hangar manda SÓ o
#    Enter pelo tmux. A origem vira a do usuário, sem moldura, e o `send-keys`
#    deixa de digitar o texto — a parte que hoje fatia, espera e às vezes corta.
MODO_PADRAO = "fill"

# Teto da espera pelo aviso de que o rascunho entrou. Passou disso, o Enter NÃO
# é enviado: apertar Enter num composer que não recebeu o texto submete o que
# estiver lá — ou nada.
CONFIRMA_S = 5.0

_confirmacoes: dict[str, threading.Event] = {}
_preenchido: dict[str, bool] = {}

# Último estado que o plugin anunciou, por sessão: (momento, estado, motivo).
_estados: dict[str, tuple[float, str, str | None]] = {}

# A frase que a TUI propõe depois do turno. Não há evento de DESCARTE — se a pessoa digita por
# cima, nada avisa —, então quem a apaga é o começo do turno seguinte.
_sugestoes: dict[str, str] = {}


def sugestao(name: str) -> str:
    """A sugestão viva desta sessão, ou string vazia."""
    with _lock:
        return _sugestoes.get(name, "")

# Depois disso a leitura do pane volta a mandar sozinha. O plugin não repete estado — ele avisa
# transição —, então o prazo cobre uma sessão parada em `idle` por horas: o que expira aqui é a
# CONFIANÇA de que o plugin ainda está vivo, e quem a renova é a batida do long-poll.
VALIDADE_ESTADO_S = 90.0


# Quantos SSE do app (lista ou conversa) estão abertos agora. Pedido de permissão só é segurado
# pelo plugin com alguém no app para responder.
_apps_abertos = 0


def app_entrou() -> None:
    global _apps_abertos
    with _lock:
        _apps_abertos += 1


def app_saiu() -> None:
    global _apps_abertos
    with _lock:
        _apps_abertos = max(0, _apps_abertos - 1)


def app_presente() -> bool:
    with _lock:
        return _apps_abertos > 0


def terminal_preso(name: str) -> bool:
    """Há cliente tmux preso nesta sessão (terminal de verdade ou o painel do app)?

    Na dúvida é SIM: errar para o sim só devolve o diálogo ao terminal, que é o de sempre; errar
    para o não esconderia o pedido de permissão de quem está olhando o terminal."""
    from app import tmux
    try:
        cp = tmux._run(["tmux", "list-clients", "-t", f"={name}", "-F", "#{client_tty}"])
    except Exception:
        return True
    if cp.returncode != 0:
        return True
    return bool((cp.stdout or b"").strip())


# Última batida do long-poll de entrada, por sessão: é o pulso que diz que o plugin está vivo.
_batidas: dict[str, float] = {}
# Um por sessão, criado por quem espera (o monitor de estado). Aviso do plugin acorda o monitor na
# hora, em vez de a transição esperar o próximo tique do pane.
_eventos: dict[str, asyncio.Event] = {}


def vivo(name: str) -> bool:
    """O plugin desta sessão bateu aqui há pouco?"""
    with _lock:
        if name in _waiters:
            return True
        quando = _batidas.get(name)
    return quando is not None and time.monotonic() - quando < ESPERA_S + 10


async def esperar_evento(name: str, timeout: float) -> None:
    """Dorme até o plugin avisar algo desta sessão, ou até `timeout`. Só no loop do servidor."""
    ev = _eventos.setdefault(name, asyncio.Event())
    try:
        await asyncio.wait_for(ev.wait(), timeout)
    except asyncio.TimeoutError:
        pass
    ev.clear()


def _acordar(name: str) -> None:
    ev = _eventos.get(name)
    if ev is not None:
        ev.set()


def estado_recente(name: str) -> tuple[str, str | None] | None:
    """O estado anunciado pelo plugin, se ainda válido. None = o pane que decida."""
    with _lock:
        hit = _estados.get(name)
        vivo = name in _waiters
    if hit is None:
        return None
    quando, estado, motivo = hit
    if not vivo and time.monotonic() - quando > VALIDADE_ESTADO_S:
        return None
    return estado, motivo


def entregar(name: str, texto: str, modo: str = MODO_PADRAO) -> bool:
    """Passa o texto ao long-poll da sessão. False = ninguém ouvindo (usa o pane).

    Chamado de dentro do `drain`/`_send_one`, que rodam em thread: o Queue é do
    loop do FastAPI, então a entrega atravessa por `call_soon_threadsafe`.

    Roda inteiro sob o `_send_lock` da sessão: o Enter, a conferência e a limpeza tocam o mesmo
    composer que o `send_prompt`, e a confirmação do rascunho é UMA por sessão — duas entregas
    juntas roubariam o aviso uma da outra.
    """
    from app import terminal_input
    with terminal_input._send_lock(name):
        return _entregar(name, texto, modo)


def _entregar(name: str, texto: str, modo: str) -> bool:
    with _lock:
        fila = _waiters.get(name)
        loop = _loop
    if fila is None or loop is None:
        return False
    aviso = threading.Event()
    if modo == "fill":
        with _lock:
            _confirmacoes[name] = aviso
            _preenchido.pop(name, None)
    try:
        loop.call_soon_threadsafe(fila.put_nowait, {"text": texto, "modo": modo})
    except RuntimeError:
        # Loop morrendo (shutdown): não é entrega, e o caller tem o pane.
        return False
    if modo != "fill":
        return True
    confirmou = aviso.wait(CONFIRMA_S)
    with _lock:
        ok = _preenchido.pop(name, False)
        _confirmacoes.pop(name, None)
    if not confirmou:
        _log.warning("plugin %s: rascunho sem confirmação em %.0fs — sem Enter", name, CONFIRMA_S)
    from app import terminal_input, tmux
    if not confirmou or not ok:
        # O rascunho pode ter entrado mesmo sem o aviso chegar. Quem assume daqui é o caminho de
        # tecla, que digitaria EM CIMA do resíduo e concatenaria as duas coisas — o mesmo estrago
        # que o tratamento de envio parcial existe pra evitar. Limpa antes de devolver.
        terminal_input._limpar_composer(name, texto, None)
        return False
    if not tmux.send_keys(name, "Enter"):
        terminal_input._limpar_composer(name, texto, None)
        return False
    # O Enter SAIR não é o mesmo que a mensagem ENTRAR: o composer pode ter perdido o foco, ou um
    # overlay pode ter subido entre o rascunho e a tecla. Sem esta conferência a entrada era marcada
    # como entregue com o texto parado no campo — mensagem perdida do ponto de vista da fila, que é
    # o pior defeito possível aqui. Mesma prova que o caminho de tecla já usava.
    if not terminal_input._submeteu(name, texto):
        _log.warning("plugin %s: Enter não submeteu — devolvendo pro caminho de tecla", name)
        terminal_input._limpar_composer(name, texto, None)
        return False
    return True


class PullBody(BaseModel):
    sessao: str
    token: str


class StateBody(BaseModel):
    sessao: str
    token: str
    estado: str
    cwd: str | None = None
    model: str | None = None
    motivo: str | None = None
    tool: str | None = None
    origin: str | None = None


@plugin_router.post("/pull")
async def pull(body: PullBody):
    """Long-poll do plugin. Sempre 200: com o texto, ou `{"text": null}` quando a janela fecha vazia.

    Sem `Depends(require_auth)`: quem chama é o pane, que não tem o bearer do
    app. O token por sessão é a credencial daqui.
    """
    _confere(body.sessao, body.token)
    global _loop
    fila: asyncio.Queue = asyncio.Queue()
    with _lock:
        _loop = asyncio.get_running_loop()
        _waiters[body.sessao] = fila
        _batidas[body.sessao] = time.monotonic()
    try:
        entrega = await asyncio.wait_for(fila.get(), timeout=ESPERA_S)
    except asyncio.TimeoutError:
        return {"text": None}
    finally:
        with _lock:
            _batidas[body.sessao] = time.monotonic()
            if _waiters.get(body.sessao) is fila:
                del _waiters[body.sessao]
    return entrega


class SuggestBody(BaseModel):
    sessao: str
    token: str
    texto: str
    mostrada: bool


@plugin_router.post("/suggest")
async def suggest(body: SuggestBody):
    """A frase que a TUI propõe depois do turno (Tab aceita, no terminal).

    Medição antes de virar recurso: só registra, para responder se ela é regerada
    todo turno e o que acontece quando é descartada."""
    _confere(body.sessao, body.token)
    with _lock:
        # `mostrada=False` é proposta que a TUI não pôs na caixa (diálogo aberto, headless): mostrar
        # no app o que nem o terminal mostrou seria inventar estado.
        _sugestoes[body.sessao] = body.texto if body.mostrada else ""
    return {"ok": True}


# Pergunta de múltipla escolha que o hook de `tool.call` segura: o diálogo do terminal e o app
# correm juntos, e a entrada sobrevive ao intervalo entre dois long-polls (só a fila troca).
_perguntas: dict[str, dict] = {}


def pergunta_pendente(name: str) -> dict | None:
    """A pergunta que o plugin segura agora (`id`, `questions`), ou None.

    Só vale com o long-poll batendo: hook que morreu não pode segurar a resposta do app."""
    with _lock:
        p = _perguntas.get(name)
        if p is None or time.monotonic() - p["visto"] > ESPERA_S + 10:
            return None
        return {"id": p["id"], "questions": p["questions"], "tool": p.get("tool"),
                "resumo": p.get("resumo")}


# Última pergunta fechada por sessão: (id, quem fechou). Resposta repetida (toque duplo, retry do
# cliente) para uma pergunta que o APP já fechou é entrega feita — cair na tecla a mandaria de novo.
_fechadas: dict[str, tuple[str, str]] = {}


def responder_pergunta(name: str, corpo: dict, id: str | None = None) -> bool:
    """Entrega a resposta do app ao hook. False = ele não pegou; quem chama cai na tecla.

    `id` é a pergunta que quem chama leu em `pergunta_pendente`: outra pergunta no lugar não recebe
    esta resposta."""
    with _lock:
        p = _perguntas.get(name)
        loop = _loop
        if p is None or loop is None or (id is not None and p["id"] != id):
            return id is not None and _fechadas.get(name) == (id, "app")
        aviso = p.get("aviso")
        primeiro = aviso is None
        fila = None
        if primeiro:
            aviso = p["aviso"] = threading.Event()
            fila = p.get("fila")
            if fila is None:
                p["resposta"] = corpo
    if fila is not None:
        try:
            loop.call_soon_threadsafe(fila.put_nowait, corpo)
        except RuntimeError:
            return False
    # Segunda resposta com a primeira em voo espera o MESMO aviso: uma pergunta, um veredito.
    pegou = aviso.wait(CONFIRMA_S)
    if primeiro:
        with _lock:
            p = _perguntas.get(name)
            if p is not None and p.get("aviso") is aviso:
                p.pop("aviso", None)
                p.pop("resposta", None)
    return pegou


class AskBody(BaseModel):
    sessao: str
    token: str
    id: str
    questions: list | None = None
    # Pedido de permissão: sem perguntas, só a ferramenta que pede.
    tool: str | None = None
    # Quanto o hook aceita esperar; sem isto vale a janela do long-poll.
    janela_ms: int | None = None
    # O que a ferramenta quer rodar (o comando do Bash, o arquivo do Edit), para o card do app.
    resumo: str | None = None


@plugin_router.post("/ask")
async def ask(body: AskBody):
    """Long-poll do hook do AskUserQuestion: 200 com a resposta do app, ou vazio na janela."""
    _confere(body.sessao, body.token)
    global _loop
    # Permissão só fica com o plugin enquanto há alguém no app E ninguém no terminal: segurar
    # esconde o diálogo do terminal. Reavaliado a cada poll do hook, então prender um terminal no
    # meio da espera devolve o diálogo a ele em poucos segundos.
    if body.id.startswith("perm:") and (
            not app_presente() or await asyncio.to_thread(terminal_preso, body.sessao)):
        with _lock:
            p = _perguntas.get(body.sessao)
            if p is not None and p["id"] == body.id:
                del _perguntas[body.sessao]
        _acordar(body.sessao)
        return {"soltar": True}
    fila: asyncio.Queue = asyncio.Queue()
    with _lock:
        _loop = asyncio.get_running_loop()
        p = _perguntas.get(body.sessao)
        if p is None or p["id"] != body.id:
            p = _perguntas[body.sessao] = {"id": body.id, "questions": body.questions or [],
                                           "tool": body.tool, "resumo": body.resumo}
        p["visto"] = time.monotonic()
        guardada = p.pop("resposta", None)
        if guardada is None:
            p["fila"] = fila
    _acordar(body.sessao)
    if guardada is not None:
        return guardada
    espera = min(ESPERA_S, body.janela_ms / 1000) if body.janela_ms else ESPERA_S
    try:
        return await asyncio.wait_for(fila.get(), timeout=espera)
    except asyncio.TimeoutError:
        return {"answers": None}
    finally:
        with _lock:
            p = _perguntas.get(body.sessao)
            if p is not None and p.get("fila") is fila:
                p.pop("fila", None)
                p["visto"] = time.monotonic()


class AskFimBody(BaseModel):
    sessao: str
    token: str
    id: str
    vencedor: str


@plugin_router.post("/ask-fim")
async def ask_fim(body: AskFimBody):
    """A pergunta fechou. `vencedor=app` é a prova de que a resposta do app valeu."""
    _confere(body.sessao, body.token)
    with _lock:
        p = _perguntas.get(body.sessao)
        if p is None or p["id"] != body.id:
            return {"ok": True}
        del _perguntas[body.sessao]
        _fechadas[body.sessao] = (body.id, body.vencedor)
        fila, aviso = p.get("fila"), p.get("aviso")
    if fila is not None:
        fila.put_nowait({"answers": None})
    if aviso is not None and body.vencedor == "app":
        aviso.set()
    _acordar(body.sessao)
    _log.info("plugin pergunta sessao=%s fechou por %s", body.sessao, body.vencedor)
    return {"ok": True}


class FilledBody(BaseModel):
    sessao: str
    token: str
    ok: bool


@plugin_router.post("/filled")
async def filled(body: FilledBody):
    """O plugin avisa que o rascunho entrou (ou não) no composer.

    É o que libera o Enter: sem esse aviso o Hangar não aperta tecla nenhuma."""
    _confere(body.sessao, body.token)
    with _lock:
        aviso = _confirmacoes.get(body.sessao)
        _preenchido[body.sessao] = body.ok
    if aviso is not None:
        aviso.set()
    return {"ok": True}


@plugin_router.post("/state")
async def state(body: StateBody, request: Request):
    """Estado por EVENTO, sem `capture-pane`.

    Hoje só registra: quem manda no rótulo continua sendo o monitor de
    `state.py`, que atende os outros provedores também. Ligar as duas fontes é
    passo separado, e ele não pode nascer junto com a troca do caminho de entrada.
    """
    _confere(body.sessao, body.token)
    with _lock:
        _estados[body.sessao] = (time.monotonic(), body.estado, body.motivo)
        if body.estado == "working":
            # Turno novo aposenta a sugestão do anterior — é o que substitui o evento de descarte
            # que o engine não dá.
            _sugestoes.pop(body.sessao, None)
    _acordar(body.sessao)
    _log.debug("plugin estado sessao=%s estado=%s motivo=%s", body.sessao, body.estado, body.motivo)
    return {"ok": True}
