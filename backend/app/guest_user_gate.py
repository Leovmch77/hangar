"""Porteiro do convidado com login próprio: reconhece a chave dele e só deixa passar as sessões
que ele enxerga. A chave do dono passa direto, sem consulta nenhuma.

Delimita a INTERFACE, não é fronteira de segurança (ver guest_users).
"""
import asyncio
import secrets
from http.cookies import CookieError, SimpleCookie
from urllib.parse import parse_qs

from app import guest_users, share_gate
from app.config import settings
from app.share_tunnel import GUEST_PORT, port_clash

# O que a tela precisa para criar e acompanhar sessão; configuração do servidor fica de fora.
_GLOBAL_ROUTES = share_gate._GLOBAL_ROUTES | {
    ("POST", "/api/sessions"),
    ("GET", "/api/sessions/creation-progress"),
    ("GET", "/api/fs/roots"),
    ("GET", "/api/fs/scan"),
    ("GET", "/api/fs/branches"),
    ("GET", "/api/providers"),
    ("GET", "/api/engines/modelos"),
    ("GET", "/api/claude-configs"),
    ("GET", "/api/codex-contas"),
    ("GET", "/api/cotas"),
    ("GET", "/api/me"),
    ("POST", "/api/diag"),
}
# Voz do Codex e navegador embutido não são do convidado; recusar aqui evita que o navsock
# registre tentativa falha contra o IP dele.
_BLOCKED = share_gate._BLOCKED | {"nav-remoto", "navegador"}
_VOICE = (["codex", "voice"], ["codex", "voices"])


def guest_allowed_user(guest, method: str, path: str) -> bool:
    if (method, path) in share_gate._LIST_ROUTES or (method, path) in _GLOBAL_ROUTES:
        return True
    if any(method == m and path.startswith(p) for m, p in share_gate._GLOBAL_PREFIXES):
        return True
    parts = path.split("/")
    if len(parts) < 4 or parts[1:3] != ["api", "sessions"]:
        return False
    name, rest = parts[3], parts[4:]
    if name.startswith("term-") and rest == ["term"]:
        return guest_users.visible_to(guest, name[len("term-"):])
    if rest and (rest[0] in _BLOCKED or rest[:2] in _VOICE):
        return False
    return guest_users.visible_to(guest, name)


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
    return jar["cp_token"].value if "cp_token" in jar else ""


class GuestUserGate:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        server = scope.get("server") or (None, None)
        # Na porta do convidado de convite manda o ShareGate; com a porta colidida ela É a principal.
        # Só /api/ tem dono de sessão; página, assets e /convite/ seguem sem o porteiro (o cookie
        # cp_token do próprio servidor do convidado chega aqui em toda carga da tela).
        if scope["type"] not in ("http", "websocket") or not scope["path"].startswith("/api/") or (
                server[1] == GUEST_PORT and not port_clash()):
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
        path = scope["path"]
        if not await asyncio.to_thread(guest_allowed_user, guest, method, path):
            await share_gate._deny(scope, receive, send, 403, "erro_fora_do_convidado",
                                   "fora do acesso do convidado")
            return
        marker = guest_users.current.set(guest)
        try:
            if share_gate._is_long(scope, path):
                await share_gate.watch(self.app, scope, receive, send,
                                       lambda: guest_users.lookup_token(token) is not None)
            else:
                await self.app(scope, receive, send)
        finally:
            guest_users.current.reset(marker)
