"""A borda HTTP da escolha de modelo."""
import asyncio
import threading
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient

from app.api import app, CreateBody, create_session
from app import api
from app.config import settings
from app.registry import SessionInfo
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


def test_model_invalido_devolve_400():
    r = TestClient(app).post("/api/sessions", headers=AUTH, json={
        "name": "x", "cwd": "/tmp", "model": "k3; touch /tmp/x", "headless": True})
    assert r.status_code == 400


def test_effort_fora_da_lista_devolve_400():
    r = TestClient(app).post("/api/sessions", headers=AUTH, json={
        "name": "x", "cwd": "/tmp", "provider": "claude", "effort": "turbo", "headless": True})
    assert r.status_code == 400


@pytest.mark.parametrize("provider", ["claude"])
def test_codex_account_so_vale_para_codex(provider):
    with patch("app.api.registry.create") as cr:
        # Claude sem terminal: com terminal a abertura é do Rust.
        r = TestClient(app).post("/api/sessions", headers=AUTH, json={
            "name": "x", "cwd": "/tmp", "provider": provider, "codex_account": "work",
            "headless": provider == "claude"})
    assert r.status_code == 400
    cr.assert_not_called()


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


def test_jev_ausente_herda_o_padrao_do_servidor(monkeypatch):
    """O ponto do campo ser `bool | None`: a folha, o `hangar-send` e o MCP mandam o campo só
    quando alguém escolheu — ausente tem que virar o padrão, senão marcar o interruptor uma vez
    não valeria pros outros dois caminhos."""
    monkeypatch.setattr(api.runtime_config, "get", lambda campo: campo == "jev_padrao")
    assert api._jev_efetivo(None) is True


def test_escolha_explicita_vence_o_padrao_nos_dois_sentidos(monkeypatch):
    """`false` explícito NÃO é o mesmo que ausente: é o `--sem-jev` do CLI, e ele precisa desligar
    o Jev daquela sessão mesmo com o padrão do servidor ligado."""
    monkeypatch.setattr(api.runtime_config, "get", lambda campo: campo == "jev_padrao")
    assert api._jev_efetivo(False) is False
    monkeypatch.setattr(api.runtime_config, "get", lambda _campo: False)
    assert api._jev_efetivo(True) is True


def test_sem_padrao_e_sem_escolha_o_jev_fica_desligado(monkeypatch):
    monkeypatch.setattr(api.runtime_config, "get", lambda _campo: False)
    assert api._jev_efetivo(None) is False


def test_padrao_do_jev_ligado_chega_ao_create_pela_rota(monkeypatch):
    """O `conftest` força `jev_padrao` desligado na suíte inteira (é config da máquina de quem
    roda). Sem este teste, nada mais cobre a ligação entre o padrão e o `jev=True` que sai daqui
    para o `registry.create` — só a função isolada ficaria testada."""
    monkeypatch.setattr(api.runtime_config, "get", lambda campo: campo == "jev_padrao")
    with patch("app.api.registry.create",
               return_value=SessionInfo(name="j", cwd="/tmp", provider="claude")) as cr:
        r = TestClient(app).post("/api/sessions", headers=AUTH,
                                 json={"name": "j", "cwd": "/tmp", "provider": "claude", "headless": True})
    assert r.status_code == 200
    assert cr.call_args.kwargs["jev"] is True
