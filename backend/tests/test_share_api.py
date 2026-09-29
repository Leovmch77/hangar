import pytest
from fastapi.testclient import TestClient

from app import api, share_api, share_store, share_tunnel, share_life
from app.api import app
from app.config import settings
from app.sse import _list_sig
from app.models import SessionInfo

TOKEN = "t-share"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(autouse=True)
def _isola(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_token", TOKEN)
    monkeypatch.setattr(share_store, "_path_override", tmp_path / "shares.json")
    share_store._reset()
    monkeypatch.setattr(share_life, "session_life", lambda n: "t:1" if n == "proj" else None)
    monkeypatch.setattr(share_api, "session_life", lambda n: "t:1" if n == "proj" else None)
    yield
    share_store._reset()


@pytest.fixture
def syncs(monkeypatch):
    chamadas = []
    monkeypatch.setattr(share_tunnel, "ensure_on", lambda: "https://nb.ts.net:8443")
    monkeypatch.setattr(share_tunnel, "sync", lambda active: chamadas.append(active))
    return chamadas


@pytest.fixture
def cli():
    return TestClient(app)


def test_sem_credencial_e_401(cli):
    assert cli.post("/api/sessions/proj/share").status_code == 401
    assert cli.get("/api/sessions/proj/share").status_code == 401


def test_cria_lista_e_revoga(cli, syncs):
    r = cli.post("/api/sessions/proj/share", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["link"].startswith("https://nb.ts.net:8443/convite/")
    code = body["link"].rsplit("/", 1)[1]
    assert share_store.peek(code).session == "proj"

    lista = cli.get("/api/sessions/proj/share", headers=AUTH).json()["shares"]
    assert [s["id"] for s in lista] == [body["id"]] and lista[0]["pending"] is True

    r = cli.delete(f"/api/sessions/proj/share/{body['id']}", headers=AUTH)
    assert r.json() == {"ok": True}
    assert syncs[-1] is True  # carência: o convidado ainda recebe o "encerrado"
    assert cli.delete(f"/api/sessions/proj/share/{body['id']}", headers=AUTH).status_code == 404


def test_encerrar_todos(cli, syncs):
    cli.post("/api/sessions/proj/share", headers=AUTH)
    cli.post("/api/sessions/proj/share", headers=AUTH)
    r = cli.delete("/api/sessions/proj/share", headers=AUTH)
    assert r.json() == {"ok": True, "revoked": 2}
    assert share_store.has_active() is False


def test_sessao_inexistente_e_404(cli, syncs):
    r = cli.post("/api/sessions/nada/share", headers=AUTH)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "erro_sessao_inexistente"


def test_pre_requisito_faltando_nao_grava_nada(cli, monkeypatch):
    def falha():
        raise share_tunnel.TunnelError(["operator"], "sudo tailscale set --operator=$USER")
    monkeypatch.setattr(share_tunnel, "ensure_on", falha)
    r = cli.post("/api/sessions/proj/share", headers=AUTH)
    assert r.status_code == 409
    d = r.json()["detail"]
    assert d["code"] == "erro_compartilhar_pre_requisito"
    assert d["params"]["missing"] == ["operator"]
    assert "--operator" in d["params"]["fix"]
    assert "enable_url" not in d["params"]
    assert share_store.has_active() is False


def test_funnel_faltando_leva_o_link_de_liberar(cli, monkeypatch):
    def falha():
        raise share_tunnel.TunnelError(["funnel"], "libere", "https://login.tailscale.com/f/funnel?node=n1")
    monkeypatch.setattr(share_tunnel, "ensure_on", falha)
    d = cli.post("/api/sessions/proj/share", headers=AUTH).json()["detail"]
    assert d["params"]["enable_url"] == "https://login.tailscale.com/f/funnel?node=n1"


def test_prereqs_do_dono(cli, monkeypatch):
    assert cli.get("/api/share/prereqs").status_code == 401
    pre = {"missing": ["funnel"], "fix": "libere", "enable_url": "https://login.tailscale.com/f/funnel?node=n1"}
    monkeypatch.setattr(share_tunnel, "prereqs", lambda: pre)
    assert cli.get("/api/share/prereqs", headers=AUTH).json() == pre


def test_prereqs_sem_tailscale_e_409_de_pre_requisito(cli, monkeypatch):
    def sem():
        raise share_tunnel.TunnelError([], "tailscale nao encontrado")
    monkeypatch.setattr(share_tunnel, "prereqs", sem)
    r = cli.get("/api/share/prereqs", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["detail"]["params"] == {"missing": [], "fix": "tailscale nao encontrado"}


def test_prereqs_fora_da_porta_do_convidado():
    from app.share_gate import guest_allowed
    assert guest_allowed("GET", "/api/share/prereqs", "proj") is False


def test_fechar_sessao_revoga(cli, syncs, monkeypatch):
    cli.post("/api/sessions/proj/share", headers=AUTH)
    monkeypatch.setattr(api.registry, "kill", lambda name: None)
    r = cli.delete("/api/sessions/proj", headers=AUTH)
    assert r.status_code == 200
    assert share_store.has_active() is False
    assert syncs[-1] is True  # carência do funnel


def test_lista_reemite_quando_compartilhamento_muda():
    a = SessionInfo(name="proj")
    b = SessionInfo(name="proj", shared=True)
    assert _list_sig([a]) != _list_sig([b])


def test_sweep_once_revoga_sessao_renascida(syncs, monkeypatch):
    share_store.create("proj", "t:1")
    monkeypatch.setattr(share_api, "session_life", lambda n: "t:2")
    share_api._sweep_once()
    assert share_store.has_active() is False
    assert syncs[-1] is True  # carência do funnel


def _sem_sidecar(monkeypatch):
    monkeypatch.setattr(share_api.headless_sessions, "exists", lambda n: False)
    monkeypatch.setattr(share_api.codex_sessions, "exists", lambda n: False)


def test_sweep_ausencia_nao_confirmada_nao_revoga(syncs, monkeypatch):
    # tmux com erro/timeout: session_life volta None, mas sessao_existe responde "nao sei".
    share_store.create("proj", "t:1")
    _sem_sidecar(monkeypatch)
    monkeypatch.setattr(share_api, "session_life", lambda n: None)
    monkeypatch.setattr(share_api.tmux, "sessao_existe", lambda n: None)
    share_api._sweep_once()
    assert share_store.has_active() is True


def test_sweep_tmux_vivo_com_vida_ilegivel_nao_revoga(syncs, monkeypatch):
    share_store.create("proj", "t:1")
    _sem_sidecar(monkeypatch)
    monkeypatch.setattr(share_api, "session_life", lambda n: None)
    monkeypatch.setattr(share_api.tmux, "sessao_existe", lambda n: True)
    share_api._sweep_once()
    assert share_store.has_active() is True


def test_sweep_sidecar_sobrando_nao_revoga(syncs, monkeypatch):
    share_store.create("proj", "t:1")
    monkeypatch.setattr(share_api.headless_sessions, "exists", lambda n: True)
    monkeypatch.setattr(share_api.codex_sessions, "exists", lambda n: False)
    monkeypatch.setattr(share_api, "session_life", lambda n: None)
    monkeypatch.setattr(share_api.tmux, "sessao_existe", lambda n: False)
    share_api._sweep_once()
    assert share_store.has_active() is True


def test_sweep_ausencia_confirmada_revoga(syncs, monkeypatch):
    share_store.create("proj", "t:1")
    _sem_sidecar(monkeypatch)
    monkeypatch.setattr(share_api, "session_life", lambda n: None)
    monkeypatch.setattr(share_api.tmux, "sessao_existe", lambda n: False)
    share_api._sweep_once()
    assert share_store.has_active() is False
    assert syncs[-1] is True  # carência do funnel


def test_sweep_pula_sessao_em_troca_de_modo(syncs, monkeypatch):
    share_store.create("proj", "t:1")
    monkeypatch.setattr(share_api, "session_life", lambda n: "k:novo")
    share_api.changing_mode.add("proj")
    try:
        share_api._sweep_once()
        assert share_store.has_active() is True
    finally:
        share_api.changing_mode.discard("proj")
    share_api._sweep_once()
    assert share_store.has_active() is False


def test_modo_execucao_marca_e_atualiza_a_vida(cli, syncs, monkeypatch):
    share_store.create("proj", "t:1")
    visto = {}

    async def troca(name, body):
        visto["durante"] = name in share_api.changing_mode
        return {"ok": True}

    monkeypatch.setattr(api, "_trocar_modo", troca)
    monkeypatch.setattr(api, "session_life", lambda n: "k:novo")
    r = cli.post("/api/sessions/proj/modo-execucao", json={"terminal": False}, headers=AUTH)
    assert r.status_code == 200
    assert visto["durante"] is True
    assert "proj" not in share_api.changing_mode
    monkeypatch.setattr(share_api, "session_life", lambda n: "k:novo")
    share_api._sweep_once()
    assert share_store.has_active() is True


def test_sync_do_tunel_nao_toca_o_tailscale_de_quem_nunca_compartilhou(syncs):
    share_api.sync_tunnel()
    assert syncs == []
    share_store.create("proj", "t:1")
    share_api.sync_tunnel()
    assert syncs == [True]


def test_funnel_fica_ligado_na_carencia_e_cai_depois(syncs):
    s, _ = share_store.create("proj", "t:1")
    share_store.revoke(s.id)
    share_api.sync_tunnel()
    assert syncs[-1] is True
    share_store._load()[s.id].revoked_at -= share_api.ENDED_GRACE + 1
    share_api.sync_tunnel()
    assert syncs[-1] is False
