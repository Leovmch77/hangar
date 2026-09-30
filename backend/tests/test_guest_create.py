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
    from app import api
    from app.api import app
    from app.config import settings
    from app.models import SessionInfo
    g, tmp = ana
    monkeypatch.setattr(settings, "auth_token", "secret")
    _, tok = guest_users.create("bia", g.root, False, True)
    (tmp / "fora").mkdir()
    # Sem efeito real se a recusa regredir.
    monkeypatch.setattr(api.registry, "create",
                        lambda name, cwd, config_dir, **kw: SessionInfo(name=name, cwd=cwd, provider="claude"))
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


def test_rename_moves_guest_ownership(ana, monkeypatch):
    from app import api
    g, _ = ana
    monkeypatch.setattr(guest_users, "session_life", lambda n: "t:1")
    guest_users.claim("velho", g.id)
    monkeypatch.setattr(api, "_recusa_orq", lambda n: None)
    monkeypatch.setattr(api, "_headless", lambda n: True)
    monkeypatch.setattr(api, "_session_exists", lambda n: False)
    monkeypatch.setattr(api.registry, "rename", lambda a, b: None)
    monkeypatch.setattr(api, "_invalidate_lists", lambda: None)
    monkeypatch.setattr(api.share_store, "rename", lambda a, b: None)
    monkeypatch.setattr(api.bastao_mod, "caminho", lambda n: ana[1] / f"bastao-{n}")
    assert api._rename_session("velho", api.RenameBody(new="novo")) == {"ok": True, "name": "novo"}
    assert guest_users.owner_of("novo").id == g.id
    assert guest_users.owner_of("velho") is None


@pytest.fixture
def guest_shortcut(ana, monkeypatch):
    from fastapi.testclient import TestClient
    from app import api, shortcut_terminals
    g, tmp = ana
    monkeypatch.setattr(api.settings, "auth_token", "secret")
    monkeypatch.setattr(guest_users, "session_life", lambda n: "t:1")
    _, tok = guest_users.create("bia", g.root, False, True)
    bia = guest_users.lookup_token(tok)
    guest_users.claim("cc", bia.id)
    monkeypatch.setattr(api, "_session_cwd", lambda n: g.root)
    started = []
    monkeypatch.setattr(shortcut_terminals, "start", lambda *a, **k: started.append(a) or None)
    monkeypatch.setattr(shortcut_terminals, "start_hangar", lambda *a, **k: started.append(a) or (None, False))
    client = TestClient(api.app)
    return lambda **body: client.post("/api/sessions/cc/shortcut-shell",
                                      headers={"Authorization": f"Bearer {tok}"},
                                      json={"command": "ls", **body}), started, tmp


def test_guest_user_cannot_run_hangar_shortcut(guest_shortcut):
    post, started, _ = guest_shortcut
    r = post(runs_in="hangar", key="global:k")
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "erro_shortcut_hangar_convidado"
    assert started == []


def test_guest_user_shortcut_folder_must_be_inside_his_root(guest_shortcut):
    post, started, tmp = guest_shortcut
    r = post(pasta=str(tmp))
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "erro_fora_da_pasta"
    assert started == []


def test_failed_claim_kills_the_new_session_and_surfaces(ana, monkeypatch):
    from fastapi.testclient import TestClient
    from app import api
    from app.models import SessionInfo
    g, _ = ana
    monkeypatch.setattr(api.settings, "auth_token", "secret")
    _, tok = guest_users.create("bia", g.root, False, True)

    def claim_fails(session, gid):
        raise OSError("disco cheio")
    killed = []
    monkeypatch.setattr(guest_users, "claim", claim_fails)
    monkeypatch.setattr(api.registry, "create",
                        lambda name, cwd, config_dir, **kw: SessionInfo(name=name, cwd=cwd, provider="claude"))
    monkeypatch.setattr(api.registry, "kill", killed.append)
    r = TestClient(api.app, raise_server_exceptions=False).post(
        "/api/sessions", headers={"Authorization": f"Bearer {tok}"},
        json={"name": "x", "cwd": g.root + "/sub"})
    assert r.status_code == 500
    assert killed == ["x"]


def test_rename_survives_guest_claim_failure(ana, monkeypatch):
    from app import api, pqueue, tmux
    _, tmp = ana

    def boom(a, b):
        raise OSError("disco cheio")
    monkeypatch.setattr(guest_users, "rename_session", boom)
    monkeypatch.setattr(api, "_recusa_orq", lambda n: None)
    monkeypatch.setattr(api, "_headless", lambda n: False)
    monkeypatch.setattr(api, "_codex_sem_terminal", lambda n: False)
    monkeypatch.setattr(tmux, "has_session", lambda n: n == "velho")
    monkeypatch.setattr(api.headless_sessions, "exists", lambda n: False)
    monkeypatch.setattr(tmux, "rename_session", lambda a, b: True)
    monkeypatch.setattr(api.registry, "rename", lambda a, b: None)
    monkeypatch.setattr(api.share_store, "rename", lambda a, b: None)
    monkeypatch.setattr(api.bastao_mod, "caminho", lambda n: tmp / f"bastao-{n}")
    monkeypatch.setattr(pqueue, "_queue_dir", lambda: tmp)
    (tmp / "velho.jsonl").write_text("q")
    (tmp / "bastao-velho").write_text("b")
    assert api._rename_session("velho", api.RenameBody(new="novo")) == {"ok": True, "name": "novo"}
    assert (tmp / "novo.jsonl").read_text() == "q"
    assert (tmp / "bastao-novo").read_text() == "b"


def test_mode_switch_result_survives_guest_life_failure(ana, monkeypatch):
    from fastapi.testclient import TestClient
    from app import api

    async def troca(name, body):
        return {"ok": True, "terminal": False}

    def boom(session, life):
        raise OSError("disco cheio")
    monkeypatch.setattr(api.settings, "auth_token", "secret")
    monkeypatch.setattr(api, "_trocar_modo", troca)
    monkeypatch.setattr(api, "session_life", lambda n: "k:novo")
    monkeypatch.setattr(api.share_store, "set_life", lambda n, life: None)
    monkeypatch.setattr(guest_users, "set_life", boom)
    r = TestClient(api.app).post("/api/sessions/proj/modo-execucao", json={"terminal": False},
                                 headers={"Authorization": "Bearer secret"})
    assert r.status_code == 200 and r.json() == {"ok": True, "terminal": False}
