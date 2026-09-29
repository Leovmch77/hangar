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


def test_pagina_com_tunel_fora_responde_503(guest_client, monkeypatch):
    def sem_tunel():
        raise share_tunnel.TunnelError([], "sem tailscale")
    monkeypatch.setattr(share_store, "peek", lambda code: SHARED)
    monkeypatch.setattr(share_tunnel, "host", sem_tunel)
    r = guest_client.get("/convite/ABCD")
    assert r.status_code == 503
    assert "indisponível por instantes" in r.text
    assert "hangar://" not in r.text


def test_link_do_app_escapa_o_codigo(guest_client, monkeypatch):
    monkeypatch.setattr(share_store, "peek", lambda code: SHARED)
    r = guest_client.get("/convite/a%22b")
    assert "convite/maq.tail.ts.net:8443/a%22b" in r.text
    assert 'a"b' not in r.text


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


def test_convite_pela_rede_local_usa_o_ip_e_nao_o_tunel(guest_client, monkeypatch):
    import app.api as api_mod
    local = TestClient(api_mod.app, base_url="http://192.168.77.142:8766", client=("192.168.77.50", 1))

    def sem_tunel():
        raise share_tunnel.TunnelError([], "sem tailscale")
    monkeypatch.setattr(share_tunnel, "host", sem_tunel)
    monkeypatch.setattr(share_store, "peek", lambda code: SHARED)
    assert "hangar://convite/192.168.77.142:8766/ABCD" in local.get("/convite/ABCD").text
    monkeypatch.setattr(share_store, "redeem", lambda code, device: (SHARED, "tok"))
    r = local.post("/api/guest/redeem", json={"code": "ABCD", "device": "Pixel"})
    assert r.json()["address"] == "http://192.168.77.142:8766"


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


def test_lista_do_convidado_nao_cita_outras_sessoes(guest_client, monkeypatch):
    monkeypatch.setattr(share_store, "lookup_token", lambda t: REDEEMED)
    infos = [SessionInfo(name="cc", cwd="/p", pair_peers=["outra"], pair_task="PM-1",
                         pair_gid="g1", then_target="outra")]

    async def with_state(lst):
        return lst

    with patch("app.api.registry.list", return_value=infos), \
            patch("app.api.registry.list_with_state", with_state):
        r = guest_client.get("/api/sessions", headers={"Authorization": "Bearer g"})
    row = r.json()[0]
    assert row["name"] == "cc"
    assert row["pair_peers"] is None and row["then_target"] is None
    assert row["pair_task"] is None and row["pair_gid"] is None
    assert "outra" not in r.text


def test_guest_cannot_start_a_hangar_copy(guest_client, monkeypatch):
    from app import shortcut_terminals
    started = []
    monkeypatch.setattr(share_store, "lookup_token", lambda t: REDEEMED)
    monkeypatch.setattr(shortcut_terminals, "start_hangar", lambda *a: started.append(a) or (None, False))
    r = guest_client.post("/api/sessions/cc/shortcut-shell", headers={"Authorization": "Bearer g"},
                          json={"command": "notepad", "runs_in": "hangar", "key": "global:k"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "erro_shortcut_hangar_convidado"
    assert started == []


def test_guest_does_not_reach_the_hangar_terminal_routes(guest_client, monkeypatch):
    # O porteiro so deixa passar `/api/sessions/<a sessao do convite>/...`: nem lista, nem fecha, nem terminal.
    monkeypatch.setattr(share_store, "lookup_token", lambda t: REDEEMED)
    auth = {"Authorization": "Bearer g"}
    assert guest_client.get("/api/hangar-terminals", headers=auth).status_code == 403
    assert guest_client.post("/api/hangar-terminals/abcdef/close", headers=auth).status_code == 403
    assert guest_client.post("/api/hangar-terminals/abcdef/restart", headers=auth).status_code == 403
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as e:
        with guest_client.websocket_connect("ws://127.0.0.1:8766/api/hangar-terminals/abcdef/term?token=g"):
            pass
    assert e.value.code == 1008


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


async def test_stream_da_lista_nao_cita_outras_sessoes(monkeypatch):
    row = {"name": "cc", "pair_peers": ["outra"], "pair_task": "PM-1", "pair_gid": "g1",
           "then_target": "outra"}
    monkeypatch.setattr(sse, "_list_refresher", _FakeRefresher(json.dumps([row])))
    gen = sse.list_events(ping_secs=60, only="cc")
    ev = await asyncio.wait_for(gen.__anext__(), 2)
    await gen.aclose()
    assert "outra" not in ev["data"]
    got = json.loads(ev["data"])[0]
    assert got["pair_peers"] is None and got["then_target"] is None


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


async def test_stream_da_lista_acompanha_a_sessao_renomeada(monkeypatch):
    # rename() muda o registro em memória; o stream aberto lê o nome a cada envio.
    fake = _FakeRefresher(json.dumps([{"name": "cc"}, {"name": "novo"}]))
    monkeypatch.setattr(sse, "_list_refresher", fake)
    share = dataclasses.replace(REDEEMED)
    gen = sse.list_events(ping_secs=60, only=share)
    ev = await asyncio.wait_for(gen.__anext__(), 2)
    assert [s["name"] for s in json.loads(ev["data"])] == ["cc"]
    share.session = "novo"
    async with fake._cond:
        fake.version += 1
        fake._cond.notify_all()
    ev = await asyncio.wait_for(gen.__anext__(), 2)
    await gen.aclose()
    assert [s["name"] for s in json.loads(ev["data"])] == ["novo"]
