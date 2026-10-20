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
    extra: dict = {}

    def _answer(self):
        length = int(self.headers.get("content-length") or 0)
        _Rust.seen.append({"method": self.command, "path": self.path, "original": self.headers.get("x-hangar-path"),
                           "body": self.rfile.read(length).decode() if length else ""})
        # Rota que o Rust não atende: o 404 com código do `forwarded::private`.
        unknown = _Rust.seen[-1]["original"] == "/api/groups/x/y"
        data = json.dumps({"code": "forwarded_route_not_owned"} if unknown else {"server_id": "casa", "de": "rust", **_Rust.extra}).encode()
        self.send_response(404 if unknown else 200)
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
    # Caminho que o Rust não conhece também segue a ele, e volta com código.
    r = client.post("/api/groups/x/y", headers=AUTH, json={})
    assert (r.status_code, r.json()) == (404, {"code": "forwarded_route_not_owned"})
    assert _Rust.seen[-1]["original"] == "/api/groups/x/y"


def test_connect_forward_delivers_what_the_rust_deferred(rust, monkeypatch):
    """Recado a sessão que só o Python atende volta no corpo do Rust: o Python o tira da resposta e
    entrega depois, sem o Rust chamá-lo dentro do pedido."""
    sent = []

    async def enviar(name, text):
        sent.append((name, text))
        return {"ok": False, "error": {"code": "erro_x", "params": {}, "msg": "x"}}
    monkeypatch.setattr(api, "_enviar", enviar)
    registered = []
    monkeypatch.setattr(api.diag, "registrar", lambda evento, nivel, **kw: registered.append((evento, kw)))
    monkeypatch.setattr(_Rust, "extra", {"hangar_deliveries": [{"name": "pi1", "text": "[grupo: casa::s0] oi", "steer": False}]})
    body = {"protocol": 1, "origin": "casa", "sender": "s0", "text": "oi", "notice": "n1"}
    r = TestClient(api.app).post("/api/groups/g1/deliver", json=body, headers=AUTH)
    assert r.status_code == 200 and r.json() == {"server_id": "casa", "de": "rust"}
    assert sent == [("pi1", "[grupo: casa::s0] oi")]
    assert [e for e, _ in registered if e.startswith("grupos.")] == ["grupos.entrega_adiada_falhou"]


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


def test_promote_os_error_undoes_and_names_who_did_not_leave(bridge, monkeypatch):
    """Promoção que falha no disco desfaz o grupo como o conflito; quem não saiu vai no 409 e no
    diário, e o aviso que o Rust devolveu na saída é entregue."""
    def broken(name, gid):
        raise OSError("disco cheio")
    monkeypatch.setattr(orq_context, "promote", broken)
    pair._pair_dir().mkdir(parents=True, exist_ok=True)
    (pair._pair_dir() / "arb.json").write_text(json.dumps({"peers": ["b"], "task": "", "gid": "g9", "harness": {}, "orq": True}))
    registered = []
    monkeypatch.setattr(api.diag, "registrar", lambda evento, nivel, **kw: registered.append((evento, kw)))

    def call(op, **args):
        bridge.calls.append((op, args))
        if op == "group.route":
            return bridge.reply
        if args["name"] == "b":
            raise groups_bridge.GroupsBridgeError("groups_store_failed")
        return {"ex_peers": ["b"], "warnings": [], "deliveries": [{"name": "pi", "text": "saiu", "steer": False}]}
    monkeypatch.setattr(groups_bridge, "call", call)
    bridge.reply = {"status": 200, "body": {"ok": True}, "deliveries": [], "post": [{"op": "promote", "name": "arb", "gid": "g9"}]}
    r = TestClient(api.app).post("/api/sessions/arb/pair", json={"orq": True}, headers=AUTH)
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "erro_orq_arquivo_mudou")
    assert r.json()["detail"]["params"]["nao_sairam"] == ["b"]
    assert [e for e, _ in registered if e.startswith("grupos.")] == ["grupos.promocao_desfeita_falhou"]
    assert ("pi", "saiu") in bridge.sent
