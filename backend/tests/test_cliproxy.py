"""CLIProxyAPI local: a chave sai do config dele direto para o engines.json, nunca para a tela."""
import asyncio
import json
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app import cliproxy_accounts, codex_contas


def _proxy_accounts(tmp_path, monkeypatch):
    proxy = tmp_path / "proxy"
    proxy.mkdir()
    home = tmp_path / "codex"
    home.mkdir()
    (home / "auth.json").write_text(json.dumps({"tokens": {"account_id": "account-one"}}))
    monkeypatch.setattr(cliproxy_accounts, "auth_dir", lambda: proxy)
    monkeypatch.setattr(codex_contas, "list_visible_accounts", lambda: [
        codex_contas.Account("default", home, True)])
    credential = proxy / "codex-one.json"
    credential.write_text(json.dumps({"type": "codex", "account_id": "account-one",
                                      "email": "one@example.test", "prefix": "fixed",
                                      "access_token": "private-token"}))
    credential.chmod(0o600)
    return proxy, home, credential


def test_association_is_read_only_and_never_exposes_tokens(tmp_path, monkeypatch):
    _, home, credential = _proxy_accounts(tmp_path, monkeypatch)
    content = credential.read_bytes()
    entries = cliproxy_accounts.list_accounts()
    assert entries == [{"account": "default", "credential_id": f"codex:{home.resolve()}",
                        "email": "one@example.test", "label": "one@example.test", "prefix": "fixed"}]
    assert credential.read_bytes() == content
    assert "private-token" not in json.dumps(entries)


def test_shared_prefix_and_disabled_account_are_not_routable(tmp_path, monkeypatch):
    proxy, _, credential = _proxy_accounts(tmp_path, monkeypatch)
    data = json.loads(credential.read_text())
    credential.write_text(json.dumps({**data, "prefix": "shared"}))
    (proxy / "other.json").write_text(json.dumps({"type": "codex", "account_id": "other",
                                               "prefix": "shared"}))
    with pytest.raises(ValueError, match="compartilhado"):
        cliproxy_accounts.resolve("default")
    credential.write_text(json.dumps({**data, "disabled": True}))
    with pytest.raises(ValueError):
        cliproxy_accounts.resolve("default")


def test_missing_prefix_and_shell_injection_are_refused_without_writes(tmp_path, monkeypatch):
    _, _, credential = _proxy_accounts(tmp_path, monkeypatch)
    data = json.loads(credential.read_text())
    data.pop("prefix")
    credential.write_text(json.dumps(data))
    before = credential.read_bytes()
    assert cliproxy_accounts.list_accounts()[0]["prefix"] is None
    for account in ("default", "default;touch /tmp/x", "unknown"):
        with pytest.raises(ValueError):
            cliproxy_accounts.resolve(account)
    assert credential.read_bytes() == before


def test_invalid_credential_has_visible_safe_error(cli, tmp_path, monkeypatch):
    _fixed_engine(tmp_path, monkeypatch)
    (tmp_path / "proxy" / "codex-one.json").write_text('{"access_token": "private-token",')
    response = cli.get("/api/engines", headers=AUTH)
    assert response.status_code == 200
    assert response.json()["motores"]["proxy"]["cliproxy_error"]
    assert response.json()["motores"]["proxy"]["cliproxy_accounts"] == []
    assert "private-token" not in response.text


def test_unassociated_proxy_accounts_have_visible_empty_error(cli, tmp_path, monkeypatch):
    _fixed_engine(tmp_path, monkeypatch)
    monkeypatch.setattr(codex_contas, "list_visible_accounts", lambda: [])
    response = cli.get("/api/engines", headers=AUTH)
    engine = response.json()["motores"]["proxy"]
    assert engine["cliproxy_accounts"] == []
    assert engine["cliproxy_error"]


@pytest.mark.parametrize("route,body,code", [
    ("model-effort", {"model": "gpt-5.5", "scope": "default"}, "model_effort_needs_rust_server"),
    ("model-effort", {"effort": "high", "scope": "session"}, "model_effort_needs_rust_server"),
    ("engine/model", {"model": "gpt-5.5[1m]"}, "session_open_needs_rust_server"),
])
def test_fixed_session_model_changes_reopen_in_rust(cli, tmp_path, monkeypatch, route, body, code):
    # A conta ChatGPT fixa troca modelo e esforço reabrindo: nada é aplicado no pane nem no global.
    from app import api
    from app.models import SessionInfo
    _fixed_engine(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "_cached_info", AsyncMock(return_value=SessionInfo(
        name="fixed", engine="proxy", engine_account="default")))
    apply = MagicMock()
    monkeypatch.setattr(api.terminal, "set_model_effort", apply)
    monkeypatch.setattr(api.terminal, "set_engine_model", apply)
    response = cli.post(f"/api/sessions/fixed/{route}", headers=AUTH, json=body)
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == code
    apply.assert_not_called()


def test_model_effort_of_any_claude_needs_the_rust_server(cli, monkeypatch):
    # Trocar modelo e esforço é do Rust, com e sem terminal: sem ele, o código próprio e nenhuma tecla.
    from app import api
    from app.models import SessionInfo
    monkeypatch.setattr(api, "_cached_info", AsyncMock(return_value=SessionInfo(name="cc")))
    apply = MagicMock()
    monkeypatch.setattr(api.terminal, "set_model_effort", apply)
    response = cli.post("/api/sessions/cc/model-effort", headers=AUTH, json={"model": "sonnet"})
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == "model_effort_needs_rust_server"
    apply.assert_not_called()


def test_selected_models_and_routes_never_fall_back(tmp_path, monkeypatch):
    _proxy_accounts(tmp_path, monkeypatch)
    prefix = cliproxy_accounts.resolve("default")["prefix"]
    assert cliproxy_accounts.prefix_model("gpt-5.5", prefix) == f"{prefix}/gpt-5.5"
    assert cliproxy_accounts.prefix_model(f"{prefix}/gpt-5.5", prefix) == f"{prefix}/gpt-5.5"
    with pytest.raises(ValueError):
        cliproxy_accounts.prefix_model("other/gpt-5.5", prefix)
    assert cliproxy_accounts.models_for([{"id": f"{prefix}/gpt-5.5"},
                                       {"id": "other/gpt-5.5"}, {"id": "gpt-5.5"}], prefix) == [
        {"id": "gpt-5.5"}]
from fastapi.testclient import TestClient

from app import cliproxy
from app import engines as eng
from app.api import app
from app.config import settings

TOKEN = "secret-de-teste"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
CHAVE = "chave-de-teste-cliproxy"


@pytest.fixture(autouse=True)
def _isola(tmp_path, monkeypatch):
    monkeypatch.setattr(eng, "caminho", lambda: tmp_path / "engines.json")
    monkeypatch.setattr(cliproxy, "config_path", lambda: tmp_path / "config.yaml")
    # A detecção também nomeia contas: sem isto ela leria as credenciais e a senha de quem roda a suíte.
    monkeypatch.setattr(cliproxy, "_mgmt_path", lambda: tmp_path / "mgmt.key")
    monkeypatch.setattr(cliproxy, "_chave_recusada", None)
    monkeypatch.setattr(cliproxy_accounts, "auth_dir", lambda: tmp_path / "sem-proxy")
    monkeypatch.setattr(settings, "auth_token", TOKEN)


@pytest.fixture
def cli():
    return TestClient(app)


def _config(tmp_path, texto):
    (tmp_path / "config.yaml").write_text(texto, encoding="utf-8")


def _fixed_engine(tmp_path, monkeypatch):
    from app import api
    _proxy_accounts(tmp_path, monkeypatch)
    _config(tmp_path, f"port: 8317\napi-keys:\n  - {CHAVE}\n")
    eng.salvar("proxy", {"base_url": "http://127.0.0.1:8317/v1", "api_key": CHAVE, "model": "gpt-5.5"})
    api._engine_models_cache.clear()
    monkeypatch.setattr("app.engine_probe.listar_modelos", lambda *a: [
        {"id": "fixed/gpt-5.5", "context_length": 400000}, {"id": "another/gpt-5.5"},
        {"id": "gpt-5.5"}, {"id": "fixed/gpt-image-2"}])


def test_engines_expose_only_local_associated_identities(cli, tmp_path, monkeypatch):
    _fixed_engine(tmp_path, monkeypatch)
    eng.salvar("remote", {"base_url": "https://example.test", "api_key": "remote", "model": "gpt-5.5"})
    response = cli.get("/api/engines", headers=AUTH)
    assert response.status_code == 200
    motors = response.json()["motores"]
    assert motors["proxy"]["cliproxy_accounts"][0]["account"] == "default"
    assert "cliproxy_accounts" not in motors["remote"]
    assert "private-token" not in response.text and CHAVE not in response.text


@pytest.mark.parametrize("model", ["gpt-5.5[1m]", "fixed/gpt-5.5[1m]"])
def test_context_suffix_preserves_fixed_model_binding(tmp_path, monkeypatch, model):
    _fixed_engine(tmp_path, monkeypatch)
    cfg = eng.listar()["proxy"]
    account = cliproxy.account_for_engine(cfg, "default")
    assert cliproxy.validate_models(cfg, model, account)[0]["id"] == "gpt-5.5"
    env = cliproxy.engine_env("proxy", model, 400000, "default", home=account["home"])
    assert env["ANTHROPIC_MODEL"] == "fixed/gpt-5.5[1m]"
    assert env["CP_ENGINE_ACCOUNT"] == "default"
    assert env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] == "1000000"
    assert cliproxy.supports_fast("proxy", env["ANTHROPIC_MODEL"])


@pytest.mark.parametrize("model", ["gpt-missing[1m]", "gpt-5.5[1m][1m]", "another/gpt-5.5[1m]"])
def test_context_suffix_cannot_bypass_fixed_model_validation(tmp_path, monkeypatch, model):
    _fixed_engine(tmp_path, monkeypatch)
    cfg = eng.listar()["proxy"]
    account = cliproxy.account_for_engine(cfg, "default")
    with pytest.raises(ValueError):
        cliproxy.validate_models(cfg, model, account)


def test_context_suffix_is_not_removed_for_incompatible_models(tmp_path, monkeypatch):
    _fixed_engine(tmp_path, monkeypatch)
    cfg = eng.listar()["proxy"]
    account = cliproxy.account_for_engine(cfg, "default")
    catalog = [{"id": "fixed/codex-mini-latest"}]
    with pytest.raises(ValueError, match="principal indisponível"):
        cliproxy.validate_models(cfg, "codex-mini-latest[1m]", account, catalog)
    assert eng.catalog_model("codex-mini-latest[1m]") == "codex-mini-latest[1m]"
    assert eng.catalog_model("opus[1m]") == "opus[1m]"


def test_model_options_return_base_models_only_for_fixed_account(cli, tmp_path, monkeypatch):
    _fixed_engine(tmp_path, monkeypatch)
    response = cli.get("/api/model-options", headers=AUTH,
                       params={"provider": "claude", "engine": "proxy", "engine_account": "default"})
    assert response.status_code == 200, response.text
    assert response.json()["models"] == [{"id": "gpt-5.5", "context_length": 400000, "vision": None, "supports_fast": True}]
    assert response.json()["supports_fast"] is True
    response = cli.get("/api/model-options", headers=AUTH,
                       params={"provider": "claude", "engine": "proxy", "engine_account": "missing"})
    assert response.status_code == 400


@pytest.mark.parametrize("model,local_proxy,expected", [
    ("gpt-5.5", True, True), ("fixed/gpt-6.1-sol", True, True),
    ("gpt-image-2", True, False), ("k3", True, False),
    ("gpt-5.5", False, False),
])
def test_fast_requires_gpt_on_local_proxy(tmp_path, monkeypatch, model, local_proxy, expected):
    _fixed_engine(tmp_path, monkeypatch)
    if not local_proxy:
        cfg = eng.listar()["proxy"]
        eng.salvar("proxy", {**cfg, "base_url": "https://example.test"})
    assert cliproxy.supports_fast("proxy", model) is expected
    assert cliproxy.supports_fast(None, model) is False


@pytest.mark.parametrize("tier", ["default", "priority"])
def test_session_model_catalog_exposes_confirmed_proxy_fast(cli, tmp_path, monkeypatch, tier):
    from app import api
    from app.models import SessionInfo
    _fixed_engine(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "_cached_info", AsyncMock(return_value=SessionInfo(
        name="fixed", provider="claude", engine="proxy", engine_account="default")))
    monkeypatch.setattr(api, "_engine_fast_selection", lambda name: ("fixed/gpt-5.5", tier))
    response = cli.get("/api/sessions/fixed/model/options", headers=AUTH)
    assert response.status_code == 200, response.text
    assert response.json()["supports_fast"] is True
    assert response.json()["current"] == {"model": "gpt-5.5", "service_tier": tier}


def test_fast_blocks_incompatible_model_before_reopen(cli, tmp_path, monkeypatch):
    from app import api
    from app.models import SessionInfo
    _fixed_engine(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "_cached_info", AsyncMock(return_value=SessionInfo(
        name="fixed", provider="claude", engine="proxy")))
    monkeypatch.setattr(api, "_engine_models", AsyncMock(return_value=[{"id": "k3"}]))
    monkeypatch.setattr(api, "_engine_fast_selection", lambda name: ("gpt-5.5", "priority"))
    apply = MagicMock()
    monkeypatch.setattr(api.terminal, "set_engine_model", apply)
    response = cli.post("/api/sessions/fixed/engine/model", headers=AUTH, json={"model": "k3"})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "erro_fast_indisponivel"
    apply.assert_not_called()


def test_baton_forwards_account_to_shared_creation(tmp_path, monkeypatch):
    from app import api
    from app.models import SessionInfo
    _fixed_engine(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "_bastao_alvo", AsyncMock(return_value=SessionInfo(
        name="origin", cwd=str(tmp_path), provider="claude")))
    monkeypatch.setattr(api, "_nome_ocupado", lambda *a: False)
    monkeypatch.setattr(api, "_bastao_preparar", lambda *a: ("text", tmp_path / "target.md", "kick", None))
    create = AsyncMock(return_value=api.CreatedSessionInfo(name="target", provider="claude"))
    monkeypatch.setattr(api, "_open_in_rust", create)
    asyncio.run(api._passar_bastao("origin", api.BastaoBody(
        name="target", engine="proxy", engine_account="default", model="gpt-5.5"), SimpleNamespace(headers={})))
    body = json.loads(create.call_args.args[0])
    assert (body["engine_account"], body["model"], body["provider"]) == ("default", "gpt-5.5", "claude")


def test_local_le_host_porta_e_primeira_chave(tmp_path):
    _config(tmp_path, f'host: ""\nport: 9000\napi-keys:\n  - "{CHAVE}"\n  - outra\n')
    assert cliproxy.local() == {"base_url": "http://127.0.0.1:9000", "api_key": CHAVE}


def test_local_le_chave_do_formato_novo_em_access(tmp_path):
    _config(tmp_path, f'access:\n  api-keys:\n    - "{CHAVE}"\napi-keys:\n  gemini:\n    - name: g\n')
    assert cliproxy.local() == {"base_url": "http://127.0.0.1:8317", "api_key": CHAVE}


def test_local_sem_config_e_none(tmp_path):
    assert cliproxy.local() is None


def test_remote_fast_catalog_survives_invalid_local_proxy(tmp_path, monkeypatch):
    _config(tmp_path, "port: 8317\napi-keys: []\n")
    eng.salvar("remote", {"base_url": "https://example.test", "api_key": "test", "model": "gpt-5.5"})
    diagnostic = MagicMock()
    monkeypatch.setattr("app.diag.registrar", diagnostic)
    assert cliproxy.supports_fast("remote") is False
    diagnostic.assert_called_once()
    assert diagnostic.call_args.args == ("cliproxy.fast_unavailable", "erro")


def test_local_sem_chave_levanta(tmp_path):
    _config(tmp_path, "port: 8317\napi-keys: []\n")
    with pytest.raises(ValueError, match="api-keys"):
        cliproxy.local()


def test_local_com_api_keys_que_nao_e_lista_levanta(tmp_path):
    _config(tmp_path, "api-keys: abc\n")
    with pytest.raises(ValueError, match="lista"):
        cliproxy.local()


def test_get_tira_a_chave_do_erro_do_proxy(cli, tmp_path, monkeypatch):
    _config(tmp_path, f"api-keys:\n  - {CHAVE}\n")

    def _fake(base_url, api_key):
        raise RuntimeError(f"401 invalid key {api_key}")

    monkeypatch.setattr("app.engine_probe.listar_modelos", _fake)
    r = cli.get("/api/engines/cliproxy", headers=AUTH)
    assert r.json()["error"] == "401 invalid key ***"
    assert CHAVE not in r.text


def test_local_com_yaml_quebrado_levanta(tmp_path):
    _config(tmp_path, "api-keys: [\n")
    with pytest.raises(ValueError):
        cliproxy.local()


def test_get_devolve_modelos_sem_imagem_e_sem_a_chave(cli, tmp_path, monkeypatch):
    _config(tmp_path, f"host: 127.0.0.1\nport: 8317\napi-keys:\n  - {CHAVE}\n")
    vistos = []

    def _fake(base_url, api_key):
        vistos.append((base_url, api_key))
        return [{"id": "gpt-5.5", "context_length": None, "vision": None},
                {"id": "gpt-image-2", "context_length": None, "vision": None}]

    monkeypatch.setattr("app.engine_probe.listar_modelos", _fake)
    r = cli.get("/api/engines/cliproxy", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"found": True, "base_url": "http://127.0.0.1:8317", "error": None,
                        "models": [{"id": "gpt-5.5", "context_length": None, "vision": None}],
                        "unnamed_accounts": 0, "management_key_set": False, "naming_error": None}
    assert vistos == [("http://127.0.0.1:8317", CHAVE)]
    assert CHAVE not in r.text


def test_get_sem_instancia(cli):
    assert cli.get("/api/engines/cliproxy", headers=AUTH).json() == {
        "found": False, "base_url": None, "models": [], "error": None}


def test_put_com_use_cliproxy_key_grava_a_chave_do_config(cli, tmp_path):
    _config(tmp_path, f"port: 8317\napi-keys:\n  - {CHAVE}\n")
    r = cli.put("/api/engines/cliproxy", headers=AUTH, json={
        "label": "CLIProxyAPI", "base_url": "http://127.0.0.1:8317/v1", "model": "gpt-5.5",
        "use_cliproxy_key": True})
    assert r.status_code == 200, r.text
    assert CHAVE not in r.text
    salvo = eng.listar()["cliproxy"]
    assert salvo["api_key"] == CHAVE
    assert "use_cliproxy_key" not in salvo


def test_put_com_use_cliproxy_key_para_outro_endereco_e_recusado(cli, tmp_path):
    _config(tmp_path, f"port: 8317\napi-keys:\n  - {CHAVE}\n")
    r = cli.put("/api/engines/x", headers=AUTH, json={
        "base_url": "https://outro.example.com", "model": "gpt-5.5", "use_cliproxy_key": True})
    assert r.status_code == 400
    assert "x" not in eng.listar()


def test_prefixo_sai_do_email_e_ganha_o_dominio_se_ja_existe():
    assert cliproxy.prefix_from_email("Conta-200-2@example.test", set()) == "conta-200-2"
    assert cliproxy.prefix_from_email("ana@gmail.com", {"ana"}) == "ana-gmail"
    assert cliproxy.prefix_from_email("ana@gmail.com", {"ana", "ana-gmail"}) is None
    assert cliproxy.prefix_from_email("", set()) is None


def _patches(monkeypatch, status=200, grava=None):
    """Proxy falso: `grava` é o arquivo onde ele põe o prefixo pedido, como o de verdade faz."""
    vistos = []

    class _Resposta:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def _abrir(req, timeout=None):
        vistos.append(req)
        if status != 200:
            raise urllib.error.HTTPError(req.full_url, status, "x", None, None)
        if grava is not None:
            grava.write_text(json.dumps({**json.loads(grava.read_text()), "prefix": json.loads(req.data)["prefix"]}))
        return _Resposta()

    monkeypatch.setattr(urllib.request, "urlopen", _abrir)
    return vistos


def test_nomeia_pela_rota_do_proxy(tmp_path, monkeypatch):
    _, _, credential = _proxy_accounts(tmp_path, monkeypatch)
    _config(tmp_path, f"port: 8317\napi-keys:\n  - {CHAVE}\n")
    data = json.loads(credential.read_text())
    credential.write_text(json.dumps({**data, "prefix": "hangar-0cb84365d044590104eccd15"}))
    vistos = _patches(monkeypatch, grava=credential)
    assert cliproxy.name_accounts() == []
    assert vistos == []
    cliproxy.set_management_key("senha-mgmt")
    assert (tmp_path / "mgmt.key").stat().st_mode & 0o777 == 0o600
    assert cliproxy.name_accounts() == ["one"]
    req = vistos[0]
    assert (req.method, req.full_url) == ("PATCH", "http://127.0.0.1:8317/v0/management/auth-files/fields")
    assert req.get_header("X-management-key") == "senha-mgmt"
    assert json.loads(req.data) == {"name": "codex-one.json", "prefix": "one"}
    assert cliproxy.unnamed_accounts() == []


def test_proxy_que_aceita_e_nao_grava_vira_erro(tmp_path, monkeypatch):
    _, _, credential = _proxy_accounts(tmp_path, monkeypatch)
    _config(tmp_path, f"port: 8317\napi-keys:\n  - {CHAVE}\n")
    data = json.loads(credential.read_text())
    data.pop("prefix")
    credential.write_text(json.dumps(data))
    _patches(monkeypatch)
    cliproxy.set_management_key("senha-mgmt")
    with pytest.raises(ValueError, match="não o gravou"):
        cliproxy.name_accounts()


def test_nome_escolhido_a_mao_fica(tmp_path, monkeypatch):
    _proxy_accounts(tmp_path, monkeypatch)
    _config(tmp_path, f"port: 8317\napi-keys:\n  - {CHAVE}\n")
    cliproxy.set_management_key("senha-mgmt")
    vistos = _patches(monkeypatch)
    assert cliproxy.unnamed_accounts() == []
    assert cliproxy.name_accounts() == []
    assert vistos == []


def test_put_da_senha_nao_devolve_o_valor_e_mostra_a_recusa(cli, tmp_path, monkeypatch):
    _, _, credential = _proxy_accounts(tmp_path, monkeypatch)
    _config(tmp_path, f"port: 8317\napi-keys:\n  - {CHAVE}\n")
    data = json.loads(credential.read_text())
    data.pop("prefix")
    credential.write_text(json.dumps(data))
    _patches(monkeypatch, status=401)
    r = cli.put("/api/engines/cliproxy/management-key", headers=AUTH, json={"management_key": "errada"})
    assert r.status_code == 200
    assert r.json() == {"unnamed_accounts": 1, "management_key_set": True,
                        "naming_error": "CLIProxyAPI recusou a senha de gerenciamento"}
    assert "errada" not in r.text
