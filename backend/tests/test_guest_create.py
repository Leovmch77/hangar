# backend/tests/test_guest_create.py
import pytest

from app import fs, guest_users


@pytest.fixture
def ana(tmp_path, monkeypatch):
    monkeypatch.setattr(guest_users, "_path_override", tmp_path / "guests.json")
    guest_users._reset()
    (tmp_path / "p" / "sub").mkdir(parents=True)
    g, _ = guest_users.create("ana", str(tmp_path / "p"), False, True)
    marker = guest_users.current.set(g)
    yield g, tmp_path
    guest_users.current.reset(marker)
    guest_users._reset()


def test_guest_roots_are_only_his_folder(ana):
    g, _ = ana
    assert [str(r.path) for r in fs.list_roots()] == [g.root]


def test_guest_cannot_scan_owner_root(ana, monkeypatch):
    _, tmp = ana
    (tmp / "outra").mkdir()
    with pytest.raises(fs.FsError):
        fs.scan_dir(str(tmp / "outra"))


def test_guest_scans_inside_his_folder(ana):
    g, _ = ana
    assert fs.scan_dir(g.root) is not None


def test_create_outside_folder_is_403(ana, monkeypatch):
    from fastapi.testclient import TestClient
    from app.api import app
    from app.config import settings
    g, tmp = ana
    monkeypatch.setattr(settings, "auth_token", "secret")
    _, tok = guest_users.create("bia", g.root, False, True)
    (tmp / "fora").mkdir()
    r = TestClient(app).post("/api/sessions", headers={"Authorization": f"Bearer {tok}"},
                             json={"name": "x", "cwd": str(tmp / "fora")})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "erro_fora_da_pasta"


def test_create_inside_folder_claims_session(ana, monkeypatch):
    from fastapi.testclient import TestClient
    from app import api
    from app.models import SessionInfo
    g, _ = ana
    monkeypatch.setattr(api.settings, "auth_token", "secret")
    _, tok = guest_users.create("bia", g.root, False, True)
    claimed = []
    monkeypatch.setattr(guest_users, "claim", lambda session, gid: claimed.append((session, gid)))
    monkeypatch.setattr(api.registry, "create",
                        lambda name, cwd, config_dir, **kw: SessionInfo(name=name, cwd=cwd, provider="claude"))
    r = TestClient(api.app).post("/api/sessions", headers={"Authorization": f"Bearer {tok}"},
                                 json={"name": "x", "cwd": g.root + "/sub"})
    assert r.status_code == 200
    assert r.json()["owner"] == "bia"
    assert [c[0] for c in claimed] == ["x"]
