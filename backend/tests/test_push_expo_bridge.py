"""Cada push também vai ao canal Expo do Rust, com ou sem Web Push configurado."""
import contextvars
import json
import logging
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import account_bridge, guest_users, push, push_expo_bridge, runtime_coordinator


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(push, "_file", lambda: tmp_path / "subs.json")
    monkeypatch.setattr(push.settings, "vapid_private", "")
    monkeypatch.setattr(push.settings, "vapid_public", "")
    monkeypatch.setattr(runtime_coordinator, "_current", SimpleNamespace(mode="rust"))
    yield
    if push._coalesce_timer is not None:
        push._coalesce_timer.cancel()
    push._coalesce_buf.clear()
    push._coalesce_timer = None
    push_expo_bridge.configure(None, None)


@pytest.fixture
def join_expo(monkeypatch):
    """O envio sai numa thread: o teste espera por ela em vez de dormir."""
    spawned = []

    class Tracked(threading.Thread):
        def start(self):
            spawned.append(self)
            super().start()
    monkeypatch.setattr(push, "Thread", Tracked)

    def join():
        for t in spawned:
            t.join(5)
            assert not t.is_alive()
    return join


@pytest.fixture
def rust():
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            seen.append((self.path, self.headers.get("x-hangar-internal"), self.headers.get("x-hangar-path"), json.loads(body)))
            self.send_response(202)
            self.send_header("content-length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    address = f"127.0.0.1:{server.server_port}"
    push_expo_bridge.configure(address, "sek")
    yield seen, address
    server.shutdown()
    server.server_close()


def test_broadcast_reaches_rust_without_vapid_or_subscription(rust, join_expo):
    seen, _ = rust
    push.notify_dead("minha-sessao")
    join_expo()
    assert seen == [("/__hangar_server/push/expo", "sek", None, {
        "session": "minha-sessao",
        "title": {"pt": "minha-sessao", "en": "minha-sessao"},
        "body": {"pt": "Caiu", "en": "Died"},
        "list": False,
    })]


def test_coalesced_push_is_list_view_with_suffix_title(rust, join_expo):
    seen, _ = rust
    push._queue_awaiting("a", None)
    push._queue_awaiting("b", None)
    push._flush_coalesce()
    join_expo()
    assert len(seen) == 1
    sent = seen[0][3]
    assert sent["list"] is True
    assert sent["title"] == {"pt": "2 sessões aguardando", "en": "2 sessions waiting"}
    assert sent["body"] == {"pt": "2 sessões aguardando: a, b", "en": "2 sessions waiting: a, b"}


def test_send_runs_outside_lock_and_web_push_still_goes(monkeypatch, tmp_path):
    import pywebpush
    push.add_subscription({"endpoint": "https://x/1", "keys": {}}, "Casa", "srv1")
    monkeypatch.setattr(push.settings, "vapid_private", "priv")
    monkeypatch.setattr(push.settings, "vapid_public", "pub")
    web = []
    monkeypatch.setattr(pywebpush, "webpush", lambda **kw: web.append(push._lock.locked()))
    push_expo_bridge.configure("127.0.0.1:1", "sek")
    seen = []
    done = threading.Event()

    def fake_send(*args):
        seen.append((push._lock.locked(), threading.current_thread() is threading.main_thread()))
        done.set()
    monkeypatch.setattr(push_expo_bridge, "send", fake_send)
    push.notify_finished("s")
    assert done.wait(5)
    assert seen == [(False, False)]
    assert web == [True]


def test_unconfigured_bridge_spawns_nothing(monkeypatch):
    monkeypatch.setattr(push_expo_bridge, "send", lambda *a: pytest.fail("send sem ponte"))
    monkeypatch.setattr(push, "Thread", lambda **kw: pytest.fail("thread sem ponte"))
    push.notify_dead("s")


def test_rust_down_logs_warning_without_raising(caplog, join_expo):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    push_expo_bridge.configure(f"127.0.0.1:{port}", "sek")
    with caplog.at_level(logging.WARNING, logger="hangar.push"):
        push.notify_dead("s")
        join_expo()
    assert "push expo falhou" in caplog.text


def test_python_mode_does_not_call(rust, monkeypatch, join_expo):
    seen, _ = rust
    monkeypatch.setattr(runtime_coordinator, "_current", SimpleNamespace(mode="python"))
    push.notify_dead("s")
    join_expo()
    assert seen == []


@pytest.fixture
def connect(rust, monkeypatch):
    from app.api import app
    from app.config import settings
    seen, address = rust
    monkeypatch.setattr(settings, "auth_token", "tok")
    coordinator = runtime_coordinator.RuntimeCoordinator()
    coordinator.mode = "rust"
    monkeypatch.setattr(runtime_coordinator, "_current", coordinator)
    monkeypatch.setattr(account_bridge, "_preparation_transport", None)
    account_bridge.configure_preparation(address, "sek")
    yield TestClient(app), seen
    account_bridge.configure_preparation(None, None)


SUBSCRIBE = {"token": "ExponentPushToken[x]", "server_id": "srv", "label": "Casa", "locale": "pt"}


def test_subscribe_forwards_owner_to_rust(connect):
    client, seen = connect
    got = client.post("/api/push/expo/subscribe", json=SUBSCRIBE, headers={"Authorization": "Bearer tok"})
    assert got.status_code == 202
    assert seen == [("/__hangar_server/forwarded", "sek", "/api/push/expo/subscribe", SUBSCRIBE)]


def test_subscribe_refuses_guest_without_reaching_rust(connect, monkeypatch):
    client, seen = connect
    monkeypatch.setattr(guest_users, "current", contextvars.ContextVar("guest", default=object()))
    got = client.post("/api/push/expo/subscribe", json=SUBSCRIBE)
    assert got.status_code == 403
    assert got.json()["detail"]["code"] == "push_expo_owner_only"
    assert seen == []


def test_subscribe_needs_auth(connect):
    client, seen = connect
    assert client.post("/api/push/expo/subscribe", json=SUBSCRIBE).status_code == 401
    assert seen == []
