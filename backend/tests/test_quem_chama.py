import pytest
from fastapi.testclient import TestClient

from app import quem_chama
from app.config import settings


@pytest.fixture
def mundo(monkeypatch):
    """Duas sessões com terminal (uma com pane id repetido, como no psmux) e uma sem terminal."""
    panes = {
        "alfa": [{"pane_id": "%1"}],
        "beta": [{"pane_id": "%1"}, {"pane_id": "%7"}],
    }
    monkeypatch.setattr(quem_chama.tmux, "list_panes_all", lambda: panes)
    monkeypatch.setattr(quem_chama.tmux, "has_session", lambda n: n in panes)
    monkeypatch.setattr(quem_chama.headless_sessions, "list_all",
                        lambda: [{"name": "sem-term", "key": "k123", "session_id": "s"}])
    monkeypatch.setattr(quem_chama.headless_sessions, "exists", lambda n: n == "sem-term")
    monkeypatch.setattr(quem_chama.codex_sessions, "list_all", lambda: [])
    monkeypatch.setattr(quem_chama.codex_sessions, "exists", lambda n: False)


def test_chave_vence_tudo_e_ignora_pane_herdado(mundo):
    assert quem_chama.resolver({"X-Hangar-Key": "k123", "X-Hangar-Pane": "%7"}) == ("sem-term", "chave")


def test_chave_sem_sidecar_nao_cai_no_pane(mundo):
    with pytest.raises(quem_chama.SessaoDesconhecida):
        quem_chama.resolver({"X-Hangar-Key": "nada", "X-Hangar-Pane": "%7"})


def test_pane_unico_resolve(mundo):
    assert quem_chama.resolver({"X-Hangar-Pane": "%7", "X-Hangar-Session": "alfa"}) == ("beta", "pane")


def test_pane_ambiguo_cai_no_nome(mundo):
    assert quem_chama.resolver({"x-hangar-pane": "%1", "x-hangar-session": "alfa"}) == ("alfa", "nome")


def test_nome_de_sessao_morta_nao_resolve(mundo):
    with pytest.raises(quem_chama.SessaoDesconhecida):
        quem_chama.resolver({"X-Hangar-Session": "renomeada"})


def test_sem_cabecalho_nunca_vira_cli(mundo):
    with pytest.raises(quem_chama.SessaoDesconhecida):
        quem_chama.resolver({})


def test_rota_whoami(mundo):
    settings.auth_token = "secret"
    from app.api import app
    c = TestClient(app)
    h = {"Authorization": "Bearer secret"}
    assert c.get("/api/whoami", headers={**h, "X-Hangar-Pane": "%7"}).json() == {"name": "beta", "origem": "pane"}
    r = c.get("/api/whoami", headers=h)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "erro_sessao_desconhecida"
    assert c.get("/api/whoami").status_code == 401


def _voice_signature(secret: str, nonce: str = "0a1b") -> str:
    # Mesma conta do Rust (`voice::machines::voice_signature`).
    import hashlib
    import hmac
    return f"{nonce}." + hmac.new(secret.encode(), f"hangar-voice:{nonce}".encode(), hashlib.sha256).hexdigest()


def test_voz_assinada_vence_os_cabecalhos_de_sessao(mundo, monkeypatch):
    from app import internal_api
    monkeypatch.setattr(internal_api, "_secret", "s3")
    assert quem_chama.resolver({"X-Hangar-Voice": _voice_signature("s3"), "X-Hangar-Pane": "%7"}) == ("voz", "voz")


def test_voz_com_assinatura_errada_ou_sem_segredo_nao_cai_na_sessao(mundo, monkeypatch):
    from app import internal_api
    monkeypatch.setattr(internal_api, "_secret", "s3")
    # Caractere fora do ASCII (o cabeçalho chega como latin-1) é recusa, não TypeError.
    for value in (_voice_signature("outro"), "sem-ponto", "0a1b.", ".abc", "0a1b.é" + "0" * 63, "ñ.\udcff"):
        with pytest.raises(quem_chama.SessaoDesconhecida):
            quem_chama.resolver({"X-Hangar-Voice": value, "X-Hangar-Pane": "%7"})
    # Sem o hangar-server de pé não há segredo, e nenhuma assinatura vale.
    monkeypatch.setattr(internal_api, "_secret", None)
    with pytest.raises(quem_chama.SessaoDesconhecida):
        quem_chama.resolver({"X-Hangar-Voice": _voice_signature("s3")})
