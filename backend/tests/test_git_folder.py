"""Git da pasta da tela de nova conversa: fetch, pull só fast-forward, troca e criação de branch
sem nunca descartar trabalho, e a fronteira de raiz das rotas /api/fs/git*."""
import pytest

from app import git_ops
from app.git_ops import GitError


def _git(d, *args):
    p = git_ops._run(str(d), *args)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()


def _setup(tmp_path):
    """origem com um commit + clone `trab` rastreando origin/main + branch remota `extra`."""
    o = tmp_path / "origem"
    o.mkdir()
    for args in (("init", "-q", "-b", "main"), ("config", "user.email", "t@t"), ("config", "user.name", "t"),
                 ("commit", "-q", "--allow-empty", "-m", "um"), ("branch", "extra")):
        _git(o, *args)
    _git(tmp_path, "clone", "-q", "origem", "trab")
    t = tmp_path / "trab"
    _git(t, "config", "user.email", "t@t")
    _git(t, "config", "user.name", "t")
    return o, t


def _code(exc: GitError) -> str | None:
    return exc.detail.get("code") if isinstance(exc.detail, dict) else None


def test_status_reports_branch_upstream_and_non_repo(tmp_path):
    _, t = _setup(tmp_path)
    st = git_ops.folder_status(str(t))
    assert (st["repo"], st["current"], st["upstream"], st["dirty"], st["ahead"], st["behind"]) == \
        (True, "main", "origin/main", 0, 0, 0)
    loose = tmp_path / "solta"
    loose.mkdir()
    assert git_ops.folder_status(str(loose)) == {"repo": False}


def test_fetch_then_pull_fast_forwards(tmp_path):
    o, t = _setup(tmp_path)
    _git(o, "commit", "-q", "--allow-empty", "-m", "dois")
    st = git_ops.folder_fetch(str(t))
    assert st["behind"] == 1 and st["last_fetch"]
    st = git_ops.folder_pull(str(t))
    assert st["behind"] == 0
    assert _git(t, "rev-parse", "HEAD") == _git(o, "rev-parse", "HEAD")


def test_pull_refuses_dirty_tree_without_touching_it(tmp_path):
    o, t = _setup(tmp_path)
    _git(o, "commit", "-q", "--allow-empty", "-m", "dois")
    (t / "novo.txt").write_text("meu trabalho")
    with pytest.raises(GitError) as exc:
        git_ops.folder_pull(str(t))
    assert _code(exc.value) == "erro_git_folder_dirty" and exc.value.detail["params"]["n"] == 1
    assert (t / "novo.txt").read_text() == "meu trabalho"
    assert _git(t, "rev-parse", "HEAD") != _git(o, "rev-parse", "HEAD")


def test_pull_refuses_diverged_branch(tmp_path):
    o, t = _setup(tmp_path)
    _git(o, "commit", "-q", "--allow-empty", "-m", "remoto")
    _git(t, "commit", "-q", "--allow-empty", "-m", "local")
    local = _git(t, "rev-parse", "HEAD")
    with pytest.raises(GitError) as exc:
        git_ops.folder_pull(str(t))
    assert _code(exc.value) == "erro_git_folder_diverged"
    assert _git(t, "rev-parse", "HEAD") == local


def test_switch_refuses_dirty_and_unconfirmed_sessions(tmp_path):
    _, t = _setup(tmp_path)
    (t / "novo.txt").write_text("x")
    with pytest.raises(GitError) as exc:
        git_ops.folder_switch(str(t), "extra", [], False)
    assert _code(exc.value) == "erro_git_folder_dirty"
    (t / "novo.txt").unlink()
    with pytest.raises(GitError) as exc:
        git_ops.folder_switch(str(t), "extra", ["chat"], False)
    assert _code(exc.value) == "erro_git_folder_sessions"
    assert git_ops.folder_status(str(t))["current"] == "main"
    assert git_ops.folder_switch(str(t), "extra", ["chat"], True)["current"] == "extra"


def test_create_branch_validates_name_and_uses_base(tmp_path):
    o, t = _setup(tmp_path)
    with pytest.raises(GitError) as exc:
        git_ops.folder_create_branch(str(t), "nome ruim", None, False, [], False)
    assert exc.value.status == 400
    with pytest.raises(GitError):
        git_ops.folder_create_branch(str(t), "-D", None, False, [], False)
    st = git_ops.folder_create_branch(str(t), "nova", "extra", True, [], False)
    assert st["current"] == "nova"
    assert _git(t, "rev-parse", "HEAD") == _git(o, "rev-parse", "extra")
    with pytest.raises(GitError):
        git_ops.folder_create_branch(str(t), "outra", "nao-existe", False, [], False)


def test_routes_keep_the_folder_inside_the_roots_and_list_sessions(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app import api, fs
    from app.models import SessionInfo

    _, t = _setup(tmp_path)
    monkeypatch.setattr(fs, "resolve_scan_roots", lambda _settings: [tmp_path])
    monkeypatch.setattr(api.settings, "auth_token", "test-token")
    monkeypatch.setattr(api, "_guardar_snap", lambda: [SessionInfo(name="chat", cwd=str(t), provider="claude"),
                                                       SessionInfo(name="fora", cwd=str(tmp_path), provider="claude")])
    client = TestClient(api.app)
    auth = {"Authorization": "Bearer test-token"}
    st = client.get("/api/fs/git", params={"root": str(tmp_path), "path": str(t)}, headers=auth)
    assert st.status_code == 200, st.text
    assert st.json()["sessions"] == ["chat"]
    assert client.get("/api/fs/git", params={"root": str(t), "path": str(tmp_path)}, headers=auth).status_code in (400, 403)
    body = {"root": str(tmp_path), "path": str(t), "branch": "extra"}
    refused = client.post("/api/fs/git/switch", json=body, headers=auth)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "erro_git_folder_sessions"
    ok = client.post("/api/fs/git/switch", json={**body, "confirm_sessions": True}, headers=auth)
    assert ok.status_code == 200 and ok.json()["current"] == "extra"

    # Raiz liberada DENTRO do repositório: ler pode, escrever no repo acima dela não.
    inner = t / "inner"
    inner.mkdir()
    monkeypatch.setattr(fs, "resolve_scan_roots", lambda _settings: [inner])
    assert client.get("/api/fs/git", params={"root": str(inner)}, headers=auth).status_code == 200
    assert client.post("/api/fs/git/fetch", json={"root": str(inner)}, headers=auth).status_code == 400
