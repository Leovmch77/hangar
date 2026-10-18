"""Troca de conta Claude: é do Rust. Aqui ficam a recusa sem ele e a leitura do Fast do motor."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.adapters.claude_headless import sessions as S
from app.config import ConfigDirInfo, settings

SID = "22222222-2222-2222-2222-222222222222"
_H = {"Authorization": "Bearer secret"}


@pytest.fixture
def contas(tmp_path, monkeypatch):
    import app.api as api_mod
    import app.archive as archive_mod
    a, b = tmp_path / ".claude-a", tmp_path / ".claude-b"
    for c in (a, b):
        (c / "projects").mkdir(parents=True)
    lista = [ConfigDirInfo(path=str(a), label="a", active=True), ConfigDirInfo(path=str(b), label="b", active=False)]
    monkeypatch.setattr(api_mod.engines, "caminho", lambda: tmp_path / "engines.json")
    api_mod.engines.salvar("proxy", {"base_url": "http://127.0.0.1:8317", "api_key": "test", "model": "gpt-5.5"})
    monkeypatch.setattr(api_mod, "list_config_dirs", lambda ordered=True: lista)
    monkeypatch.setattr(archive_mod, "list_config_dirs", lambda ordered=True: lista)
    monkeypatch.setattr("app.cotas.cotas_claude", lambda: [])
    monkeypatch.setattr(settings, "projects_dir", a / "projects")
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    monkeypatch.setattr(S, "_trocando", {})
    settings.auth_token = "secret"
    return str(a), str(b)


def test_claude_account_routes_need_rust(contas):
    import app.api as api_mod
    client = TestClient(api_mod.app)
    for r in (client.get("/api/sessions/hl/conta", headers=_H),
              client.post("/api/sessions/hl/conta", headers=_H, json={"config_dir": contas[1]})):
        assert r.status_code == 503 and r.json()["detail"]["code"] == "session_open_needs_rust_server"


@pytest.mark.parametrize("current,expected", [("gpt-6.1-sol", "gpt-6.1-sol"), (None, "gpt-5.5")])
def test_proxy_fast_selection_uses_current_terminal_model(contas, current, expected):
    import app.api as api_mod
    with patch.object(api_mod.registry, "_pane_of", return_value={"pid": 11, "cwd": "/tmp"}), \
         patch.object(api_mod.registry, "resolve_tracked", return_value=(f"/tmp/{SID}.jsonl", True)), \
         patch("app.registry._pid_do_agente", return_value=12), \
         patch("app.procinfo._model_of", return_value=("gpt-5.5", "high")), \
         patch("app.procinfo._env_var_of", return_value="priority"), \
         patch("app.registry._escolhas_status", return_value=(current, "high")), \
         patch("app.registry._claude_reading", side_effect=AssertionError("modelo histórico não é escolha atual")):
        assert api_mod._engine_fast_selection("terminal") == (expected, "priority")
