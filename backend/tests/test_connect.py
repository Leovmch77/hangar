import base64
import json

import pytest

from app import connect
from app.connect_port import CONNECT_PORT


def _codigo(**over):
    d = {"v": 1, "server": "connect.hangar.dev.br", "token": "a" * 64,
         "host": "notebook.jeffersonfelizardo.hangar.dev.br", **over}
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


def test_codigo_valido():
    c = connect.parse_code(_codigo())
    assert (c.server, c.host) == ("connect.hangar.dev.br", "notebook.jeffersonfelizardo.hangar.dev.br")


@pytest.mark.parametrize("over", [
    {"v": 2}, {"host": "hangar.dev.br"}, {"host": 'x".y.z'}, {"host": "a.b.c\n[x]"}, {"host": "a.b.c\n"},
    {"token": 'abc"def' + "a" * 20}, {"token": "curto"}, {"server": "connect hangar"},
])
def test_codigo_recusado(over):
    with pytest.raises(connect.ConnectError):
        connect.parse_code(_codigo(**over))


def test_codigo_ilegivel():
    with pytest.raises(connect.ConnectError):
        connect.parse_code("@@@não é base64@@@")


def test_frpc():
    toml = connect.render_frpc(connect.parse_code(_codigo()))
    assert 'serverAddr = "connect.hangar.dev.br"' in toml
    assert 'transport.protocol = "wss"' in toml
    assert f"localPort = {connect.CADDY_PORT}" in toml
    assert 'customDomains = ["notebook.jeffersonfelizardo.hangar.dev.br"]' in toml


def test_caddyfile(tmp_path):
    texto = connect.render_caddyfile(connect.parse_code(_codigo()), tmp_path / "com espaço")
    assert f'storage file_system "{(tmp_path / "com espaço").as_posix()}"' in texto
    assert "notebook.jeffersonfelizardo.hangar.dev.br {" in texto
    assert f"reverse_proxy 127.0.0.1:{CONNECT_PORT}" in texto
    assert "bind 127.0.0.1" in texto


def test_estado_ida_e_volta(tmp_path, monkeypatch):
    monkeypatch.setattr(connect, "folder", lambda: tmp_path)
    assert connect.read_state() == {}
    connect.write_state({"code": "x", "enabled": True})
    assert connect.read_state() == {"code": "x", "enabled": True}
