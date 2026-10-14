"""Porteiro do convidado com login próprio: reconhece a chave dele e só deixa passar as sessões
que ele enxerga. A chave do dono passa direto, sem consulta nenhuma.

Delimita a INTERFACE, não é fronteira de segurança (ver guest_users).
"""
import asyncio
import contextlib
import secrets
from http.cookies import CookieError, SimpleCookie
from typing import Callable
from urllib.parse import parse_qs

from starlette.responses import JSONResponse
from starlette.websockets import WebSocket

from app import auth as auth_mod, guest_header, guest_users
from app.config import GUEST_PORT, port_clash, settings
from app.mensagens import erro

_LIST_ROUTES = {("GET", "/api/sessions"), ("GET", "/api/sessions/events")}
_GLOBAL_PREFIXES = (("GET", "/api/tts/audio/"),)
# Stream e WebSocket passam pelo porteiro uma vez só, na abertura: sem o vigia, tirar o acesso
# não derrubaria um terminal ou uma lista já abertos.
WATCH_INTERVAL = 5.0

# O que a tela precisa para criar e acompanhar sessão; configuração do servidor fica de fora.
# Inclui as globais que o convidado de convite também alcança (a cópia do Rust mora em `share/caller.rs`).
_GLOBAL_ROUTES = {
    ("GET", "/api/model-options"),
    ("GET", "/api/engines"),
    ("GET", "/api/harness/codex/opcoes"),
    ("POST", "/api/ditado/relimpar"),
    ("POST", "/api/pensamento/pt"),
    ("POST", "/api/tts"),
    ("POST", "/api/tts/narrar"),
    ("POST", "/api/sessions"),
    ("GET", "/api/sessions/creation-progress"),
    ("GET", "/api/fs/roots"),
    ("GET", "/api/fs/scan"),
    ("GET", "/api/fs/branches"),
    ("GET", "/api/providers"),
    ("GET", "/api/claude-configs"),
    ("GET", "/api/codex-contas"),
    ("GET", "/api/cotas"),
    ("GET", "/api/me"),
    ("POST", "/api/diag"),
}
# Alcançam outra sessão do dono ou abrem janela na tela dele; `share` deixaria o convidado
# criar e revogar convites. Navegador embutido não é do convidado; recusar aqui evita que o
# navsock registre tentativa falha contra o IP dele.
_BLOCKED = {"pair", "pair-remote", "unpair-remote", "group-message", "then", "orq", "bastao",
            "open-terminal", "open-editor", "nav", "share", "pair-invite", "pair-accept",
            "pair-access", "nav-remoto", "navegador"}


def guest_allowed_user(guest, method: str, path: str) -> bool:
    if (method, path) in _LIST_ROUTES or (method, path) in _GLOBAL_ROUTES:
        return True
    if any(method == m and path.startswith(p) for m, p in _GLOBAL_PREFIXES):
        return True
    parts = path.split("/")
    if len(parts) < 4 or parts[1:3] != ["api", "sessions"]:
        return False
    name, rest = parts[3], parts[4:]
    if name.startswith("term-") and rest == ["term"]:
        return guest_users.visible_to(guest, name[len("term-"):])
    if rest and rest[0] in _BLOCKED:
        return False
    return guest_users.visible_to(guest, name)


def _still_allowed(token: str, method: str, path: str) -> bool:
    # Revê a visibilidade também: desligar "ele vê as minhas" fecha o terminal já aberto.
    guest = guest_users.lookup_token(token)
    return guest is not None and guest_allowed_user(guest, method, path)


def _token(scope) -> str:
    # Mesma ordem do require_auth: header, ?token=, cookie cp_token (o app servido pela VPS usa o cookie).
    headers = dict(scope.get("headers") or [])
    auth = headers.get(b"authorization", b"").decode("latin-1")
    if auth.startswith("Bearer "):
        return auth[7:]
    q = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("token", [""])[0]
    if q:
        return q
    jar = SimpleCookie()
    try:
        jar.load(headers.get(b"cookie", b"").decode("latin-1"))
    except CookieError:
        return ""
    if scope["type"] == "http" and scope.get("method") not in auth_mod._COOKIE_METODOS:
        return ""
    if auth_mod.COOKIE_HOST in jar:
        return jar[auth_mod.COOKIE_HOST].value
    https = scope.get("scheme") in ("https", "wss")
    return jar[auth_mod.COOKIE].value if not https and auth_mod.COOKIE in jar else ""


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


async def watch(app, scope, receive, send, still_valid: Callable[[], bool]) -> None:
    """Roda o stream/WebSocket e o derruba (4410 / fim da resposta) quando `still_valid` vira False."""
    ended = False
    started = finished = closed = False

    async def wrapped(message):
        nonlocal started, finished, closed
        kind = message["type"]
        if kind == "websocket.close":
            closed = True
        if kind == "websocket.close" and ended:
            # 4410 = "acesso encerrado" (espelho do HTTP 410) pro cliente não tratar como queda
            # de rede e ficar reconectando. O cancel faz o handler fechar com 1000 no `finally`,
            # então a troca do código tem que ser aqui.
            message = {**message, "code": 4410}
        elif kind == "http.response.start":
            started = True
        elif kind == "http.response.body" and not message.get("more_body"):
            finished = True
        await send(message)

    task = asyncio.create_task(app(scope, receive, wrapped))
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=WATCH_INTERVAL)
            if done:
                task.result()
                return
            if not await asyncio.to_thread(still_valid):
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


class GuestUserGate:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        server = scope.get("server") or (None, None)
        # Na porta do convidado de convite manda o porteiro do Rust; com a porta colidida ela É a principal.
        # Só /api/ tem dono de sessão; página, assets e /convite/ seguem sem o porteiro (o cookie
        # cp_token do próprio servidor do convidado chega aqui em toda carga da tela).
        # /api/sync/ é o hub: autentica pelo cp_sync, e o cp_token do convidado na mesma origem não
        # pode trancá-lo fora; a parte de administração segue no require_auth, que o recusa.
        # `lifespan` não tem path: ler antes de olhar o tipo derrubava a subida inteira do backend.
        path = scope.get("path", "")
        if scope["type"] not in ("http", "websocket") or not path.startswith("/api/") or (
                path.startswith("/api/sync/")) or (server[1] == GUEST_PORT and not port_clash()):
            await self.app(scope, receive, send)
            return
        # Convidado de convite já decidido e assinado pelo Rust: não é convidado com login.
        if guest_header.guest_of(scope) is not None:
            await self.app(scope, receive, send)
            return
        token = _token(scope)
        if not token or (settings.auth_token and secrets.compare_digest(
                token.encode(), settings.auth_token.encode())):
            await self.app(scope, receive, send)
            return
        guest = guest_users.lookup_token(token)
        if guest is None:
            await self.app(scope, receive, send)      # require_auth recusa como sempre
            return
        method = scope.get("method", "GET")
        if not await asyncio.to_thread(guest_allowed_user, guest, method, path):
            await _deny(scope, receive, send, 403, "erro_fora_do_convidado", "fora do acesso do convidado")
            return
        marker = guest_users.current.set(guest)
        try:
            if _is_long(scope, path):
                await watch(self.app, scope, receive, send, lambda: _still_allowed(token, method, path))
            else:
                await self.app(scope, receive, send)
        finally:
            guest_users.current.reset(marker)
