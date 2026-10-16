"""A abertura de Claude com terminal é do Rust: só o que entrou direto no Python (Connect, MCP) vai à
ponte dele, e as rotas internas guardam aqui só o que é daqui (registro em espera, `then`, dono do
convidado)."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.api as api_mod
from app import internal_api, pqueue

SECRET = "cd" * 32
INFO = {"name": "s1", "cwd": "/p", "jsonl": "/p/x.jsonl", "provider": "claude", "headless": False,
        "config_dir": None, "account_source": None}


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    internal_api.set_secret(SECRET)
    monkeypatch.setattr(pqueue, "_queue_dir", lambda: tmp_path)
    yield
    internal_api.set_secret(None)


def _post(path, body):
    return TestClient(api_mod.app, client=("127.0.0.1", 50000)).post(path, json=body, headers={"X-Hangar-Internal": SECRET})


def test_release_touches_only_what_lives_here(monkeypatch):
    released = []
    monkeypatch.setattr(api_mod.registry, "release_name", released.append)
    assert _post("/internal/sessions/s%201/release", {}).json() == {"ok": True}
    assert released == ["s 1"]
    assert _post("/internal/sessions/s1/born", {}).status_code == 404, "o nascimento é todo do Rust"


def test_the_guest_claim_of_a_rust_open_is_recorded_here(monkeypatch):
    from app import guest_users
    claimed = []
    monkeypatch.setattr(guest_users, "claim", lambda session, gid: claimed.append((session, gid)))
    assert _post("/internal/guests/claim", {"session": "s1", "guest": "g1"}).json() == {"ok": True}
    assert claimed == [("s1", "g1")]
    assert _post("/internal/guests/claim", {"session": "s1"}).status_code == 400
    assert _post("/internal/guests/claim", {"session": "s1", "guest": ""}).status_code == 400


def _body(**kw):
    return api_mod.CreateBody(name="s1", cwd="/p", **kw)


def test_only_what_entered_python_directly_goes_to_the_rust_open(monkeypatch):
    from app import runtime_coordinator
    from app.connect_port import CONNECT_PORT
    sent = []

    def bridge(name, route, method, body, timeout):
        sent.append((name, route, method, json.loads(body)))
        payload = json.loads(body)
        return (200, json.dumps({"info": INFO, "undo": None}).encode()) if payload["request"].get("provider") == "claude" else None
    monkeypatch.setattr(runtime_coordinator, "rust_claude", bridge)
    info = asyncio.run(api_mod._open_in_rust(_body(provider="claude", headless=False), None))
    assert (info.name, info.provider, info.owner) == ("s1", "claude", None)
    # Ausente continua ausente: o Rust decide o provedor padrão.
    assert sent[0] == ("s1", "open", "POST", {"request": {"name": "s1", "cwd": "/p", "provider": "claude", "headless": False}, "guest_root": None})
    assert asyncio.run(api_mod._open_in_rust(_body(provider="codex"), None)) is None
    connect = SimpleNamespace(scope={"server": ("127.0.0.1", CONNECT_PORT)})
    assert asyncio.run(api_mod._open_in_rust(_body(provider="claude"), connect)) is not None
    upstream = SimpleNamespace(scope={"server": ("127.0.0.1", 49152)})
    assert asyncio.run(api_mod._open_in_rust(_body(provider="claude"), upstream)) is None
    assert len(sent) == 3, "o que entrou pela 8765 o Rust já decidiu: não volta a ele"
    monkeypatch.setattr(runtime_coordinator, "rust_claude", lambda *args: (
        409, json.dumps({"detail": {"code": "erro_nome_em_uso", "params": {}, "msg": "ja existe uma sessao com esse nome"}}).encode()))
    with pytest.raises(HTTPException) as refused:
        asyncio.run(api_mod._open_in_rust(_body(provider="claude"), None))
    assert (refused.value.status_code, refused.value.detail["code"]) == (409, "erro_nome_em_uso")


def test_a_failed_guest_claim_undoes_the_worktree_this_open_created(monkeypatch, tmp_path):
    """S-66: o registro do convidado falhou depois de a sessão nascer: ela é encerrada e a worktree (e a
    branch que esta abertura criou) sai junto, senão a nova tentativa daria 409 na branch."""
    from app import guest_users, runtime_coordinator
    undo = {"source": "/r/repo", "path": "/r/repo-feat-x", "branch": "feat/x", "branch_created": True}
    monkeypatch.setattr(runtime_coordinator, "rust_claude",
                        lambda *args: (200, json.dumps({"info": INFO, "undo": undo}).encode()))
    killed, undone = [], []

    async def kill(name):
        killed.append(name)
    monkeypatch.setattr(api_mod, "_kill_unclaimed", kill)
    monkeypatch.setattr(api_mod, "_undo_worktree", undone.append)

    def refuse(name, guest_id):
        raise OSError("guests.json")
    monkeypatch.setattr(guest_users, "claim", refuse)
    marker = guest_users.current.set(SimpleNamespace(id="g1", name="ana", root=str(tmp_path)))
    try:
        with pytest.raises(OSError):
            asyncio.run(api_mod._open_in_rust(_body(provider="claude"), None))
    finally:
        guest_users.current.reset(marker)
    assert killed == ["s1"]
    assert undone == [{"source": "/r/repo", "path": "/r/repo-feat-x", "new_branch": "feat/x"}]
