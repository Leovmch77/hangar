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
