"""Porteiro da porta do convidado (8766): só ela é exposta na internet, pelo Funnel.

O filtro delimita a INTERFACE do convidado, não é fronteira de segurança: quem entra numa
sessão em bypass já roda comando como o dono (ver a spec de compartilhar sessão).
"""
import asyncio
import contextlib
import time
from urllib.parse import parse_qs

from starlette.responses import JSONResponse
from starlette.websockets import WebSocket

from app import share_api, share_store
from app.mensagens import erro
from app.share_life import session_life
from app.share_tunnel import GUEST_PORT

GUEST_SCOPE_KEY = "hangar_guest"

_LIST_ROUTES = {("GET", "/api/sessions"), ("GET", "/api/sessions/events")}
_GLOBAL_ROUTES = {
    ("GET", "/api/model-options"),
    ("GET", "/api/engines"),
    ("GET", "/api/harness/codex/opcoes"),
    ("POST", "/api/ditado/relimpar"),
    ("POST", "/api/pensamento/pt"),
    ("POST", "/api/tts"),
    ("POST", "/api/tts/narrar"),
}
_GLOBAL_PREFIXES = (("GET", "/api/tts/audio/"),)
# Alcançam outra sessão do dono ou abrem janela na tela dele; `share` deixaria o convidado
# criar e revogar convites.
_BLOCKED = {"pair", "pair-remote", "unpair-remote", "group-message", "then", "orq", "bastao",
            "open-terminal", "open-editor", "nav", "share"}

# ponytail: cache de 2 s por nome; cada consulta de vida é um fork do tmux, e o chat faz vários
# pedidos por segundo. Revogar continua valendo na hora (o registro é lido a cada pedido).
_LIFE_TTL = 2.0
_life_cache: dict[str, tuple[float, str | None]] = {}
# Stream e WebSocket passam pelo porteiro uma vez só, na abertura: sem o vigia, revogar não
# derrubaria um terminal ou uma lista já abertos.
WATCH_INTERVAL = 5.0

_OK, _ENDED, _UNSURE = "ok", "ended", "unsure"


def guest_of(obj):
    scope = obj if isinstance(obj, dict) else getattr(obj, "scope", None)
    return scope.get(GUEST_SCOPE_KEY) if scope else None


def guest_allowed(method: str, path: str, session: str) -> bool:
    if (method, path) in _LIST_ROUTES or (method, path) in _GLOBAL_ROUTES:
        return True
    if any(method == m and path.startswith(p) for m, p in _GLOBAL_PREFIXES):
        return True
    parts = path.split("/")
    if len(parts) < 4 or parts[1:3] != ["api", "sessions"]:
        return False
    name, rest = parts[3], parts[4:]
    if name == f"term-{session}":
        return rest == ["term"]
    if name != session:
        return False
    # Fechar mata a sessão do dono; o convidado só para de acompanhar do lado dele.
    if not rest:
        return method != "DELETE"
    return rest[0] not in _BLOCKED


def _life(name: str, fresh: bool = False) -> str | None:
    now = time.monotonic()
    hit = _life_cache.get(name)
    if hit and not fresh and now - hit[0] < _LIFE_TTL:
        return hit[1]
    life = session_life(name)
    _life_cache[name] = (now, life)
    return life


def _verdict(share) -> str:
    # Mesma regra da varredura do dono (share_api._alive): só a ausência CONFIRMADA ou outra vida
    # encerra; troca de modo e tmux que não respondeu são "não sei" e não derrubam ninguém.
    if share.revoked_at:
        return _ENDED
    if share.session in share_api.changing_mode:
        return _UNSURE
    life = _life(share.session)
    if life is not None and life != share.life:
        # O cache pode ser de antes de a troca de modo mover o convite para a vida nova: só
        # encerra depois de reler sem cache, senão quem trocou o modo leva 410.
        life = _life(share.session, fresh=True)
    if life is None:
        return _ENDED if share_api.confirmed_absent(share.session) else _UNSURE
    return _OK if life == share.life else _ENDED


def _still_valid(token: str) -> bool:
    # Só um fim de verdade cancela o stream; "não sei" o mantém aberto.
    share = share_store.lookup_token(token)
    return share is not None and _verdict(share) != _ENDED


def _token(scope) -> str:
    # Só Bearer ou ?token=: cookie nunca, porque a origem do convidado não é a do dono.
    headers = dict(scope.get("headers") or [])
    auth = headers.get(b"authorization", b"").decode("latin-1")
    if auth.startswith("Bearer "):
        return auth[7:]
    return parse_qs(scope.get("query_string", b"").decode("latin-1")).get("token", [""])[0]


def _is_open(method: str, path: str) -> bool:
    return method == "OPTIONS" or path.startswith("/convite/") or (
        method == "POST" and path == "/api/guest/redeem")


async def _deny(scope, receive, send, status: int, code: str, msg: str,
                headers: dict | None = None) -> None:
    if scope["type"] == "websocket":
        # 1013 = "tente de novo": o cliente reconecta em vez de tratar como recusa definitiva.
        await WebSocket(scope, receive, send).close(code=1013 if status == 503 else 1008)
        return
    await JSONResponse({"detail": erro(code, msg)}, status_code=status,
                       headers=headers)(scope, receive, send)


def _is_long(scope, path: str) -> bool:
    return scope["type"] == "websocket" or path.endswith("/events")


class ShareGate:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        server = scope.get("server") or (None, None)
        if scope["type"] not in ("http", "websocket") or server[1] != GUEST_PORT:
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "GET")
        path = scope["path"]
        if _is_open(method, path):
            await self.app(scope, receive, send)
            return
        token = _token(scope)
        share = share_store.lookup_token(token) if token else None
        if share is None:
            await _deny(scope, receive, send, 401, "erro_nao_autorizado", "unauthorized")
            return
        verdict = await asyncio.to_thread(_verdict, share)
        if verdict == _ENDED:
            await _deny(scope, receive, send, 410, "erro_convite_encerrado",
                        "compartilhamento encerrado")
            return
        if verdict == _UNSURE:
            await _deny(scope, receive, send, 503, "erro_sessao_indisponivel",
                        "sessao indisponivel por instantes", {"Retry-After": "5"})
            return
        if not guest_allowed(method, path, share.session):
            await _deny(scope, receive, send, 403, "erro_fora_do_convite",
                        "fora da sessao compartilhada")
            return
        scope[GUEST_SCOPE_KEY] = share
        if _is_long(scope, path):
            await self._watched(scope, receive, send, token)
        else:
            await self.app(scope, receive, send)

    async def _watched(self, scope, receive, send, token: str) -> None:
        ended = False
        started = finished = closed = False

        async def wrapped(message):
            nonlocal started, finished, closed
            kind = message["type"]
            if kind == "websocket.close":
                closed = True
            if kind == "websocket.close" and ended:
                # 4410 = "compartilhamento encerrado" (espelho do HTTP 410) pro cliente não
                # tratar como queda de rede e ficar reconectando. O cancel faz o handler fechar
                # com 1000 no `finally`, então a troca do código tem que ser aqui.
                message = {**message, "code": 4410}
            elif kind == "http.response.start":
                started = True
            elif kind == "http.response.body" and not message.get("more_body"):
                finished = True
            await send(message)

        task = asyncio.create_task(self.app(scope, receive, wrapped))
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=WATCH_INTERVAL)
                if done:
                    task.result()
                    return
                if not await asyncio.to_thread(_still_valid, token):
                    break
            ended = True                         # ANTES do cancel: o `finally` do handler já lê isto
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            if scope["type"] == "websocket" and not closed:
                # Handler cancelado sem passar por close (ex.: parado num receive).
                with contextlib.suppress(Exception):
                    await send({"type": "websocket.close", "code": 4410})
            if scope["type"] == "http" and started and not finished:
                # Sem fechar a resposta o uvicorn acusa "returned without completing response".
                with contextlib.suppress(Exception):
                    await send({"type": "http.response.body", "body": b"", "more_body": False})
        finally:
            if not task.done():
                task.cancel()
