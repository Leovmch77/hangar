"""A borda HTTP da escolha de modelo."""

import pytest
from fastapi.testclient import TestClient

from app.api import app
from app import api
from app.config import settings
from app import codex_contas as codex_accounts

TOKEN = "t-modelo"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(autouse=True)
def _auth(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", TOKEN)


@pytest.fixture(autouse=True)
def _config_isolada(tmp_path, monkeypatch):
    # Sem isto a suíte lê a config editável REAL da máquina: com `jev_padrao` ligado no servidor
    # de quem roda, o `create` ganha `jev=True` e os testes que conferem os argumentos falham.
    monkeypatch.setattr(api.runtime_config, "_backend_config_base", lambda: tmp_path)


def test_model_options_codex_usa_a_conta_solicitada(monkeypatch, tmp_path):
    account = codex_accounts.Account("work", tmp_path / ".codex-work", False)
    monkeypatch.setattr(codex_accounts, "resolve_account", lambda _: account)
    class Service:
        def preparation_status(self, _account):
            return {"status": "ready", "issues": []}
    monkeypatch.setattr(app.state, "codex_contas_login", Service(), raising=False)
    monkeypatch.setattr(api.codex_models, "listar",
                        lambda **kwargs: [{"id": str(kwargs["codex_home"]), "efforts": []}])
    r = TestClient(app).get("/api/model-options", headers=AUTH,
                             params={"provider": "codex", "codex_account": "work"})
    assert r.status_code == 200
    assert r.json()["models"][0]["id"] == str(account.home)

