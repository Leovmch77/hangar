"""Atalhos configuráveis: validação do campo `shortcuts` e endpoint shell dispara-e-esquece.

O que esta suíte trava: config quebrada é recusada na GRAVAÇÃO com o item apontado (o resolve do
front é tolerante e cairia no conjunto nativo, calado), e o endpoint shell roda no cwd da sessão
sem esperar o comando terminar — só avisa quando ele falha logo de cara.
"""
import json
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


def test_shell_runs_in_session_cwd_without_waiting(client, monkeypatch, tmp_path):
    from app import api
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    r = client.post("/api/sessions/s/shortcut-shell", json={"command": "pwd > prova.txt"},
                    headers={"Authorization": "Bearer secret"})
    assert r.status_code == 202 and r.json() == {"ok": True}
    # dispara-e-esquece: a resposta volta antes do fim; espera-se o arquivo aparecer
    proof = tmp_path / "prova.txt"
    for _ in range(50):
        if proof.exists() and proof.read_text().strip():
            break
        time.sleep(0.1)
    assert proof.read_text().strip() == str(tmp_path)


def test_shell_runs_under_user_shell_not_sh(client, monkeypatch, tmp_path):
    # funcao do fish (delphi-vm) so existe no shell do usuario: o atalho tem que usar $SHELL
    from app import api
    fake = tmp_path / "meushell"
    fake.write_text('#!/bin/sh\necho "via-meushell $2" > "$PWD/prova.txt"\n')
    fake.chmod(0o755)
    monkeypatch.setenv("SHELL", str(fake))
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    r = client.post("/api/sessions/s/shortcut-shell", json={"command": "delphi-vm"},
                    headers={"Authorization": "Bearer secret"})
    assert r.status_code == 202
    proof = tmp_path / "prova.txt"
    for _ in range(50):
        if proof.exists() and proof.read_text().strip():
            break
        time.sleep(0.1)
    assert proof.read_text().strip() == "via-meushell delphi-vm"


def test_shortcut_env_fills_display_from_systemd(monkeypatch):
    from app import api
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.setenv("DISPLAY", ":9")

    class _R:
        stdout = "DISPLAY=:1\nWAYLAND_DISPLAY=wayland-1\nOUTRA=x\n"
    monkeypatch.setattr(api.subprocess, "run", lambda *a, **k: _R())
    env = api._shortcut_env()
    assert env["WAYLAND_DISPLAY"] == "wayland-1"
    assert env["DISPLAY"] == ":9"          # o que o processo ja tem vence
    assert "OUTRA" not in env or env["OUTRA"] != "x"


def test_shell_empty_command_returns_400(client, monkeypatch, tmp_path):
    from app import api
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    r = client.post("/api/sessions/s/shortcut-shell", json={"command": "   "},
                    headers={"Authorization": "Bearer secret"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "erro_shortcut_vazio"


def test_shell_oversized_command_is_rejected_before_running(client, monkeypatch, tmp_path):
    from app import api
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    r = client.post("/api/sessions/s/shortcut-shell", json={"command": "x" * 200_001},
                    headers={"Authorization": "Bearer secret"})
    assert r.status_code == 422


def test_shell_command_failing_within_window_returns_422_with_output(client, monkeypatch, tmp_path):
    # quem clicou tem que ver que falhou: codigo de saida e o fim da saida voltam no aviso
    from app import api
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    r = client.post("/api/sessions/s/shortcut-shell", json={"command": "echo boom >&2; exit 3"},
                    headers={"Authorization": "Bearer secret"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "erro_shortcut_falhou"
    assert "3" in detail["msg"] and "boom" in detail["msg"]


def test_shell_command_still_running_after_window_is_ok(client, monkeypatch, tmp_path):
    from app import api
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(api, "_SHORTCUT_FAIL_WINDOW", 0.3)
    monkeypatch.setattr(api, "_session_cwd", lambda name: str(tmp_path))
    started = time.monotonic()
    r = client.post("/api/sessions/s/shortcut-shell", json={"command": "sleep 5"},
                    headers={"Authorization": "Bearer secret"})
    assert r.status_code == 202 and r.json() == {"ok": True}
    assert time.monotonic() - started < 3
