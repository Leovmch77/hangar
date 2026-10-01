import pytest
from fastapi.testclient import TestClient

from app import external_pair_api, external_pairs, pair, peers, share_gate, share_store, share_tunnel
from app.config import settings

TOKEN = "t-owner"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
TOK_Y = "tok-y-" + "a" * 30
ADDR = "https://a.tail.ts.net:8443"
LINK = f"{ADDR}/par/ABC"
GOOD = {"owner": "pc-ana", "session": "Y", "token": "r" * 32}


@pytest.fixture(autouse=True)
def _isola(tmp_path, monkeypatch):
    import app.api as api_mod
    monkeypatch.setattr(settings, "auth_token", TOKEN)
    monkeypatch.setattr(settings, "server_id", "Minha Máquina")
    monkeypatch.setattr(share_store, "_path_override", tmp_path / "shares.json")
    share_store._reset()
    monkeypatch.setattr(external_pairs, "_path_override", tmp_path / "external_pairs.json")
    external_pairs._reset()
    monkeypatch.setattr(pair.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(peers, "_load", lambda: {})
    monkeypatch.setattr(api_mod.registry, "list", lambda: [])
    monkeypatch.setattr(external_pair_api, "session_life", lambda n: "t:1")
    monkeypatch.setattr(share_tunnel, "host", lambda: "eu.tail.ts.net")
    monkeypatch.setattr(share_tunnel, "ensure_on", lambda: "https://eu.tail.ts.net:8443")
    monkeypatch.setattr(share_tunnel, "port_clash", lambda: False)
    share_gate._life_cache.clear()
    yield
    share_store._reset()
    external_pairs._reset()


@pytest.fixture
def entregues(monkeypatch):
    import app.api as api_mod
    lista = []

    async def deliver(name, text):
        lista.append((name, text))
        return None
    monkeypatch.setattr(api_mod, "_deliver", deliver)
    return lista


@pytest.fixture
def client():
    import app.api as api_mod
    return TestClient(api_mod.app, base_url="http://127.0.0.1:8766", client=("203.0.113.9", 1))


@pytest.fixture
def owner_client():
    import app.api as api_mod
    return TestClient(api_mod.app, headers=AUTH)


def _redeem(client, code, **over):
    body = {"code": code, "session": "Y", "token": TOK_Y, "owner": "pc-ana", "address": ADDR} | over
    return client.post("/api/pair/redeem", json=body)


def test_resgate_recusa_endereco_fora_do_funnel(client):
    _, code = share_store.create("X", "t:1", kind="pair")
    assert _redeem(client, code, address="https://192.168.0.5:8443").status_code == 400
    share_store.peek(code, kind="pair")  # código não foi gasto


def test_resgate_recusa_owner_invalido(client):
    _, code = share_store.create("X", "t:1", kind="pair")
    assert _redeem(client, code, owner="Ana Lúcia").status_code == 400
    share_store.peek(code, kind="pair")


@pytest.mark.parametrize("over", [{"session": "Y; rm -rf /"}, {"session": ""}, {"token": "curto"},
                                  {"token": "x y" + "a" * 30}])
def test_resgate_recusa_sessao_e_token_invalidos(client, over):
    _, code = share_store.create("X", "t:1", kind="pair")
    assert _redeem(client, code, **over).status_code == 400
    assert pair.PairLink("X").get() is None
    share_store.peek(code, kind="pair")


def test_resgate_com_sessao_em_grupo_nao_gasta_o_codigo(client, monkeypatch):
    _, code = share_store.create("X", "t:1", kind="pair")
    monkeypatch.setattr(pair, "join_group", lambda *a, **k: (_ for _ in ()).throw(pair.PairMixError("grupo")))
    assert _redeem(client, code).status_code == 409
    share_store.peek(code, kind="pair")


def test_resgate_com_conflito_de_tarefa_e_409(client, monkeypatch):
    _, code = share_store.create("X", "t:1", kind="pair")
    monkeypatch.setattr(pair, "join_group", lambda *a, **k: (_ for _ in ()).throw(pair.TaskConflito("t")))
    r = _redeem(client, code)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "erro_pareamento_tarefa_existente"
    share_store.peek(code, kind="pair")


def test_resgate_valido_grava_os_dois_registros_e_avisa(client, entregues):
    _, code = share_store.create("X", "t:1", kind="pair")
    r = _redeem(client, code, address=ADDR + "/")
    assert r.status_code == 200
    body = r.json()
    assert body["session"] == "X" and body["token"]
    assert body["owner"] == "minha-maquina" and body["address"] == "https://eu.tail.ts.net:8443"
    rec = external_pairs.by_address("pc-ana::Y")
    assert rec.peer_token == TOK_Y and rec.peer_address == ADDR
    assert share_store.lookup_token(body["token"]).pair_share().session == "X"
    assert entregues and "pc-ana::Y" in entregues[0][1]


def test_resgate_com_aviso_que_falha_desfaz_tudo(client, monkeypatch):
    import app.api as api_mod

    async def deliver(name, text):
        return {"msg": "fila cheia"}
    monkeypatch.setattr(api_mod, "_deliver", deliver)
    _, code = share_store.create("X", "t:1", kind="pair")
    assert _redeem(client, code).status_code == 502
    assert external_pairs.all() == [] and pair.PairLink("X").get() is None


def test_codigo_usado_vencido_e_de_convite_comum(client):
    _, comum = share_store.create("X", "t:1")
    assert _redeem(client, comum).status_code == 404


def test_aceite_falha_no_resgate_revoga_o_proprio_token(owner_client, monkeypatch):
    monkeypatch.setattr(external_pairs, "call", lambda *a, **k: (_ for _ in ()).throw(
        peers.PeerError("x respondeu HTTP 410", status=410)))
    r = owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK})
    assert r.status_code == 410 and r.json()["detail"]["params"]["detalhe"]
    assert not any(s.kind == "pair" and s.revoked_at is None for s in share_store._load().values())


@pytest.mark.parametrize("link", ["https://a.tail.ts.net:8443/convite/ABC",
                                  "https://a.tail.ts.net:8443/par/AB-C"])
def test_aceite_com_link_invalido(owner_client, link):
    assert owner_client.post("/api/sessions/Y/pair-accept", json={"link": link}).status_code == 400


def test_aceite_com_sessao_em_grupo_nao_chama_o_outro_lado(owner_client, monkeypatch):
    pair.join_group("Y", ["Z"])
    chamadas = []
    monkeypatch.setattr(external_pairs, "call", lambda *a, **k: chamadas.append(a))
    assert owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK}).status_code == 409
    assert chamadas == [] and share_store._load() == {}


def test_aceite_valido_grava_o_par_e_manda_o_dono_normalizado(owner_client, entregues, monkeypatch):
    enviados = []

    def call(address, token, method, path, body=None, **k):
        enviados.append((method, path, body))
        return 200, GOOD
    monkeypatch.setattr(external_pairs, "call", call)
    r = owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK})
    assert r.status_code == 200 and r.json()["alias"] == "pc-ana"
    assert enviados[0][2]["owner"] == "minha-maquina" and external_pairs.valid_owner(enviados[0][2]["owner"])
    assert external_pairs.by_address("pc-ana::Y").peer_token == GOOD["token"]
    assert entregues and pair.PairLink("Y").get()["peers"] == ["pc-ana::Y"]


def test_aceite_com_resposta_invalida_desfaz_la_se_veio_token(owner_client, monkeypatch):
    chamadas = []

    def call(address, token, method, path, body=None, **k):
        chamadas.append((method, path, token))
        return 200, GOOD | {"session": "Y; rm -rf /"}
    monkeypatch.setattr(external_pairs, "call", call)
    r = owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK})
    assert r.status_code == 502
    assert ("DELETE", "/api/pair", GOOD["token"]) in chamadas
    assert external_pairs.all() == [] and pair.PairLink("Y").get() is None
    assert not any(s.revoked_at is None for s in share_store._load().values())


def test_aceite_com_aviso_que_falha_restaura_o_grupo_e_desfaz_la(owner_client, monkeypatch):
    import app.api as api_mod
    chamadas = []

    def call(address, token, method, path, body=None, **k):
        chamadas.append((method, path))
        return 200, GOOD

    async def deliver(name, text):
        return {"msg": "fila cheia"}
    monkeypatch.setattr(external_pairs, "call", call)
    monkeypatch.setattr(api_mod, "_deliver", deliver)
    assert owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK}).status_code == 502
    assert ("DELETE", "/api/pair") in chamadas
    assert external_pairs.all() == [] and pair.PairLink("Y").get() is None


def test_resgate_com_falha_ao_gravar_o_registro_desfaz_tudo(client, entregues, monkeypatch):
    def add(rec):
        raise OSError("disco cheio")
    monkeypatch.setattr(external_pairs, "add", add)
    _, code = share_store.create("X", "t:1", kind="pair")
    assert _redeem(client, code).status_code == 500
    assert pair.PairLink("X").get() is None and entregues == []
    assert not any(s.redeemed_at and s.revoked_at is None for s in share_store._load().values())


def test_aceite_com_convite_usado_mostra_a_frase_do_convite(owner_client, monkeypatch):
    remoto = {"code": "erro_convite_usado", "params": {"reason": "used"}, "msg": "este convite já foi usado"}
    monkeypatch.setattr(external_pairs, "call", lambda *a, **k: (_ for _ in ()).throw(
        peers.PeerError(f"x respondeu HTTP 410: {remoto}", status=410, detail=remoto)))
    r = owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK})
    assert r.status_code == 410
    assert r.json()["detail"]["code"] == "erro_convite_usado"


def test_aceite_recusado_por_outro_motivo_leva_so_o_texto_do_outro_lado(owner_client, monkeypatch):
    remoto = {"code": "erro_x", "params": {}, "msg": "uma das sessões já está pareada"}
    monkeypatch.setattr(external_pairs, "call", lambda *a, **k: (_ for _ in ()).throw(
        peers.PeerError("x respondeu HTTP 409: {...}", status=409, detail=remoto)))
    d = owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK}).json()["detail"]
    assert d["code"] == "erro_par_recusado" and d["params"]["detalhe"] == "uma das sessões já está pareada"


def test_aceite_com_falha_ao_gravar_o_registro_desfaz_la(owner_client, monkeypatch):
    chamadas = []

    def call(address, token, method, path, body=None, **k):
        chamadas.append((method, path))
        return 200, GOOD

    def add(rec):
        raise OSError("disco cheio")
    monkeypatch.setattr(external_pairs, "call", call)
    monkeypatch.setattr(external_pairs, "add", add)
    assert owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK}).status_code == 502
    assert ("DELETE", "/api/pair") in chamadas
    assert not any(s.revoked_at is None for s in share_store._load().values())


def test_aceite_com_disco_cheio_revoga_e_avisa_o_outro_lado_mesmo_sem_remover(owner_client, monkeypatch):
    chamadas = []

    def call(address, token, method, path, body=None, **k):
        chamadas.append((method, path))
        return 200, GOOD

    def save():
        raise OSError("disco cheio")
    monkeypatch.setattr(external_pairs, "call", call)
    monkeypatch.setattr(external_pairs, "_save", save)
    r = owner_client.post("/api/sessions/Y/pair-accept", json={"link": LINK})
    assert r.status_code == 502
    assert ("DELETE", "/api/pair") in chamadas
    assert not any(s.revoked_at is None for s in share_store._load().values())
