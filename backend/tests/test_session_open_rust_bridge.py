"""A abertura de Claude com terminal é do Rust: só o que entrou direto no Python (Connect, MCP) vai à
ponte dele, e as rotas internas guardam aqui só o que é daqui (registro em espera, `then`); o dono da sessão do convidado o Rust grava."""
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


def test_release_and_birth_are_all_rust():
    assert _post("/internal/sessions/s1/release", {}).status_code == 404, "soltar o nome é todo do Rust"
    assert _post("/internal/sessions/s1/born", {}).status_code == 404, "o nascimento é todo do Rust"


def test_the_guest_claim_is_written_by_the_rust_not_here():
    assert _post("/internal/guests/claim", {"session": "s1", "guest": "g1"}).status_code == 404


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
    connect = SimpleNamespace(scope={"server": ("127.0.0.1", CONNECT_PORT)})
    info = asyncio.run(api_mod._open_in_rust(_body(provider="claude", headless=False), connect))
    assert (info.name, info.provider, info.owner) == ("s1", "claude", None)
    # Ausente continua ausente: o Rust decide o provedor padrão.
    assert sent[0] == ("s1", "open", "POST", {"request": {"name": "s1", "cwd": "/p", "provider": "claude", "headless": False}, "guest": None})
    assert asyncio.run(api_mod._open_in_rust(_body(provider="codex"), connect)) is None
    upstream = SimpleNamespace(scope={"server": ("127.0.0.1", 49152)})
    assert asyncio.run(api_mod._open_in_rust(_body(provider="claude"), upstream)) is None
    # Sem pedido HTTP ninguém cria por dentro do Python: o MCP abre no Rust.
    assert asyncio.run(api_mod._open_in_rust(_body(provider="claude"), None)) is None
    assert len(sent) == 2, "o que entrou pela 8765 o Rust já decidiu: não volta a ele"
    monkeypatch.setattr(runtime_coordinator, "rust_claude", lambda *args: (
        409, json.dumps({"detail": {"code": "erro_nome_em_uso", "params": {}, "msg": "ja existe uma sessao com esse nome"}}).encode()))
    with pytest.raises(HTTPException) as refused:
        asyncio.run(api_mod._open_in_rust(_body(provider="claude"), connect))
    assert (refused.value.status_code, refused.value.detail["code"]) == (409, "erro_nome_em_uso")


def test_the_connect_guest_goes_to_the_rust_by_id_and_is_not_claimed_here(monkeypatch):
    """O Rust grava o dono no `guests.json`: daqui só vai o id do convidado autenticado."""
    from app import guest_users, runtime_coordinator
    from app.connect_port import CONNECT_PORT
    sent = []
    monkeypatch.setattr(runtime_coordinator, "rust_claude", lambda *args: (
        sent.append(json.loads(args[3])), (200, json.dumps({"info": {**INFO, "owner": "ana"}}).encode()))[1])
    monkeypatch.setattr(guest_users, "claim", lambda *a: pytest.fail("o dono é gravado pelo Rust"))
    marker = guest_users.current.set(SimpleNamespace(id="g1", name="ana", root="/casa/ana"))
    try:
        info = asyncio.run(api_mod._open_in_rust(_body(provider="claude"), SimpleNamespace(scope={"server": ("127.0.0.1", CONNECT_PORT)})))
    finally:
        guest_users.current.reset(marker)
    assert sent[0]["guest"] == "g1" and "guest_root" not in sent[0]
    assert info.owner == "ana"
