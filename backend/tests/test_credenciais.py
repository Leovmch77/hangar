"""Escritas da tela de credenciais (app/credenciais.py) + apelido (app/apelidos.py).

A lista (`GET /api/credenciais`) é do Rust: `crates/hangar-server/tests/contract_credenciais.rs`.
O apelido escreve num `tmp_path` pela pasta compartilhada.
"""
import pytest

from app import apelidos, contas, credenciais, codex_contas


@pytest.fixture
def casa(tmp_path, monkeypatch):
    """Pasta compartilhada de mentira — é onde o mapa de apelidos é gravado."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(codex_contas, "_DEFAULT_HOME", tmp_path / ".codex")
    # A pasta existe: os testes daqui supõem conta Codex na máquina (sem ela e sem o CLI, a
    # padrão some da tela — ver codex_contas.list_visible_accounts).
    (tmp_path / ".codex").mkdir()
    monkeypatch.setattr(codex_contas, "list_accounts", lambda: [])
    monkeypatch.setattr(contas, "compartilhado", lambda: tmp_path)
    return tmp_path


# ----------------------------------------------------------------------------------- apelidos


def test_apelido_grava_e_le(casa):
    assert apelidos.ler() == {}
    apelidos.definir("kimi:apikey", "Kimi")
    assert apelidos.ler() == {"kimi:apikey": "Kimi"}
    assert apelidos.de("kimi:apikey", "apikey") == "Kimi"
    assert apelidos.de("outro:x", "natural") == "natural"


def test_apelido_vazio_apaga(casa):
    apelidos.definir("a", "Nome")
    apelidos.definir("a", "   ")
    assert apelidos.ler() == {}


def test_arquivo_ilegivel_nao_derruba(casa):
    (casa / ".hangar-apelidos.json").write_text("{isto nao e json", encoding="utf-8")
    assert apelidos.ler() == {}
    # JSON válido do TIPO errado cai no mesmo lugar (precedente do statusline.read()).
    (casa / ".hangar-apelidos.json").write_text("[1,2]", encoding="utf-8")
    assert apelidos.ler() == {}


def test_apelido_tem_teto_de_tamanho(casa):
    apelidos.definir("a", "x" * 200)
    assert len(apelidos.ler()["a"]) == apelidos._MAX


# ------------------------------------------------------------------------------------ cookie
def test_cookie_novo_invalida_a_cota_do_dono_rust(casa, monkeypatch):
    """Com o Rust de pé a cota em cache é a dele: limpar só o cache Python deixava o número
    antigo por até 5 min, logo depois de a pessoa colar o cookie para ver o número aparecer."""
    from app import account_bridge, opencode_cota
    pedidos = []
    monkeypatch.setattr(opencode_cota, "definir_config", lambda *a: None)
    monkeypatch.setattr(opencode_cota, "ler_configs", lambda: {"chave:opencode": {}})
    monkeypatch.setattr(account_bridge, "request_quotas", lambda **k: pedidos.append(k) or {"ok": True})
    credenciais.definir_cookie(credenciais.CookieBody(id="chave:opencode", workspace_id="w", auth_cookie="c"))
    assert pedidos == [{"invalidate": "chave:opencode"}]


def test_cookie_gravado_responde_ok_mesmo_sem_a_ponte_de_cotas(casa, monkeypatch):
    """A invalidação é um extra: com o cookie já gravado, um 503 da ponte faria a pessoa colar de novo."""
    from fastapi import HTTPException
    from app import account_bridge, opencode_cota
    monkeypatch.setattr(opencode_cota, "definir_config", lambda *a: None)
    monkeypatch.setattr(opencode_cota, "ler_configs", lambda: {"chave:opencode": {}})

    def sem_ponte(**_):
        raise HTTPException(503, detail={"code": "quota_bridge_unavailable"})

    monkeypatch.setattr(account_bridge, "request_quotas", sem_ponte)
    resposta = credenciais.definir_cookie(credenciais.CookieBody(id="chave:opencode", workspace_id="w", auth_cookie="c"))
    assert resposta == {"id": "chave:opencode", "cookie_definido": True}
