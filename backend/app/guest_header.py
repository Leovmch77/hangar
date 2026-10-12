"""Convidado decidido pelo Rust: chega num cabeçalho assinado, nunca pelo token de convite."""
import base64
import binascii
import hashlib
import hmac
import json
import time
from types import SimpleNamespace

from app import internal_api

HEADER = b"x-hangar-guest"
_LOOPBACK = {"127.0.0.1", "::1"}


def _now() -> float:
    return time.time()


class GuestView:
    """Sessões e níveis que o Rust conferiu para este pedido."""

    def __init__(self, sessions: dict[str, str]):
        self.sessions = sessions

    def sees(self, name: str | None) -> bool:
        return name in self.sessions

    def kind_of(self, name: str | None) -> str | None:
        return self.sessions.get(name)

    def share_for(self, name: str | None):
        kind = self.sessions.get(name)
        return None if kind is None else SimpleNamespace(kind=kind, session=name)

    def pair_shares(self) -> list:
        return [SimpleNamespace(kind=k, session=n) for n, k in self.sessions.items() if k == "pair"]


def verify(obj) -> GuestView | None:
    scope = obj if isinstance(obj, dict) else getattr(obj, "scope", None)
    secret = internal_api._secret
    if not scope or secret is None or (scope.get("client") or ("",))[0] not in _LOOPBACK:
        return None
    value = next((v for k, v in scope.get("headers") or [] if k == HEADER), None)
    raw_path = scope.get("raw_path")
    if value is None or raw_path is None:
        return None
    payload, _, mac = value.partition(b".")
    # Aperto de mão do WebSocket não tem método no scope: é um GET.
    method = scope.get("method", "GET").encode()
    expected = hmac.new(secret.encode(), method + b"\n" + raw_path + b"\n" + payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected.encode()):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload + b"=" * (-len(payload) % 4)))
        sessions, exp = data["s"], data["exp"]
    except (binascii.Error, ValueError, KeyError, TypeError):
        return None
    if not isinstance(sessions, dict) or not isinstance(exp, int) or exp < _now():
        return None
    return GuestView({str(n): str(k) for n, k in sessions.items()})


def guest_of(obj):
    """Convidado deste pedido, ou None para o dono."""
    view = verify(obj)
    if view is not None:
        return view
    # ponytail: enquanto o Python ainda serve a 8766 (até a virada), vale o convidado que o
    # ShareGate pôs no scope; sai junto com o share_gate.
    from app import share_gate
    return share_gate.guest_of(obj)
