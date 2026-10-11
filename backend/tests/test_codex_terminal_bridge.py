"""Repasse num sentido, à ponte do Rust, do que entra pelo Python para um Codex com terminal dele."""
import asyncio
import http.server
import threading

import pytest
from starlette.requests import Request

import app.api as api_mod
from app import list_bridge, runtime_coordinator
from app.runtime_coordinator import RuntimeCoordinator
from app.share_tunnel import GUEST_PORT


def _owner(monkeypatch, mode="rust", terminal=True):
    owner = RuntimeCoordinator(None, None)
    owner.mode = mode
    owner._owns = {("claude", True), ("claude", False), ("codex", True)} | ({("codex", False)} if terminal else set())
    monkeypatch.setattr(runtime_coordinator, "_current", owner)
    return owner


def test_the_bridge_is_called_one_way_and_421_means_not_ours(monkeypatch):
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            seen.append((self.path, self.headers.get("x-hangar-internal"), body))
            self.send_response(421 if "/py/" in self.path else 200)
            self.send_header("content-length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(list_bridge, "endpoint", lambda: (f"127.0.0.1:{server.server_port}", "s"))
        owner = _owner(monkeypatch, terminal=False)
        assert runtime_coordinator.rust_codex_terminal("cx", "input", body=b"{}") is None, "sem o anúncio, nada sai"
        owner._owns.add(("codex", False))
        assert runtime_coordinator.rust_codex_terminal("cx", "input", body=b'{"text":"oi"}') == (200, b"{}")
        assert seen == [("/__hangar_server/codex/cx/input", "s", b'{"text":"oi"}')]
        assert runtime_coordinator.rust_codex_terminal("py", "kill") is None, "421: o Python segue como hoje"
        owner.mode = "python"
        assert runtime_coordinator.rust_codex_terminal("cx", "input") is None
        assert len(seen) == 2
    finally:
        server.shutdown()


def test_bridge_failures_become_a_coded_failure_never_an_exception(monkeypatch):
    import json
    import socket
    import urllib.request

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            status, body = (404, b"nope") if "/text/" in self.path else (409, b'{"detail": {"code": "close_kill_survived"}}')
            self.send_response(status)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    def code(reply):
        return json.loads(reply[1])["detail"]["code"]

    _owner(monkeypatch)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(list_bridge, "endpoint", lambda: (f"127.0.0.1:{server.server_port}", "s"))
        refused = runtime_coordinator.rust_codex_terminal("cx", "kill")
        assert refused[0] == 409 and code(refused) == "close_kill_survived", "o envelope do Rust passa como veio"
        text = runtime_coordinator.rust_codex_terminal("text", "input", body=b"{}")
        assert text[0] == 502 and code(text) == "codex_bridge_failed", "corpo que não é JSON vira código"
    finally:
        server.shutdown()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed = probe.getsockname()[1]
    monkeypatch.setattr(list_bridge, "endpoint", lambda: (f"127.0.0.1:{closed}", "s"))
    down = runtime_coordinator.rust_codex_terminal("cx", "input", body=b"{}")
    assert down[0] == 503 and code(down) == "codex_bridge_failed", "Rust fora do ar"
    assert asyncio.run(api_mod._send_one_codex("cx", "oi"))["error"]["code"] == "codex_bridge_failed", \
        "o envio do broadcast/grupo/MCP devolve a falha, sem levantar"

    class Slow:
        def open(self, *args, **kwargs):
            raise TimeoutError("timed out")
    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: Slow())
    late = runtime_coordinator.rust_codex_terminal("cx", "input", body=b"{}")
    assert late[0] == 503 and code(late) == "codex_bridge_failed", "prazo estourado"


def test_delete_answers_the_rust_code_when_the_close_fails(monkeypatch):
    from fastapi import HTTPException
    from app.registry import KillFailed

    def refuse(name, closed_by_rust=False):
        raise KillFailed(name, {"code": "codex_bridge_failed", "params": {}, "msg": "fora"})
    monkeypatch.setattr(api_mod.registry, "kill", refuse)
    monkeypatch.setattr(api_mod, "_invalidate_lists", lambda: None)
    monkeypatch.setattr(api_mod, "_recusa_orq", lambda name: None)
    with pytest.raises(HTTPException) as failed:
        asyncio.run(api_mod.kill_session("cx"))
    assert failed.value.status_code == 500 and failed.value.detail["code"] == "codex_bridge_failed"


def test_sends_from_python_paths_go_to_the_rust_and_return_its_code(monkeypatch):
    calls = []
    monkeypatch.setattr(runtime_coordinator, "rust_codex_terminal",
                        lambda *args: calls.append(args) or (200, b'{"ok": true, "delivered": true}'))

    async def no_python(*args, **kwargs):
        raise AssertionError("o Python não entrega no Codex com terminal do Rust")
    monkeypatch.setattr(api_mod, "_send_managed", no_python)
    assert asyncio.run(api_mod._send_one_codex("cx", "oi")) == {"ok": True, "delivered": True}
    assert calls == [("cx", "input", "POST", b'{"text": "oi"}')]
    monkeypatch.setattr(runtime_coordinator, "rust_codex_terminal", lambda *args: (409, b'{"detail": {"code": "x"}}'))
    assert asyncio.run(api_mod._send_one_codex("cx", "oi")) == {"ok": False, "error": {"code": "x"}, "delivered": False}


def _request(port, path="/api/sessions/cx/keys", query=b"", body=b'{"key":"Up"}'):
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}
    return Request({"type": "http", "method": "POST", "path": path, "query_string": query, "headers": [],
                    "server": ("127.0.0.1", port)}, receive)


def test_writes_entering_the_guest_or_connect_port_are_forwarded_whole(monkeypatch):
    calls = []
    monkeypatch.setattr(runtime_coordinator, "rust_codex_terminal", lambda *args: calls.append(args) or (202, b"{}"))
    with pytest.raises(api_mod._RustReply) as reply:
        asyncio.run(api_mod._codex_rust_port("cx", _request(GUEST_PORT)))
    assert reply.value.args == (202, b"{}")
    assert calls == [("cx", "keys", "POST", b'{"key":"Up"}')]
    with pytest.raises(api_mod._RustReply):
        asyncio.run(api_mod._codex_rust_port("cx", _request(api_mod.CONNECT_PORT, "/api/sessions/cx/limits", b"a=1", b"")))
    assert calls[-1] == ("cx", "limits?a=1", "POST", b"")
    # O que chegou pela porta de trás do Rust é dele já: nunca volta para lá.
    asyncio.run(api_mod._codex_rust_port("cx", _request(1)))
    assert len(calls) == 2
    # Não é Codex com terminal do Rust: a rota do Python segue.
    monkeypatch.setattr(runtime_coordinator, "rust_codex_terminal", lambda *args: None)
    asyncio.run(api_mod._codex_rust_port("cx", _request(GUEST_PORT)))


def test_relaunch_routes_entering_the_guest_or_connect_port_go_to_the_rust():
    for path in ("/api/sessions/{name}/modo-execucao", "/api/sessions/{name}/recarregar"):
        route = next(r for r in api_mod.app.routes if getattr(r, "path", None) == path and "POST" in r.methods)
        assert any(d.dependency is api_mod._codex_rust_port for d in route.dependencies), path


def test_delete_marked_by_the_rust_only_cleans_python_stores(monkeypatch):
    from app import internal_api
    monkeypatch.setattr(internal_api, "_secret", "segredo")
    calls = []
    monkeypatch.setattr(api_mod.registry, "kill", lambda name, closed_by_rust=False: calls.append(closed_by_rust) or [])
    monkeypatch.setattr(api_mod, "_invalidate_lists", lambda: calls.append("invalidate"))
    monkeypatch.setattr(api_mod, "_recusa_orq", lambda name: None)
    monkeypatch.setattr(api_mod.share_store, "revoke_session", lambda name: 0)

    def request(mark):
        return Request({"type": "http", "method": "DELETE", "path": "/api/sessions/cx", "query_string": b"",
                        "headers": [(b"x-hangar-rust-closed", mark)]})
    assert asyncio.run(api_mod.kill_session("cx", request=request(b"segredo")))["ok"] is True
    assert calls == [True], "marcado pelo Rust: só as lojas daqui, sem invalidar a lista dele"
    asyncio.run(api_mod.kill_session("cx", request=request(b"forjado")))
    assert calls[1:] == [False, "invalidate"], "marca que não é o segredo não vale"
    asyncio.run(api_mod.kill_session("cx"))
    assert calls[3:] == [False, "invalidate"], "chamada em processo (MCP) encerra como sempre"


def test_published_terminal_with_the_rust_owner_is_left_to_the_watcher(monkeypatch):
    from types import SimpleNamespace
    from app.adapters.codex import sessions as codex_sessions
    from app.adapters.codex.adapter import CodexAdapter
    adapter = CodexAdapter()
    closed = []

    class Client:
        async def close(self):
            closed.append(True)

    async def verified(client, meta):
        return {}
    adapter._adoptions = {"cx": ("tid", Client(), "default")}
    monkeypatch.setattr(adapter, "_verify_imported_runtime", verified)
    monkeypatch.setattr(codex_sessions, "load_prepared", lambda name, transfer: {})
    monkeypatch.setattr(codex_sessions, "publish_prepared", lambda name, transfer: {"headless": False, "thread_id": "t"})
    monkeypatch.setattr(runtime_coordinator, "rust_owns_codex_terminal", lambda: True)
    asyncio.run(adapter.publish_imported(SimpleNamespace(name="cx", id="tid")))
    assert closed == [True], "o cliente da conferência sai"
    assert "cx" not in adapter._sessions and "cx" not in adapter._adoptions
