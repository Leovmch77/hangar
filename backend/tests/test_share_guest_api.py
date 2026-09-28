import asyncio
import dataclasses
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import share_gate, share_store, share_tunnel, sse
from app.config import settings
from app.models import SessionInfo

SHARED = share_store.Share(
    id="s1", session="cc", life="L1", created_at=0.0, code_expires_at=9e9, code_hash="c",
    token_hash=None, device="", redeemed_at=None, revoked_at=None)
REDEEMED = dataclasses.replace(SHARED, token_hash="t", redeemed_at=1.0)


@pytest.fixture
def guest_client(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "secret")
    import app.api as api_mod
    monkeypatch.setattr(api_mod, "_session_exists", lambda name: True)
    monkeypatch.setattr(share_tunnel, "host", lambda: "maq.tail.ts.net")
    share_gate._life_cache.clear()
    monkeypatch.setattr(share_gate, "session_life", lambda name: "L1")
    return TestClient(api_mod.app, base_url="http://127.0.0.1:8766", client=("203.0.113.9", 1))


def test_pagina_do_convite_nao_gasta_o_codigo(guest_client, monkeypatch):
    chamadas = []
    monkeypatch.setattr(share_store, "peek", lambda code: SHARED)
    monkeypatch.setattr(share_store, "redeem", lambda *a: chamadas.append(a))
    r = guest_client.get("/convite/ABCD")
    assert r.status_code == 200
    assert "cc" in r.text
    assert "hangar://convite/maq.tail.ts.net:8443/ABCD" in r.text
    assert r.headers["cache-control"] == "no-store"
    assert chamadas == []


@pytest.mark.parametrize("reason,texto", [
    ("used", "já foi usado"), ("expired", "venceu"), ("revoked", "cancelado"),
    ("unknown", "não encontrado")])
def test_pagina_mostra_o_motivo(guest_client, monkeypatch, reason, texto):
    def peek(code):
        raise share_store.ShareError(reason)
    monkeypatch.setattr(share_store, "peek", peek)
    r = guest_client.get("/convite/ABCD")
    assert texto in r.text
    assert "hangar://" not in r.text


def test_pagina_escapa_o_nome_da_sessao(guest_client, monkeypatch):
    monkeypatch.setattr(share_store, "peek",
                        lambda code: dataclasses.replace(SHARED, session="<script>x</script>"))
    assert "<script>x</script>" not in guest_client.get("/convite/ABCD").text


def test_resgate_devolve_token_e_endereco(guest_client, monkeypatch):
    monkeypatch.setattr(share_store, "redeem", lambda code, device: (SHARED, "tok"))
    r = guest_client.post("/api/guest/redeem", json={"code": "ABCD", "device": "Pixel"})
    assert r.status_code == 200
    body = r.json()
    assert body["token"] == "tok" and body["session"] == "cc"
    assert body["address"] == "https://maq.tail.ts.net:8443"
    assert body["owner"]


def test_resgate_com_tunel_fora_nao_gasta_o_codigo(guest_client, monkeypatch):
    def sem_tunel():
        raise share_tunnel.TunnelError([], "sem tailscale")
    chamadas = []
    monkeypatch.setattr(share_tunnel, "host", sem_tunel)
    monkeypatch.setattr(share_store, "redeem", lambda *a: chamadas.append(a))
    r = guest_client.post("/api/guest/redeem", json={"code": "ABCD", "device": "Pixel"})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "erro_sessao_indisponivel"
    assert chamadas == []


@pytest.mark.parametrize("reason,status,code", [
    ("used", 410, "erro_convite_usado"), ("expired", 410, "erro_convite_vencido"),
    ("revoked", 410, "erro_convite_revogado"), ("unknown", 404, "erro_convite_inexistente")])
def test_resgate_recusado_com_motivo(guest_client, monkeypatch, reason, status, code):
    def redeem(code_, device):
        raise share_store.ShareError(reason)
    monkeypatch.setattr(share_store, "redeem", redeem)
    r = guest_client.post("/api/guest/redeem", json={"code": "ABCD", "device": "Pixel"})
    assert r.status_code == status
    assert r.json()["detail"]["code"] == code
    assert r.json()["detail"]["params"]["reason"] == reason


def test_lista_do_convidado_so_tem_a_sessao_dele(guest_client, monkeypatch):
    monkeypatch.setattr(share_store, "lookup_token", lambda t: REDEEMED)
    infos = [SessionInfo(name="cc", cwd="/p"), SessionInfo(name="outra", cwd="/q")]
    with patch("app.api.registry.list", return_value=infos):
        r = guest_client.get("/api/sessions", headers={"Authorization": "Bearer g"})
    assert r.status_code == 200
    assert [s["name"] for s in r.json()] == ["cc"]


class _FakeRefresher:
    def __init__(self, data):
        self.version, self.errored, self.data = 1, False, data
        self._cond = asyncio.Condition()

    def acquire(self):
        return self._cond

    def release(self):
        pass


async def test_stream_da_lista_filtrado_e_sem_contar_app(monkeypatch):
    monkeypatch.setattr(sse, "_list_refresher",
                        _FakeRefresher(json.dumps([{"name": "cc"}, {"name": "outra"}])))
    entrou = []
    monkeypatch.setattr(sse.plugin_bridge, "app_entrou", lambda: entrou.append(1))
    gen = sse.list_events(ping_secs=60, only="cc")
    ev = await asyncio.wait_for(gen.__anext__(), 2)
    await gen.aclose()
    assert ev["event"] == "sessions"
    assert [s["name"] for s in json.loads(ev["data"])] == ["cc"]
    assert entrou == []


def test_stream_da_sessao_do_convidado_nao_conta_como_app_do_dono(guest_client, monkeypatch):
    # Contar o convidado como app aberto calaria as notificações push do dono.
    from app import api as api_mod
    monkeypatch.setattr(share_store, "lookup_token", lambda t: REDEEMED)
    chamadas = []

    async def fake_merged(name, jsonl, provider="claude", start_offset=None, count_app=True):
        chamadas.append(count_app)
        yield {"event": "ping", "data": "{}"}

    monkeypatch.setattr(api_mod, "merged_events", fake_merged)
    infos = [SessionInfo(name="cc", cwd="/p", jsonl="/p/x.jsonl")]
    with patch("app.api.registry.list", return_value=infos):
        guest_client.get("/api/sessions/cc/events", headers={"Authorization": "Bearer g"})
    assert chamadas == [False]
