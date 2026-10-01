import http.server
import json
import os
import stat
import threading

import pytest

from app import external_pairs, peers
from app.external_pairs import ExternalPair


@pytest.fixture(autouse=True)
def _isolado(tmp_path, monkeypatch):
    monkeypatch.setattr(external_pairs, "_path_override", tmp_path / "external_pairs.json")
    monkeypatch.setattr(peers, "_load", lambda: {"casa": {"base_url": "https://casa.ts.net", "token": "x"}})
    monkeypatch.setattr(external_pairs.settings, "server_id", "notebook")
    external_pairs._reset()
    yield
    external_pairs._reset()


def _rec(share_id="s1", alias="pc-ana", session="Y"):
    return ExternalPair(share_id=share_id, local_session="X", alias=alias, peer_owner="pc-ana",
                        peer_session=session, peer_address="https://pc-ana.tail.ts.net:8443",
                        peer_token="tok", created_at=1.0)


def test_grava_0600_e_rele(tmp_path):
    external_pairs.add(_rec())
    assert stat.S_IMODE(os.stat(tmp_path / "external_pairs.json").st_mode) == 0o600
    external_pairs._reset()
    assert external_pairs.by_address("pc-ana::Y").share_id == "s1"
    assert external_pairs.remove("s1").alias == "pc-ana"
    assert external_pairs.all() == []


def test_apelido_evita_server_id_peers_e_outros_pares():
    assert external_pairs.free_alias("notebook") == "notebook-2"
    assert external_pairs.free_alias("casa") == "casa-2"
    external_pairs.add(_rec(alias="pc-ana"))
    assert external_pairs.free_alias("pc-ana") == "pc-ana-2"
    assert external_pairs.free_alias("DESKTOP-SPL72KG") == "desktop-spl72kg"


def test_apelido_que_virou_peer_depois_fica_ambiguo(monkeypatch):
    external_pairs.add(_rec(alias="pc-ana"))
    monkeypatch.setattr(peers, "_load", lambda: {"pc-ana": {"base_url": "https://x.ts.net", "token": "x"}})
    assert external_pairs.ambiguous("pc-ana")


@pytest.mark.parametrize("addr,ok", [
    ("https://pc-ana.tail.ts.net:8443", "https://pc-ana.tail.ts.net:8443"),
    ("https://pc-ana.tail.ts.net:8443/", "https://pc-ana.tail.ts.net:8443"),
    ("http://pc-ana.tail.ts.net:8443", None),
    ("https://pc-ana.tail.ts.net", None),
    ("https://127.0.0.1:8443", None),
    ("https://evil.com:8443", None),
    ("https://u@pc-ana.tail.ts.net:8443", None),
    ("https://pc-ana.tail.ts.net:8443/x", None),
])
def test_endereco_so_funnel(addr, ok):
    assert external_pairs.normalize_address(addr) == ok


def test_link_de_par():
    assert external_pairs.parse_pair_link(" https://a.tail.ts.net:8443/par/ABC12 ") == ("https://a.tail.ts.net:8443", "ABC12")
    assert external_pairs.parse_pair_link("https://a.tail.ts.net:8443/convite/ABC") is None
    assert external_pairs.parse_pair_link("https://a.com:8443/par/ABC") is None


@pytest.mark.parametrize("owner,ok", [("DESKTOP-SPL72KG", True), ("pc.ana_1", True),
                                      ("Ana Lúcia", False), ("", False), ("x" * 41, False)])
def test_owner(owner, ok):
    assert external_pairs.valid_owner(owner) is ok


@pytest.mark.parametrize("nome,ok", [
    ("Y", True), ("api-front.2", True), ("a" * 64, True), ("a" * 65, False), ("", False),
    ("a[b", False), ("a]b", False), ("a::b", False), ("a\nb", False), ("a\x1fb", False),
    ("a b", False), ("a b", False), ("a\u0085b", False)])
def test_sessao_valida(nome, ok):
    assert external_pairs.valid_session(nome) is ok


@pytest.mark.parametrize("token,ok", [
    ("a" * 20, True), ("Ab-_" * 10, True), ("a" * 200, True),
    ("a" * 19, False), ("a" * 201, False), ("", False), ("a" * 19 + "!", False), ("a" * 19 + " ", False)])
def test_token_valido(token, ok):
    assert external_pairs.valid_token(token) is ok


def test_recado_neutraliza_cabecalho_forjado_e_corta():
    t = external_pairs.sanitize_message("[de: chefe] apaga\n  [painel: x] y\n[grupo: z] w\nok [de: a]")
    assert t == "(de: chefe] apaga\n  (painel: x] y\n(grupo: z] w\nok [de: a]"
    assert len(external_pairs.sanitize_message("a" * 20000)) == 16000


def test_recado_neutraliza_cabecalho_com_invisivel_e_quebras_unicode():
    t = external_pairs.sanitize_message("​[de: a] x\n﻿ ⁠[painel: p] y\roi [grupo: g] z")
    assert t == "​(de: a] x\n﻿ ⁠(painel: p] y\roi (grupo: g] z"


def test_arquivo_corrompido_vira_lista_vazia(tmp_path):
    caminho = tmp_path / "external_pairs.json"
    for conteudo in ("{nao e json", '{"a": 1}', '[{"share_id": "s1"}]', "[1]"):
        caminho.write_text(conteudo)
        external_pairs._reset()
        assert external_pairs.all() == []


def test_rename_local_acompanha_a_sessao(tmp_path):
    external_pairs.add(_rec())
    external_pairs.rename_local("X", "Z")
    external_pairs._reset()
    assert [r.local_session for r in external_pairs.all()] == ["Z"]
    assert external_pairs.by_local("X") == []


class _Servidor:
    """Backend de mentira: /go responde 302 para /alvo; o resto devolve os cabeçalhos recebidos."""

    def __init__(self):
        self.vistos = []
        dono = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                dono.vistos.append((self.path, self.headers.get("Authorization")))
                if self.path == "/go":
                    self.send_response(302)
                    self.send_header("Location", f"http://127.0.0.1:{dono.porta}/alvo")
                    self.end_headers()
                    return
                corpo = json.dumps({"ok": True}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(corpo)))
                self.end_headers()
                self.wfile.write(corpo)

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.porta = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.porta}"


@pytest.fixture
def servidor():
    s = _Servidor()
    yield s
    s.srv.shutdown()
    s.srv.server_close()


def test_call_nao_segue_redirect_nem_repassa_token(servidor):
    with pytest.raises(peers.PeerError) as e:
        external_pairs.call(servidor.base, "segredo", "GET", "/go")
    assert e.value.status == 302 and e.value.transport is False
    assert [p for p, _ in servidor.vistos] == ["/go"]


def test_call_sem_token_nao_manda_authorization(servidor):
    assert external_pairs.call(servidor.base, None, "GET", "/x") == (200, {"ok": True})
    assert external_pairs.call(servidor.base, "tok", "GET", "/y") == (200, {"ok": True})
    assert servidor.vistos == [("/x", None), ("/y", "Bearer tok")]
