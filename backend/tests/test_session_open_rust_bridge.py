"""A abertura de Claude com terminal é do Rust: o que entra pelo Python vai à ponte dele, e as rotas
internas guardam aqui só o que é daqui (fila, `then`, diário, provedor lembrado)."""
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


def test_the_open_diary_keeps_the_rust_events_in_order_and_refuses_others():
    events = [{"evento": "sessao.criar.inicio", "nivel": "ok", "operacao": "ab"},
              {"evento": "sessao.criar_recusada", "nivel": "erro", "sessao": "s1", "provider": "claude",
               "etapa": "criar_terminal", "codigo": "terminal_morreu_ao_nascer", "detalhe": "exit 127", "operacao": "ab"},
              {"evento": "sessao.criar.fim", "nivel": "erro", "codigo": "excecao", "ms": 12, "operacao": "ab"}]
    with patch("app.internal_api.diag.registrar") as registrar:
        assert _post("/internal/diag/events", {"events": events}).status_code == 200
        assert _post("/internal/diag/events", {"events": [{"evento": "api.servidor", "nivel": "ok"}]}).status_code == 400
        assert _post("/internal/diag/events", {"events": [{**events[0], "texto": "conversa"}]}).status_code == 400
    calls = [c for c in registrar.call_args_list if c.args[0].startswith("sessao.")]
    assert [c.args[:2] for c in calls] == [("sessao.criar.inicio", "ok"), ("sessao.criar_recusada", "erro"), ("sessao.criar.fim", "erro")]
    assert calls[1].kwargs["detalhe"] == "exit 127"


def test_release_and_born_touch_only_what_lives_here(monkeypatch):
    released = []
    monkeypatch.setattr(api_mod.registry, "release_name", released.append)
    assert _post("/internal/sessions/s%201/release", {}).json() == {"ok": True}
    assert released == ["s 1"]
    from app import permission_mode, runtime_config
    from app.registry import SessionRegistry
    applied = []
    monkeypatch.setattr(runtime_config, "get", lambda key: "pi" if key == "last_session_provider" else None)
    monkeypatch.setattr(runtime_config, "aplicar", applied.append)
    body = {"session_id": "11111111-1111-4111-8111-111111111111", "jsonl": "/p/x.jsonl", "permission_mode": "acceptEdits",
            "remember_provider": "claude"}
    assert _post("/internal/sessions/s1/born", body).json() == {"avisos": []}
    assert SessionRegistry._jsonl_cache["s1"] == "/p/x.jsonl"
    assert permission_mode._launch_modes[body["session_id"]] == "acceptEdits"
    assert applied == [{"last_session_provider": "claude"}]
    assert _post("/internal/sessions/s1/born", {**body, "texto": 1}).status_code == 400


def _body(**kw):
    return api_mod.CreateBody(name="s1", cwd="/p", **kw)


def test_what_comes_through_python_opens_in_rust_and_the_rest_stays_here(monkeypatch):
    from app import runtime_coordinator
    sent = []

    def bridge(payload):
        sent.append(payload)
        return (200, json.dumps({"info": INFO, "undo": None}).encode()) if payload["request"].get("provider") == "claude" else None
    monkeypatch.setattr(runtime_coordinator, "rust_session_open", bridge)
    info = asyncio.run(api_mod._open_in_rust(_body(provider="claude", headless=False), None))
    assert (info.name, info.provider, info.owner) == ("s1", "claude", None)
    # Ausente continua ausente: o Rust decide o provedor padrão.
    assert sent[0] == {"request": {"name": "s1", "cwd": "/p", "provider": "claude", "headless": False}, "guest_root": None}
    assert asyncio.run(api_mod._open_in_rust(_body(provider="codex"), None)) is None
    declined = SimpleNamespace(headers={"x-hangar-open": "python"})
    assert asyncio.run(api_mod._open_in_rust(_body(provider="claude"), declined)) is None
    assert len(sent) == 2, "o que o Rust já olhou não volta à ponte"
    monkeypatch.setattr(runtime_coordinator, "rust_session_open", lambda payload: (
        409, json.dumps({"detail": {"code": "erro_nome_em_uso", "params": {}, "msg": "ja existe uma sessao com esse nome"}}).encode()))
    with pytest.raises(HTTPException) as refused:
        asyncio.run(api_mod._open_in_rust(_body(provider="claude"), None))
    assert (refused.value.status_code, refused.value.detail["code"]) == (409, "erro_nome_em_uso")


def test_a_failed_guest_claim_undoes_the_worktree_this_open_created(monkeypatch, tmp_path):
    """S-66: o registro do convidado falhou depois de a sessão nascer: ela é encerrada e a worktree (e a
    branch que esta abertura criou) sai junto, senão a nova tentativa daria 409 na branch."""
    from app import guest_users, runtime_coordinator
    undo = {"source": "/r/repo", "path": "/r/repo-feat-x", "branch": "feat/x", "branch_created": True}
    monkeypatch.setattr(runtime_coordinator, "rust_session_open",
                        lambda payload: (200, json.dumps({"info": INFO, "undo": undo}).encode()))
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
