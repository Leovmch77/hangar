"""Grupo de orquestração `auto`: nasce com um membro só, não dissolve no último membro enquanto a
execução vive, dissolve como sempre depois dela, e as rotas de par recusam a linha do orquestrador."""
import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app import pair
from app.adapters.orq import runs
from app.config import settings
from app.models import SessionInfo
from app.pair import PairLink

H = {"Authorization": "Bearer secret"}


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(pair.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(pair, "_arquivo_dir", lambda: tmp_path / "arq")
    r = tmp_path / "orq"
    r.mkdir()
    monkeypatch.setattr(runs, "root", lambda: r)
    # Só "alive" importa aqui; o batimento tem testes próprios em test_orq_conductor*.
    monkeypatch.setattr(runs.orq_conductor, "watchdog", lambda d, units: {"alive": True, "arbiter": "arb"})
    return r


def _run(root, gid: str, ended: bool = False) -> None:
    d = root / f"2026-09-28-{gid}"
    d.mkdir()
    (d / "orq.json").write_text(json.dumps({"arbiter": "arb", "repo": str(root), "auto": True}),
                                encoding="utf-8")
    evs = [{"tipo": "execucao_inicio", "ts": "2026-09-28T10:00:00-03:00", "gid": gid,
            "plano": "p.md", "branch": "main"}]
    if ended:
        evs.append({"tipo": "execucao_fim", "ts": "2026-09-28T11:00:00-03:00", "resultado": "ok"})
    (d / "eventos.jsonl").write_text("".join(json.dumps(e) + "\n" for e in evs), encoding="utf-8")


def _solo_with_team(root, ended: bool = False):
    pair.join_group("arb", [], "obra", orq=True)
    gid = PairLink("arb").get()["gid"]
    pair.join_group("arb", ["exec"], orq=True)
    contrato = pair._pair_dir() / f"regras-{gid}.md"
    contrato.write_text("papéis", encoding="utf-8")
    _run(root, gid, ended)
    return gid, contrato


def test_orq_group_starts_with_one_member():
    members, _ = pair.join_group("arb", [], "obra", orq=True)
    link = PairLink("arb").get()
    assert members == ["arb"]
    assert link["peers"] == [] and link["orq"] is True and link["task"] == "obra"
    assert len(link["gid"]) == 8
    # O time que chega depois entra no mesmo gid.
    pair.join_group("arb", ["exec"], orq=True)
    assert PairLink("exec").get()["gid"] == link["gid"]


def test_live_auto_run_keeps_the_last_member(root):
    gid, contrato = _solo_with_team(root)
    assert pair.leave("exec") == ["arb"]
    link = PairLink("arb").get()
    assert link["peers"] == [] and link["gid"] == gid and link["orq"] is True
    assert contrato.exists()


def test_group_dissolves_normally_once_the_run_is_over(root, tmp_path):
    gid, contrato = _solo_with_team(root, ended=True)
    assert pair.leave("exec") == ["arb"]
    assert PairLink("arb").get() is None
    assert not contrato.exists()
    assert [p.name.startswith(f"regras-{gid}-") for p in (tmp_path / "arq").iterdir()] == [True]


def test_a_watchdog_restart_does_not_dissolve_a_live_run(root, monkeypatch):
    # Restart=always leaves a window with no heartbeat; the run itself is still alive.
    monkeypatch.setattr(runs.orq_conductor, "watchdog", lambda d, units: {"alive": False, "arbiter": "arb"})
    gid, contrato = _solo_with_team(root)
    assert pair.leave("exec") == ["arb"]
    assert PairLink("arb").get()["gid"] == gid
    assert contrato.exists()


def _end(root, gid):
    with (root / f"2026-09-28-{gid}" / "eventos.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"tipo": "execucao_fim", "ts": "2026-09-28T12:00:00-03:00",
                            "resultado": "ok"}) + "\n")


def test_lone_orq_group_dissolves_when_its_run_ends(root, tmp_path, monkeypatch):
    from app.registry import SessionRegistry
    monkeypatch.setattr(SessionRegistry, "_pair_ausencias", {})
    gid, contrato = _solo_with_team(root)
    pair.leave("exec")
    sweep = lambda: SessionRegistry.__new__(SessionRegistry)._varrer_pares_mortos({"arb"})
    sweep()
    assert PairLink("arb").get()["peers"] == []   # alive: kept
    _end(root, gid)
    sweep()   # the dead-pair sweep in list(): the hook reads the sidecar file, so it must go
    assert PairLink("arb").get() is None and not PairLink("arb").path.exists()
    assert not contrato.exists()
    assert [p.name.startswith(f"regras-{gid}-") for p in (tmp_path / "arq").iterdir()] == [True]


def test_lone_orq_group_before_its_run_starts_waits_for_the_launch():
    import os, time
    pair.join_group("arb", [], "obra", orq=True)   # the arbiter's step 2, before execucao_inicio
    pair.dissolve_lone_orq()
    assert PairLink("arb").get() is not None
    old = time.time() - pair.ORQ_LAUNCH_GRACE_S - 1
    os.utime(PairLink("arb").path, (old, old))       # launch abandoned
    pair.dissolve_lone_orq()
    assert PairLink("arb").get() is None


def _old_lone_orq():
    import os, time
    pair.join_group("arb", [], "obra", orq=True)
    old = time.time() - pair.ORQ_LAUNCH_GRACE_S - 1
    os.utime(PairLink("arb").path, (old, old))


def test_unreadable_runs_root_never_dissolves_a_lone_orq_group(root, caplog):
    _old_lone_orq()
    root.chmod(0)
    try:
        assert runs.group_phase(PairLink("arb").get()["gid"]) == "unknown"
        assert pair.dissolve_lone_orq() == []
    finally:
        root.chmod(0o755)
    assert PairLink("arb").get() is not None
    assert "orq" in caplog.text


def test_an_unreadable_runs_root_is_warned_once(root, caplog):
    root.chmod(0)
    try:
        for _ in range(3):
            assert runs.group_phase("g") == "unknown"
    finally:
        root.chmod(0o755)
    assert len([r for r in caplog.records if "ilegíveis" in r.getMessage()]) == 1


def test_unreadable_events_never_dissolve_a_lone_orq_group(root):
    _old_lone_orq()
    _run(root, PairLink("arb").get()["gid"], ended=True)
    ev = next(root.iterdir()) / "eventos.jsonl"
    ev.unlink()
    ev.mkdir()   # read_text raises IsADirectoryError: the run may be this group's, alive
    assert pair.dissolve_lone_orq() == []
    assert PairLink("arb").get() is not None


def test_last_member_leaving_with_an_unreadable_run_keeps_the_group(root):
    gid, contrato = _solo_with_team(root)
    ev = next(root.iterdir()) / "eventos.jsonl"
    ev.unlink()
    ev.mkdir()
    assert pair.leave("exec") == ["arb"]
    assert PairLink("arb").get()["gid"] == gid
    assert contrato.exists()


def test_last_member_leaving_a_live_run_keeps_the_contract(root, tmp_path):
    # O orquestrador lê o regras-<gid>.md a cada kick-off: arquivar com a execução viva o quebraria.
    gid, contrato = _solo_with_team(root)
    pair.leave("exec")
    pair.leave("arb")
    assert PairLink("arb").get() is None
    assert contrato.exists()


def test_plain_group_ignores_the_run(root):
    pair.join("a", "b")
    _run(root, PairLink("a").get()["gid"])
    pair.leave("a")
    assert PairLink("b").get() is None


# ── Rotas ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "secret")
    from app.api import app
    return TestClient(app)


def test_pair_without_peer_opens_an_orq_group_of_one(client):
    with patch("app.api.registry.list", return_value=[SessionInfo(name="arb", cwd="/p")]):
        r = client.post("/api/sessions/arb/pair", headers=H, json={"task": "obra", "orq": True})
    assert r.status_code == 200, r.text
    assert r.json()["members"] == ["arb"]
    assert r.json()["gid"] == PairLink("arb").get()["gid"]
    assert r.json()["warning"] is None


def test_pair_without_peer_outside_orq_is_still_refused(client):
    with patch("app.api.registry.list", return_value=[SessionInfo(name="arb", cwd="/p")]):
        r = client.post("/api/sessions/arb/pair", headers=H, json={"task": "obra"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "erro_peer_nao_informado"


@pytest.mark.parametrize("method,path,body", [
    ("post", "/api/sessions/arb/pair", {"peer": "g1-orq", "orq": True}),
    ("post", "/api/sessions/g1-orq/pair", {"peer": "arb"}),
    ("delete", "/api/sessions/g1-orq/pair", None),
    ("post", "/api/sessions/g1-orq/pair-remote", {"initiator": "srv::arb"}),
])
def test_pair_routes_refuse_the_orchestrator_row(root, client, method, path, body):
    _run(root, "g1")
    sessions = [SessionInfo(name="arb", cwd="/p"), SessionInfo(name="g1-orq", cwd="/p", provider="orq")]
    kw = {"json": body} if body is not None else {}
    with patch("app.api.registry.list", return_value=sessions), \
         patch("app.api._deliver", AsyncMock(return_value=None)):
        r = getattr(client, method)(path, headers=H, **kw)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "erro_sessao_orq"
    assert PairLink("arb").get() is None
