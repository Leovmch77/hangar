"""Cookie do painel do OpenCode Go (app/opencode_cota.py). A leitura do painel, o parse do HTML e a
reserva do ambiente moram no Rust (`contract_quotas_other.rs`)."""
import os

from app import contas, opencode_cota


def test_config_grava_le_e_apaga(tmp_path, monkeypatch):
    monkeypatch.setattr(contas, "compartilhado", lambda: tmp_path)
    assert opencode_cota.ler_configs() == {}
    opencode_cota.definir_config("chave:oc", "ws-9", "abc123")
    assert opencode_cota.ler_configs() == {"chave:oc": {"workspace_id": "ws-9", "auth_cookie": "abc123"}}
    # O arquivo guarda cookie de sessão: 0600, nunca 0644. No Windows nao ha bit de modo (o
    # st_mode volta 0o666 e quem decide e a ACL), e a protecao equivalente ainda NAO existe — a
    # lacuna fica escrita aqui em vez de virar um assert que nao roda. Mesmo tratamento do
    # peers.json e do config dos agentes.
    if os.name == "posix":
        assert oct((tmp_path / ".hangar-opencode.json").stat().st_mode)[-3:] == "600"
    opencode_cota.definir_config("chave:oc", "", "")
    assert opencode_cota.ler_configs() == {}
