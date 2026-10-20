"""Grupo entre máquinas pelas portas do Python. Na 8768 as rotas `/api/groups/*` e `GET …/group` só
repassam ao Rust (nunca um 404 sem código, que a outra máquina leria como versão antiga). E a rota de
grupo que vai pela ponte leva os fatos do `orq` e devolve ao Python o que só ele faz, num sentido."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import account_bridge, api, groups_bridge, guest_users, orq_context, pair, runtime_coordinator
from app.adapters.orq import runs
from app.config import settings

TOKEN = "t-grupos"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class _Rust(BaseHTTPRequestHandler):
    seen: list = []

    def _answer(self):
        length = int(self.headers.get("content-length") or 0)
        _Rust.seen.append({"method": self.command, "path": self.path, "original": self.headers.get("x-hangar-path"),
                           "body": self.rfile.read(length).decode() if length else ""})
        data = json.dumps({"server_id": "casa", "de": "rust"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_PUT = do_POST = _answer

    def log_message(self, format, *args):
        pass


@pytest.fixture
def rust(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_token", TOKEN)
    monkeypatch.setenv("HOME", str(tmp_path))
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Rust)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _Rust.seen = []
    monkeypatch.setattr(runtime_coordinator, "current", lambda: SimpleNamespace(mode="rust"))
    monkeypatch.setattr(account_bridge, "_preparation_transport", (f"127.0.0.1:{server.server_address[1]}", "segredo"))
    yield
    server.shutdown()


ROUTES = [("get", "/api/groups/g1", None), ("put", "/api/groups/g1", {"protocol": 1, "owner": "lab", "version": 2}),
          ("post", "/api/groups/g1/ops", {"op": "join"}), ("get", "/api/sessions/a/group", None)]


def test_connect_forwards_groups_routes(rust):
    client = TestClient(api.app)
    for method, path, body in ROUTES:
        kw = {"json": body} if body is not None else {}
        r = getattr(client, method)(path, headers=AUTH, **kw)
        assert (r.status_code, r.json()["de"]) == (200, "rust"), path
    assert [(s["method"], s["path"], s["original"]) for s in _Rust.seen] == [
        (m.upper(), "/__hangar_server/forwarded", p) for m, p, _ in ROUTES]
    # O corpo do PUT e do POST chega inteiro ao Rust.
    assert json.loads(_Rust.seen[1]["body"]) == ROUTES[1][2] and json.loads(_Rust.seen[2]["body"]) == ROUTES[2][2]


def test_groups_routes_refuse_guest_and_python_mode_with_code(rust, monkeypatch):
    client = TestClient(api.app)
    assert client.get("/api/groups/g1").status_code == 401
    marker = guest_users.current.set(object())
    try:
        r = client.get("/api/groups/g1", headers=AUTH)
        assert (r.status_code, r.json()["detail"]["code"]) == (403, "erro_fora_do_convite")
    finally:
        guest_users.current.reset(marker)
    monkeypatch.setattr(runtime_coordinator, "current", lambda: SimpleNamespace(mode="python"))
    r = client.get("/api/sessions/a/group", headers=AUTH)
    assert (r.status_code, r.json()["detail"]["code"]) == (503, "groups_need_rust_server")
    assert _Rust.seen == []


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_token", TOKEN)
    monkeypatch.setattr(pair.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(groups_bridge, "rust_owns_groups", lambda: True)
    monkeypatch.setattr(runs, "active", lambda: [{"name": "x-orq"}])
    monkeypatch.setattr(runs, "group_phase", lambda gid: "live")
    sent = []

    async def enviar(name, text):
        sent.append((name, text))
        return {"ok": name != "falha", "error": {"code": "erro_x", "params": {}, "msg": "x"}}
    monkeypatch.setattr(api, "_enviar", enviar)
    state = SimpleNamespace(calls=[], sent=sent, reply=None)

    def call(op, **args):
        state.calls.append((op, args))
        return state.reply if op == "group.route" else {}
    monkeypatch.setattr(groups_bridge, "call", call)
    return state


def test_bridged_route_sends_facts_and_delivers_after(bridge):
    pair._pair_dir().mkdir(parents=True, exist_ok=True)
    (pair._pair_dir() / "a.json").write_text(json.dumps({"peers": ["b"], "task": "", "gid": "g1", "harness": {}, "orq": True}))
    bridge.reply = {"status": 200, "body": {"ok": True, "warning": None},
                    "deliveries": [{"name": "b", "text": "oi", "steer": False}, {"name": "falha", "text": "oi", "steer": False}], "post": []}
    r = TestClient(api.app).post("/api/sessions/a/pair", json={"peer": "b"}, headers=AUTH)
    assert r.status_code == 200
    [(op, args)] = bridge.calls
    assert args["facts"] == {"orchestrators": ["x-orq"], "phases": {"g1": "live"}}
    assert bridge.sent == [("b", "oi"), ("falha", "oi")]
    warning = r.json()["warning"]
    assert warning["code"] == "erro_pareamento_aviso_parcial" and warning["params"]["avisos"][0]["sessao"] == "falha"


def test_promote_conflict_undoes_the_new_group(bridge, monkeypatch):
    def conflict(name, gid):
        raise orq_context.PromotionConflict("o grupo já possui outro contrato")
    monkeypatch.setattr(orq_context, "promote", conflict)
    bridge.reply = {"status": 200, "body": {"ok": True}, "deliveries": [], "post": [{"op": "promote", "name": "arb", "gid": "g9"}]}
    r = TestClient(api.app).post("/api/sessions/arb/pair", json={"orq": True}, headers=AUTH)
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "erro_orq_arquivo_mudou")
    assert ("group.leave", {"name": "arb", "phases": {"g9": "ended"}}) in bridge.calls
