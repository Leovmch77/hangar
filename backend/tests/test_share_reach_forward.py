"""Conferência do link de convite pelo Connect (8768): o Python só repassa à rota privada do Rust."""
import contextvars
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app import auth, guest_users, list_bridge
from app.api import app
from app.config import settings
from app.connect_port import CONNECT_PORT

TOKEN = "dono-convite"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"}
BODY = b'{"link":"https://maq.tail1.ts.net:8443/par/abc123"}'
NEEDS_RUST = {"detail": {"code": "share_needs_rust_server", "params": {},
                         "msg": "a conferência do link precisa do servidor Rust"}}


class _RustReach(BaseHTTPRequestHandler):
    seen: list = []
    reply = (200, {"ok": False, "stage": "dns", "detail": "ainda não existe"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        _RustReach.seen.append({"path": self.path, "body": body, "secret": self.headers.get("x-hangar-internal")})
        status, payload = _RustReach.reply
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


def _client():
    return TestClient(app, base_url=f"http://127.0.0.1:{CONNECT_PORT}", client=("127.0.0.1", 5))


def _post(**kw):
    return _client().post("/api/share/reachability", content=BODY, **kw)


@pytest.fixture(autouse=True)
def owner(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", TOKEN)
    monkeypatch.setattr(settings, "port", 8765)
    yield
    list_bridge.configure(None, None)
    auth.reset_backoff()


@pytest.fixture
def rust():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _RustReach)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _RustReach.seen = []
    list_bridge.configure(f"127.0.0.1:{server.server_address[1]}", "sek")
    yield
    server.shutdown()


def test_owner_body_reaches_rust_and_answer_comes_back_as_is(rust):
    got = _post(headers=HEADERS)
    assert (got.status_code, got.json()) == (200, {"ok": False, "stage": "dns", "detail": "ainda não existe"})
    assert _RustReach.seen == [{"path": "/__hangar_server/share/reachability", "body": BODY, "secret": "sek"}]

    _RustReach.reply = (400, {"detail": {"code": "share_reach_link_refused", "params": {}, "msg": "x"}})
    try:
        got = _post(headers=HEADERS)
    finally:
        _RustReach.reply = (200, {"ok": False, "stage": "dns", "detail": "ainda não existe"})
    assert (got.status_code, got.json()["detail"]["code"]) == (400, "share_reach_link_refused")


def test_without_rust_endpoint_is_404_needs_rust():
    got = _post(headers=HEADERS)
    assert (got.status_code, got.json()) == (404, NEEDS_RUST)


def test_rust_endpoint_not_answering_is_404_needs_rust():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    list_bridge.configure(f"127.0.0.1:{port}", "sek")
    got = _post(headers=HEADERS)
    assert (got.status_code, got.json()) == (404, NEEDS_RUST)


def test_guest_is_refused_without_reaching_rust(rust, monkeypatch):
    monkeypatch.setattr(guest_users, "current", contextvars.ContextVar("guest", default=object()))
    got = _post()
    assert got.status_code == 403
    assert got.json()["detail"]["code"] == "share_owner_only"
    assert _RustReach.seen == []


def test_without_token_is_401(rust):
    assert _post().status_code == 401
    assert _RustReach.seen == []
