import pytest
from fastapi.testclient import TestClient

from app import guest_users
from app.config import settings


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "secret")
    monkeypatch.setattr(guest_users, "_path_override", tmp_path / "guests.json")
    guest_users._reset()
    (tmp_path / "p").mkdir()
    from app.api import app
    yield TestClient(app), str(tmp_path / "p")
    guest_users._reset()


OWNER = {"Authorization": "Bearer secret"}


def test_owner_creates_updates_deletes(client):
    c, root = client
    r = c.post("/api/guests", headers=OWNER,
               json={"name": "ana", "root": root, "sees_owner": False, "owner_sees": True})
    assert r.status_code == 200
    gid, tok = r.json()["id"], r.json()["token"]
    assert c.get("/api/me", headers={"Authorization": f"Bearer {tok}"}).json() == {"role": "guest", "name": "ana"}
    assert c.get("/api/me", headers=OWNER).json() == {"role": "owner", "name": None}
    assert c.post(f"/api/guests/{gid}", headers=OWNER,
                  json={"root": root, "sees_owner": True, "owner_sees": False}).status_code == 200
    assert c.post(f"/api/guests/{gid}/delete", headers=OWNER).json() == {"ok": True}
    assert c.get("/api/me", headers={"Authorization": f"Bearer {tok}"}).status_code == 401


def test_missing_folder_is_400(client):
    c, root = client
    r = c.post("/api/guests", headers=OWNER,
               json={"name": "ana", "root": root + "/nao-existe", "sees_owner": False, "owner_sees": True})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "erro_pasta_inexistente"


def test_guest_cannot_manage_guests(client):
    c, root = client
    tok = c.post("/api/guests", headers=OWNER,
                 json={"name": "ana", "root": root, "sees_owner": False, "owner_sees": True}).json()["token"]
    r = c.post("/api/guests", headers={"Authorization": f"Bearer {tok}"},
               json={"name": "x", "root": root, "sees_owner": True, "owner_sees": True})
    assert r.status_code == 403


def test_update_and_delete_force_list_republish(client):
    from app import sse
    c, root = client
    gid = c.post("/api/guests", headers=OWNER,
                 json={"name": "ana", "root": root, "sees_owner": False, "owner_sees": True}).json()["id"]
    sse._list_refresher.sig = "velha"
    c.post(f"/api/guests/{gid}", headers=OWNER,
           json={"root": root, "sees_owner": True, "owner_sees": False})
    assert sse._list_refresher.sig is None
    sse._list_refresher.sig = "velha"
    c.post(f"/api/guests/{gid}/delete", headers=OWNER)
    assert sse._list_refresher.sig is None
