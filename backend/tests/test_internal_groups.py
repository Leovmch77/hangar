"""Rotas internas que o Rust usa nas operações de grupo: fatos da orquestração."""
import pytest
from fastapi.testclient import TestClient

import app.api as api_mod
from app import internal_api, orq_context as oc, orq_md, orq_papeis as roles, pair
from app.adapters.orq import runs

SECRET = "cd" * 32
H = {"X-Hangar-Internal": SECRET}


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    internal_api.set_secret(SECRET)
    monkeypatch.setattr(pair.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(pair, "_pair_dir", lambda: tmp_path)
    monkeypatch.setattr(pair, "_arquivo_dir", lambda: tmp_path / "archive")
    monkeypatch.setattr(oc, "identity", lambda name: "identity:" + name)
    monkeypatch.setattr(oc, "active_gid", lambda name: None)
    monkeypatch.setattr(runs, "group_phase", lambda gid: None)
    yield
    internal_api.set_secret(None)


def _post(path, body, headers=H):
    return TestClient(api_mod.app, client=("127.0.0.1", 50000)).post(f"/internal/{path}", json=body, headers=headers)


def test_routes_need_the_secret():
    for path in ("orq/group-phase", "orq/promote", "orq/is-orchestrator"):
        assert _post(path, {}, headers={}).status_code == 404, path


def test_protocol_text_route_is_gone():
    assert _post("pair/text", {"kind": "orq"}).status_code == 404


def test_group_phase(monkeypatch):
    for phase in ("live", "ended", "unknown", None):
        monkeypatch.setattr(runs, "group_phase", lambda gid, phase=phase: phase if gid == "g1" else "errado")
        assert _post("orq/group-phase", {"gid": "g1"}).json() == {"phase": phase}


def test_promote_maps_conflicts_and_tolerates_missing_identity(monkeypatch):
    calls = []
    monkeypatch.setattr(oc, "promote", lambda name, gid: calls.append((name, gid)))
    r = _post("orq/promote", {"name": "a", "gid": "g1"})
    assert (r.status_code, r.json(), calls) == (200, {}, [("a", "g1")])

    def raising(exc):
        def promote(name, gid):
            raise exc
        return promote

    # Sem identidade não houve configuração para promover.
    monkeypatch.setattr(oc, "promote", raising(oc.IdentityUnavailable("sem identidade")))
    assert _post("orq/promote", {"name": "a", "gid": "g1"}).status_code == 200
    for exc in (oc.PromotionConflict("o time já pertence a outro grupo"), orq_md.Conflito("/x.md")):
        monkeypatch.setattr(oc, "promote", raising(exc))
        r = _post("orq/promote", {"name": "a", "gid": "g1"})
        assert r.status_code == 409
        assert r.json()["detail"] == {"code": "erro_orq_arquivo_mudou", "params": {}, "msg": str(exc)}


def test_promote_with_real_context_moves_the_draft():
    context = oc.resolve("a")
    text = roles.escrever_papel("", roles.Papel("executor", "x*", "codex", "c", "", ""))
    oc.write(context, text, 0.0)
    saved = context.path.read_text()
    assert _post("orq/promote", {"name": "a", "gid": "realgid"}).status_code == 200
    assert roles.regras_path("realgid").read_text() == saved
    r = _post("orq/promote", {"name": "b", "gid": "draft-x"})
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "erro_orq_arquivo_mudou")


def test_is_orchestrator(monkeypatch):
    monkeypatch.setattr(api_mod.orq_runs, "find", lambda name: {"name": name} if name.endswith("-orq") else None)
    r = _post("orq/is-orchestrator", {"names": ["a", "g1-orq", "b"]})
    assert r.json() == {"names": ["g1-orq"]}
