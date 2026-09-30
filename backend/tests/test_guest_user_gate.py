import pytest
from fastapi import Depends, FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import guest_user_gate, guest_users, share_gate
from app.auth import require_auth
from app.config import settings

LIVES = {"minha": "t:1", "dela": "t:2", "dono": "t:3"}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "secret")
    monkeypatch.setattr(guest_users, "_path_override", tmp_path / "guests.json")
    monkeypatch.setattr(guest_users, "session_life", lambda n: LIVES.get(n))
    monkeypatch.setattr(share_gate, "WATCH_INTERVAL", 0.05)
    guest_users._reset()
    (tmp_path / "p").mkdir()
    ana, ana_tok = guest_users.create("ana", str(tmp_path / "p"), False, True)
    bia, _ = guest_users.create("bia", str(tmp_path / "p"), True, True)
    guest_users.claim("minha", ana.id)
    guest_users.claim("dela", bia.id)

    app = FastAPI()

    @app.get("/api/sessions/{name}/history", dependencies=[Depends(require_auth)])
    def history(name: str):
        g = guest_users.current.get()
        return {"name": name, "guest": g.name if g else None}

    @app.get("/api/config", dependencies=[Depends(require_auth)])
    def config():
        return {"ok": True}

    @app.get("/")
    def index():
        return {"page": True}

    @app.post("/api/sessions/{name}/codex/mode", dependencies=[Depends(require_auth)])
    def codex_mode(name: str):
        return {"ok": True}

    @app.websocket("/api/sessions/{name}/codex/voice")
    async def voice(ws: WebSocket, name: str):
        await ws.accept()

    @app.websocket("/api/sessions/{name}/nav-remoto")
    async def nav(ws: WebSocket, name: str):
        await ws.accept()

    @app.websocket("/api/sessions/{name}/term")
    async def term(ws: WebSocket, name: str):
        await ws.accept()
        await ws.receive_text()

    app.add_middleware(guest_user_gate.GuestUserGate)
    yield TestClient(app), ana, ana_tok
    guest_users._reset()


def _h(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_owner_token_passes_untouched(env):
    client, _, _ = env
    r = client.get("/api/sessions/dela/history", headers=_h("secret"))
    assert r.status_code == 200 and r.json()["guest"] is None


def test_unknown_token_still_401(env):
    client, _, _ = env
    assert client.get("/api/config", headers=_h("xyz")).status_code == 401


def test_guest_reaches_own_session(env):
    client, _, tok = env
    r = client.get("/api/sessions/minha/history", headers=_h(tok))
    assert r.status_code == 200 and r.json()["guest"] == "ana"


def test_guest_blocked_from_server_settings(env):
    client, _, tok = env
    r = client.get("/api/config", headers=_h(tok))
    assert r.status_code == 403


def test_guest_blocked_from_owner_and_other_guest(env):
    client, _, tok = env
    assert client.get("/api/sessions/dono/history", headers=_h(tok)).status_code == 403
    assert client.get("/api/sessions/dela/history", headers=_h(tok)).status_code == 403


def test_guest_sees_owner_when_allowed(env):
    client, ana, tok = env
    guest_users.update(ana.id, ana.root, sees_owner=True, owner_sees=True)
    assert client.get("/api/sessions/dono/history", headers=_h(tok)).status_code == 200


def test_guest_token_from_cookie(env):
    client, _, tok = env
    client.cookies.set("cp_token", tok)
    assert client.get("/api/sessions/minha/history").status_code == 200


def test_removed_guest_loses_open_terminal(env):
    client, ana, tok = env
    with client.websocket_connect(f"/api/sessions/minha/term?token={tok}") as ws:
        guest_users.delete(ana.id)
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_text()
        assert e.value.code == 4410


def test_guest_port_with_clash_is_still_gated(env, monkeypatch):
    # Porta do convidado == porta principal: o porteiro do convite se desliga, o deste tem que valer.
    client, _, tok = env
    monkeypatch.setattr(guest_user_gate, "GUEST_PORT", 80)
    monkeypatch.setattr(guest_user_gate, "port_clash", lambda: True)
    assert client.get("/api/config", headers=_h(tok)).status_code == 403


@pytest.mark.parametrize("rota", ["codex/voice", "nav-remoto"])
def test_guest_blocked_from_codex_voice_and_remote_browser(env, rota):
    client, _, tok = env
    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect(f"/api/sessions/minha/{rota}?token={tok}"):
            pass
    assert e.value.code == 1008


def test_guest_cookie_does_not_break_page_paths(env):
    client, _, tok = env
    client.cookies.set("cp_token", tok)
    r = client.get("/")
    assert r.status_code == 200 and r.json() == {"page": True}


def test_guest_keeps_codex_mode_on_own_session(env):
    client, _, tok = env
    assert client.post("/api/sessions/minha/codex/mode", headers=_h(tok)).status_code == 200
