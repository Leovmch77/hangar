"""Atalhos configuráveis: validação do campo `shortcuts` e terminais dos atalhos shell.

O que esta suíte trava: config quebrada é recusada na GRAVAÇÃO com o item apontado (o resolve do
front é tolerante e cairia no conjunto nativo, calado); o endpoint shell roda no cwd da sessão num
terminal escondido próprio, sem esperar o comando terminar, e só avisa quando ele falha logo de
cara; o terminal fica listado até alguém fechar, e só a sessão dona o alcança.
"""
import json
import os
import shutil
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import runtime_config as rc
from app.api import app
from app.config import settings


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(rc, "_backend_config_base", lambda: tmp_path)
    yield


@pytest.fixture
def client():
    """Mesmo arranjo de test_api.py: sem armar o token, toda rota devolve 401."""
    previous = settings.auth_token
    settings.auth_token = "secret"
    yield TestClient(app)
    settings.auth_token = previous


def _as_json(*items) -> str:
    return json.dumps(list(items))


# --- validação na gravação -------------------------------------------------------------------

def test_valid_list_is_accepted_and_empty_restores_default():
    value = _as_json(
        {"id": "terminal", "type": "internal", "action": "terminal"},
        {"id": "a1", "type": "send_text", "label": "Relatório", "text": "/relatorio-pm",
         "icon": "emoji:📋", "send_direct": True},
        {"id": "a2", "type": "shell", "label": "Editor", "command": "code .", "confirm": True},
    )
    rc.aplicar({"shortcuts": value})
    assert rc.get("shortcuts") == value
    rc.aplicar({}, remover={"shortcuts"})
    assert rc.get("shortcuts") == ""


def test_broken_json_is_rejected():
    with pytest.raises(ValueError, match="JSON invalido"):
        rc.aplicar({"shortcuts": "{nao é json"})


def test_unknown_type_is_rejected_naming_the_item():
    with pytest.raises(ValueError, match="item 2"):
        rc.aplicar({"shortcuts": _as_json(
            {"id": "terminal", "type": "internal", "action": "terminal"},
            {"id": "x", "type": "foguete"},
        )})


def test_internal_with_unknown_action_is_rejected():
    with pytest.raises(ValueError, match="action desconhecida"):
        rc.aplicar({"shortcuts": _as_json({"id": "x", "type": "internal", "action": "jetpack"})})


def test_item_missing_required_field_is_rejected():
    with pytest.raises(ValueError, match="sem texto"):
        rc.aplicar({"shortcuts": _as_json({"id": "x", "type": "send_text", "label": "Oi"})})
    with pytest.raises(ValueError, match="sem comando"):
        rc.aplicar({"shortcuts": _as_json({"id": "x", "type": "shell", "label": "Oi", "command": " "})})
    with pytest.raises(ValueError, match="sem rotulo"):
        rc.aplicar({"shortcuts": _as_json({"id": "x", "type": "shell", "command": "true"})})
    with pytest.raises(ValueError, match="sem id"):
        rc.aplicar({"shortcuts": _as_json({"type": "internal", "action": "rodar"})})


def test_value_must_be_a_list():
    with pytest.raises(ValueError, match="esperado uma lista"):
        rc.aplicar({"shortcuts": json.dumps({"id": "x"})})


# --- endpoint shell --------------------------------------------------------------------------

def test_shell_requires_auth(client):
    assert client.post("/api/sessions/s/shortcut-shell",
                       json={"command": "true"}).status_code == 401


def test_shell_unknown_session_returns_404(client, monkeypatch):
    from app import api
    monkeypatch.setattr(api, "_cached_info_sync", lambda name: None)
    r = client.post("/api/sessions/nada/shortcut-shell", json={"command": "true"},
                    headers={"Authorization": "Bearer secret"})
    assert r.status_code == 404


def _auth():
    return {"Authorization": "Bearer secret"}


@pytest.fixture
def private_tmux(monkeypatch):
    """Todo `tmux` do backend vai pra um socket proprio: nada encosta nas sessoes de quem roda."""
    if shutil.which("tmux") is None or os.name != "posix":
        pytest.skip("terminal de atalho precisa de tmux (POSIX)")
    from app import tmux
    from tmux_teste import matar_servidor, novo_socket
    sock = novo_socket()

    def run(args, **kw):
        if args and args[0] == "tmux":
            args = ["tmux", "-L", sock, *args[1:]]
        return subprocess.run(args, **kw)
    monkeypatch.setattr(tmux, "RUN", run)
    monkeypatch.setattr(tmux, "_scope_prefix", lambda: [])
    yield sock
    matar_servidor(sock)


def _wait_file(path, timeout=5.0):
    limit = time.monotonic() + timeout
    while time.monotonic() < limit:
        if path.exists() and path.read_text().strip():
            return path.read_text().strip()
        time.sleep(0.05)
    return path.read_text().strip() if path.exists() else ""


def _run(client, monkeypatch, cwd, command, name="s", **extra):
    from app import api
    monkeypatch.setattr(api, "_session_cwd", lambda n: str(cwd))
    return client.post(f"/api/sessions/{name}/shortcut-shell", json={"command": command, **extra},
                       headers=_auth())


def test_shell_runs_in_session_cwd_and_returns_its_terminal(client, monkeypatch, tmp_path, private_tmux):
    monkeypatch.setenv("SHELL", "/bin/sh")
    r = _run(client, monkeypatch, tmp_path, "pwd > prova.txt", label="Onde")
    assert r.status_code == 202
    body = r.json()
    assert body["ok"] is True and body["terminal"]["label"] == "Onde"
    assert _wait_file(tmp_path / "prova.txt") == str(tmp_path)


def test_shell_runs_under_user_shell_not_sh(client, monkeypatch, tmp_path, private_tmux):
    # funcao do fish (delphi-vm) so existe no shell do usuario: o atalho tem que usar $SHELL
    fake = tmp_path / "meushell"
    fake.write_text('#!/bin/sh\necho "via-meushell $2" > "$PWD/prova.txt"\n')
    fake.chmod(0o755)
    monkeypatch.setenv("SHELL", str(fake))
    assert _run(client, monkeypatch, tmp_path, "delphi-vm").status_code == 202
    assert _wait_file(tmp_path / "prova.txt") == "via-meushell delphi-vm"


def test_shell_command_failing_within_window_returns_422_and_keeps_the_terminal(
        client, monkeypatch, tmp_path, private_tmux):
    # quem clicou tem que ver que falhou (codigo + fim da saida) e ainda poder abrir a aba
    monkeypatch.setenv("SHELL", "/bin/sh")
    r = _run(client, monkeypatch, tmp_path, "echo boom >&2; exit 3")
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "erro_shortcut_falhou"
    assert "3" in detail["msg"] and "boom" in detail["msg"]
    assert "Pane is dead" not in detail["msg"]
    ident = detail["params"]["terminal"]["id"]
    listed = client.get("/api/sessions/s/shortcut-terminals", headers=_auth()).json()["terminals"]
    assert [(t["id"], t["alive"], t["exit_code"]) for t in listed] == [(ident, False, 3)]


def test_shell_command_still_running_after_window_is_ok(client, monkeypatch, tmp_path, private_tmux):
    from app import api
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(api, "_SHORTCUT_FAIL_WINDOW", 0.3)
    started = time.monotonic()
    r = _run(client, monkeypatch, tmp_path, "sleep 5")
    assert r.status_code == 202 and r.json()["terminal"]["alive"] is True
    assert time.monotonic() - started < 3


def test_list_is_per_session_and_label_falls_back_to_command(client, monkeypatch, tmp_path, private_tmux):
    from app import api
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(api, "_SHORTCUT_FAIL_WINDOW", 0.2)
    _run(client, monkeypatch, tmp_path, "sleep 30", name="a", label="Primeiro")
    _run(client, monkeypatch, tmp_path, "sleep 31", name="a")
    _run(client, monkeypatch, tmp_path, "sleep 32", name="b")
    listed = client.get("/api/sessions/a/shortcut-terminals", headers=_auth()).json()["terminals"]
    assert [t["label"] for t in listed] == ["Primeiro", "sleep 31"]
    assert all(t["alive"] and t["exit_code"] is None and t["created"] > 0 for t in listed)
    assert len(client.get("/api/sessions/b/shortcut-terminals", headers=_auth()).json()["terminals"]) == 1


def test_close_kills_the_process_tree_and_removes_the_terminal(client, monkeypatch, tmp_path, private_tmux):
    # o RDP do atalho roda em primeiro plano no shell: fechar a aba tem que derrubar ele junto
    from app import api
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(api, "_SHORTCUT_FAIL_WINDOW", 0.2)
    # `trap '' HUP`: o filho ignora o SIGHUP do pty fechado, como um programa que o trata
    r = _run(client, monkeypatch, tmp_path, "trap '' HUP; sleep 300 & echo $! > filho.pid; wait")
    ident = r.json()["terminal"]["id"]
    child = int(_wait_file(tmp_path / "filho.pid"))
    closed = client.post(f"/api/sessions/s/shortcut-terminals/{ident}/close", headers=_auth())
    assert closed.status_code == 200
    assert client.get("/api/sessions/s/shortcut-terminals", headers=_auth()).json()["terminals"] == []
    limit = time.monotonic() + 3
    while time.monotonic() < limit and os.path.exists(f"/proc/{child}"):
        time.sleep(0.05)
    assert not os.path.exists(f"/proc/{child}")


def test_close_refuses_terminal_of_another_session(client, monkeypatch, tmp_path, private_tmux):
    from app import api
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(api, "_SHORTCUT_FAIL_WINDOW", 0.2)
    ident = _run(client, monkeypatch, tmp_path, "sleep 30", name="dono").json()["terminal"]["id"]
    r = client.post(f"/api/sessions/outra/shortcut-terminals/{ident}/close", headers=_auth())
    assert r.status_code == 404
    assert len(client.get("/api/sessions/dono/shortcut-terminals", headers=_auth()).json()["terminals"]) == 1


def test_list_and_close_require_auth(client):
    assert client.get("/api/sessions/s/shortcut-terminals").status_code == 401
    assert client.post("/api/sessions/s/shortcut-terminals/abcdef/close").status_code == 401


def test_session_close_and_rename_carry_the_shortcut_terminals(monkeypatch, tmp_path, private_tmux):
    from app import shortcut_terminals as st
    monkeypatch.setenv("SHELL", "/bin/sh")
    st.start("velho", str(tmp_path), "sleep 30", "x", {})
    st.rename_owner("velho", "novo")
    assert st.list_for("velho") == [] and len(st.list_for("novo")) == 1
    st.close_all("novo")
    assert st.list_for("novo") == []


def test_terminal_is_hidden_from_the_session_list(monkeypatch, tmp_path, private_tmux):
    from app import shortcut_terminals as st, tmux
    monkeypatch.setenv("SHELL", "/bin/sh")
    term = st.start("s", str(tmp_path), "sleep 30", "x", {})
    panes = tmux.list_panes_all()[term["tmux"]]
    assert panes[0]["hidden"] is True


def test_terminal_socket_refuses_a_foreign_shortcut_id(client, monkeypatch, tmp_path, private_tmux):
    from app import api
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(api, "_SHORTCUT_FAIL_WINDOW", 0.2)
    ident = _run(client, monkeypatch, tmp_path, "sleep 30", name="dono").json()["terminal"]["id"]
    for url in (f"/api/sessions/outra/term?token=secret&shortcut={ident}",
                "/api/sessions/dono/term?token=secret&shortcut=zzzzzz"):
        with pytest.raises(Exception):
            with client.websocket_connect(url):
                pass


@pytest.mark.skipif(shutil.which("tmux") is None or os.name != "posix", reason="precisa de tmux")
def test_terminal_socket_attaches_to_its_own_shortcut(client, monkeypatch, tmp_path):
    # O attach do painel roda `tmux attach` no servidor padrao: este caso usa ele, com nome de teste.
    from app import shortcut_terminals as st, termsock
    if not termsock.painel_disponivel():
        pytest.skip("esta maquina nao abre painel de terminal")
    monkeypatch.setenv("SHELL", "/bin/sh")
    owner = "cp-test-shortcut"
    st.close_all(owner)
    term = st.start(owner, str(tmp_path), "echo marca-do-atalho; sleep 30", "x", {})
    try:
        with client.websocket_connect(
                f"/api/sessions/{owner}/term?token=secret&cols=80&rows=24&shortcut={term['id']}") as ws:
            seen = b""
            limit = time.monotonic() + 5
            while b"marca-do-atalho" not in seen and time.monotonic() < limit:
                seen += ws.receive_bytes()
            assert b"marca-do-atalho" in seen
            ws.close()
    finally:
        st.close_all(owner)
    assert st.list_for(owner) == []
