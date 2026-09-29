"""Atalhos por projeto: a chave e o repo (worktrees e subpastas compartilham a lista), a lista
e validada na gravacao, e o atalho shell com `pasta` roda nela, relativa a raiz da copia."""
import json
import os
import threading

import pytest
from fastapi.testclient import TestClient

from app import api, git_ops, project_shortcuts as ps
from app.api import app
from app.config import settings


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "projects_dir", str(tmp_path / "state" / "projects"))


@pytest.fixture
def client():
    previous = settings.auth_token
    settings.auth_token = "secret"
    yield TestClient(app)
    settings.auth_token = previous


def _auth():
    return {"Authorization": "Bearer secret"}


def _git(d, *args):
    p = git_ops._run(str(d), *args)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()


@pytest.fixture
def repo(tmp_path):
    """Repo temporario com um commit e uma worktree irma em `wt`."""
    r = tmp_path / "meu-repo"
    (r / "sub").mkdir(parents=True)
    for args in (("init", "-q", "-b", "main"), ("config", "user.email", "t@t"),
                 ("config", "user.name", "t"), ("commit", "-q", "--allow-empty", "-m", "um")):
        _git(r, *args)
    _git(r, "worktree", "add", "-q", "-b", "feat", str(tmp_path / "wt"))
    return r


_SHELL = {"id": "p1", "type": "shell", "label": "Debug", "command": "true", "pasta": "sub"}


# --- chave do projeto ------------------------------------------------------------------------

def test_worktree_and_subfolder_share_the_repo_key(repo, tmp_path):
    main, sub, wt = (ps.project_of(str(p)) for p in (repo, repo / "sub", tmp_path / "wt"))
    assert main["key"] == sub["key"] == wt["key"] == os.path.normcase(str(repo.resolve()))
    assert main["name"] == "meu-repo"
    assert sub["root"] == str(repo.resolve())
    assert wt["root"] == str((tmp_path / "wt").resolve())


def test_folder_outside_git_uses_its_real_path(tmp_path):
    plain = tmp_path / "solta"
    plain.mkdir()
    (tmp_path / "atalho").symlink_to(plain)
    got = ps.project_of(str(tmp_path / "atalho"))
    assert got == {"key": str(plain.resolve()), "name": "solta", "root": str(plain.resolve())}


def test_missing_folder_or_git_failure_inside_repo_never_falls_back(repo, tmp_path, monkeypatch):
    with pytest.raises(ps.ProjectError, match="nao existe"):
        ps.project_of(str(tmp_path / "sumiu"))

    def timeout(*a, **k):
        raise git_ops.GitError(504, "git timeout")
    monkeypatch.setattr(git_ops, "_run", timeout)
    with pytest.raises(ps.ProjectError, match="git timeout"):
        ps.project_of(str(repo / "sub"))
    plain = tmp_path / "solta"
    plain.mkdir()
    assert ps.project_of(str(plain))["key"] == str(plain.resolve())


# --- validacao e gravacao --------------------------------------------------------------------

def test_save_load_and_empty_list_removes_the_key(tmp_path):
    ps.save_items("/a", [_SHELL])
    ps.save_items("/b", [{"id": "x", "type": "send_text", "label": "X", "text": "/x"}])
    assert ps.load_items("/a") == [_SHELL]
    ps.save_items("/a", [])
    stored = json.loads((tmp_path / "state" / ".hangar-project-shortcuts.json").read_text())
    assert list(stored) == ["/b"]
    assert ps.load_items("/a") == []


@pytest.mark.parametrize("items, msg", [
    ([{"id": "t", "type": "internal", "action": "terminal"}], "interno"),
    ([{**_SHELL, "pasta": "  "}], "pasta vazia"),
    ([{**_SHELL, "pasta": 3}], "pasta vazia"),
    ([_SHELL, {**_SHELL, "label": "Outro"}], "item 2: id 'p1' repetido"),
    ([{"id": "x", "type": "shell", "label": "X"}], "item 1 \\(shell\\) sem comando"),
    ({"id": "x"}, "esperado uma lista"),
])
def test_invalid_lists_are_rejected(items, msg):
    with pytest.raises(ValueError, match=msg):
        ps.save_items("/a", items)
    assert ps.load_items("/a") == []


def test_concurrent_saves_keep_every_project():
    threads = [threading.Thread(target=ps.save_items, args=(f"/p{i}", [_SHELL])) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(ps.load_items(f"/p{i}") == [_SHELL] for i in range(20))


def test_global_shortcuts_still_ignore_pasta():
    # `pasta` so vale por projeto: o validador global segue como era.
    from app import runtime_config as rc
    rc._validate_shortcuts(json.dumps([{**_SHELL, "pasta": 3}]))


# --- rotas -----------------------------------------------------------------------------------

def _session(monkeypatch, cwd):
    monkeypatch.setattr(api, "_session_cwd", lambda n: str(cwd))


def test_routes_require_auth(client):
    assert client.get("/api/sessions/s/project-shortcuts").status_code == 401
    assert client.put("/api/sessions/s/project-shortcuts", json={"items": []}).status_code == 401


def test_put_from_worktree_is_seen_from_main_checkout(client, monkeypatch, repo, tmp_path):
    _session(monkeypatch, tmp_path / "wt")
    r = client.put("/api/sessions/s/project-shortcuts", json={"items": [_SHELL]}, headers=_auth())
    assert r.status_code == 200
    assert r.json()["root"] == str((tmp_path / "wt").resolve())
    _session(monkeypatch, repo / "sub")
    got = client.get("/api/sessions/s/project-shortcuts", headers=_auth()).json()
    assert got == {"key": os.path.normcase(str(repo.resolve())), "name": "meu-repo",
                   "root": str(repo.resolve()), "items": [_SHELL]}


def test_put_invalid_is_400_and_bad_folder_is_409(client, monkeypatch, tmp_path):
    _session(monkeypatch, tmp_path)
    r = client.put("/api/sessions/s/project-shortcuts",
                   json={"items": [{"id": "t", "type": "internal", "action": "modo"}]}, headers=_auth())
    assert r.status_code == 400 and "interno" in r.json()["detail"]["msg"]
    _session(monkeypatch, tmp_path / "sumiu")
    r = client.get("/api/sessions/s/project-shortcuts", headers=_auth())
    assert r.status_code == 409 and "nao existe" in r.json()["detail"]["msg"]


@pytest.mark.parametrize("content", ["{nao e json", "[1, 2]", b"\xff\xfe"])
def test_unreadable_file_is_an_error_and_put_never_overwrites_it(client, monkeypatch, tmp_path,
                                                                 content):
    # Ler como "sem atalhos" fazia o PUT seguinte reescrever o arquivo so com este projeto.
    f = tmp_path / "state" / ".hangar-project-shortcuts.json"
    f.parent.mkdir(parents=True)
    (f.write_bytes if isinstance(content, bytes) else f.write_text)(content)
    before = f.read_bytes()
    _session(monkeypatch, tmp_path)
    r = client.get("/api/sessions/s/project-shortcuts", headers=_auth())
    assert r.status_code == 500 and r.json()["detail"]["code"] == "erro_project_shortcuts_arquivo"
    r = client.put("/api/sessions/s/project-shortcuts", json={"items": [_SHELL]}, headers=_auth())
    assert r.status_code == 500 and r.json()["detail"]["code"] == "erro_project_shortcuts_arquivo"
    assert f.read_bytes() == before


def test_shell_pasta_resolves_against_copy_root(client, monkeypatch, repo, tmp_path):
    from app import shortcut_terminals
    seen = {}
    monkeypatch.setattr(shortcut_terminals, "start", lambda name, cwd, *a, **kw: seen.setdefault("cwd", cwd)
                        and {"id": "x", "label": "", "tmux": "t"})
    monkeypatch.setattr(shortcut_terminals, "status", lambda t: (True, None))
    _session(monkeypatch, repo / "sub")

    def run(**extra):
        seen.clear()
        return client.post("/api/sessions/s/shortcut-shell", json={"command": "true", **extra},
                           headers=_auth())

    assert run().status_code == 202 and seen["cwd"] == str(repo / "sub")
    assert run(pasta="sub").status_code == 202 and seen["cwd"] == os.path.join(str(repo.resolve()), "sub")
    assert run(pasta=str(tmp_path)).status_code == 202 and seen["cwd"] == str(tmp_path)
    r = run(pasta="nada")
    assert r.status_code == 400 and r.json()["detail"]["code"] == "erro_shortcut_pasta"
