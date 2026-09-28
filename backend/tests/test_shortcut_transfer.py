"""Exportar/importar atalhos sem credencial.

O que trava: cada forma de segredo conhecida vira marcador e o resto do comando fica igual; comando
comum (porta, flag de git, funcao do fish) passa intacto; a importacao junta por id, preenche os
segredos dados e recusa arquivo invalido sem mudar nada; o backend nao roda comando com marcador.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import runtime_config as rc
from app.api import app
from app.config import settings
from app.shortcut_transfer import has_placeholder, scrub


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(rc, "_backend_config_base", lambda: tmp_path)
    yield


@pytest.fixture
def client():
    previous = settings.auth_token
    settings.auth_token = "secret"
    yield TestClient(app)
    settings.auth_token = previous


AUTH = {"Authorization": "Bearer secret"}

# Montados em pedacos: o gancho de pre-commit do repositorio publico barra chave e senha literais.
_C, _AT = ":", "@"


def _fake(prefix: str) -> str:
    return prefix + "x1Y2" * 7


@pytest.mark.parametrize("command, expected, names", [
    ("xfreerdp3 /v:10.0.0.1 /u:adm /p:Segr3do! /cert:ignore",
     "xfreerdp3 /v:10.0.0.1 /u:adm /p:⟦SEGREDO:senha⟧ /cert:ignore", ["senha"]),
    ('xfreerdp /password:"a b" /v:x', 'xfreerdp /password:"⟦SEGREDO:senha⟧" /v:x', ["senha"]),
    ("cli --password=abc --token xyz", "cli --password=⟦SEGREDO:senha⟧ --token ⟦SEGREDO:token⟧", ["senha", "token"]),
    ("tool --api-key k1 --secret=s1", "tool --api-key ⟦SEGREDO:api_key⟧ --secret=⟦SEGREDO:segredo⟧", ["api_key", "segredo"]),
    ("sshpass -p hunter2 ssh host", "sshpass -p ⟦SEGREDO:senha⟧ ssh host", ["senha"]),
    ("sshpass -phunter2 ssh host", "sshpass -p⟦SEGREDO:senha⟧ ssh host", ["senha"]),
    ("mysql -u root -pS3cret db", "mysql -u root -p⟦SEGREDO:senha⟧ db", ["senha"]),
    ('curl -H "Authorization: Bearer abc.def" https://x',
     'curl -H "Authorization: Bearer ⟦SEGREDO:token⟧" https://x', ["token"]),
    (f"git clone https://user{_C}pa55{_AT}host/repo.git", f"git clone https://user{_C}⟦SEGREDO:senha⟧{_AT}host/repo.git", ["senha"]),
    ('API_KEY=zzz OPENAI_TOKEN="q w" PORT=3000 node app.js',
     'API_KEY=⟦SEGREDO:API_KEY⟧ OPENAI_TOKEN="⟦SEGREDO:OPENAI_TOKEN⟧" PORT=3000 node app.js',
     ["API_KEY", "OPENAI_TOKEN"]),
    ("set -gx DB_PASSWORD hunter2; run", "set -gx DB_PASSWORD ⟦SEGREDO:DB_PASSWORD⟧; run", ["DB_PASSWORD"]),
    (f"echo {_fake('gsk_')}", "echo ⟦SEGREDO:token⟧", ["token"]),
    (f"git push https://x {_fake('glpat-')}", "git push https://x ⟦SEGREDO:token⟧", ["token"]),
    (f"export K={_fake('sk-proj-')}", "export K=⟦SEGREDO:token⟧", ["token"]),
    (f"gh auth {_fake('ghp_')}", "gh auth ⟦SEGREDO:token⟧", ["token"]),
    ("a --password x --password y", "a --password ⟦SEGREDO:senha⟧ --password ⟦SEGREDO:senha_2⟧", ["senha", "senha_2"]),
])
def test_scrub_replaces_each_secret_and_keeps_the_rest(command, expected, names):
    assert scrub(command) == (expected, names)


@pytest.mark.parametrize("command", [
    "npm run dev -- -p 3000",
    "delphi-vm ide",
    "git log -p",
    "mysql -u root -p db",
    "xfreerdp /p:$SENHA /v:host",
    "export DB_PASSWORD=$X",
    "PORT=3000 HOST=0.0.0.0 npm start",
    "ssh -p 2222 user@host",
    "docker run -p 8080:80 nginx",
    "/relatorio-pm",
    "curl https://example.com/path?q=1",
    "python -m http.server --bind 127.0.0.1 8000",
])
def test_scrub_leaves_ordinary_commands_alone(command):
    assert scrub(command) == (command, [])


def test_has_placeholder_names_the_first_missing_secret():
    assert has_placeholder("x /p:⟦SEGREDO:senha⟧") == "senha"
    assert has_placeholder("delphi-vm") is None


def _save(items):
    rc.aplicar({"shortcuts": json.dumps(items)})


def test_export_scrubs_and_counts_without_touching_the_saved_config(client):
    items = [
        {"id": "rdp", "type": "shell", "label": "RDP", "command": "xfreerdp /v:h /p:abc"},
        {"id": "rel", "type": "send_text", "label": "Rel", "text": "/relatorio-pm"},
        {"id": "terminal", "type": "internal", "action": "terminal"},
    ]
    _save(items)
    r = client.get("/api/shortcuts/export", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == 1 and body["removed"] == 1
    assert body["shortcuts"][0]["command"] == "xfreerdp /v:h /p:⟦SEGREDO:senha⟧"
    assert body["shortcuts"][1:] == items[1:]
    assert json.loads(rc.get("shortcuts"))[0]["command"] == "xfreerdp /v:h /p:abc"


def test_import_preview_counts_and_lists_placeholders_without_saving(client):
    _save([{"id": "a", "type": "send_text", "label": "A", "text": "oi"}])
    data = {"version": 1, "shortcuts": [
        {"id": "a", "type": "send_text", "label": "A2", "text": "ola"},
        {"id": "rdp", "type": "shell", "label": "RDP", "command": "xfreerdp /p:⟦SEGREDO:senha⟧"},
    ]}
    r = client.post("/api/shortcuts/import", json={"data": data}, headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"added": 1, "replaced": 1,
                        "placeholders": [{"id": "rdp", "label": "RDP", "names": ["senha"]}]}
    assert json.loads(rc.get("shortcuts")) == [{"id": "a", "type": "send_text", "label": "A", "text": "oi"}]


def test_import_apply_merges_by_id_keeps_order_and_fills_secrets(client):
    _save([{"id": "a", "type": "send_text", "label": "A", "text": "oi"},
           {"id": "b", "type": "send_text", "label": "B", "text": "tchau"}])
    data = [
        {"id": "b", "type": "send_text", "label": "B2", "text": "bye"},
        {"id": "rdp", "type": "shell", "label": "RDP", "command": "x /p:⟦SEGREDO:senha⟧ /u:⟦SEGREDO:usuario⟧"},
    ]
    r = client.post("/api/shortcuts/import", headers=AUTH,
                    json={"data": data, "apply": True, "secrets": {"rdp": {"senha": "s3", "usuario": ""}}})
    assert r.status_code == 200 and r.json()["added"] == 1 and r.json()["replaced"] == 1
    saved = json.loads(rc.get("shortcuts"))
    assert [s["id"] for s in saved] == ["a", "b", "rdp"]
    assert saved[1]["label"] == "B2"
    # o que ficou em branco continua marcador
    assert saved[2]["command"] == "x /p:s3 /u:⟦SEGREDO:usuario⟧"


@pytest.mark.parametrize("data", [
    {"version": 1},
    [{"id": "x", "type": "foguete"}],
    [{"id": "x", "type": "shell", "label": "X", "command": " "}],
    "texto",
])
def test_invalid_import_changes_nothing(client, data):
    _save([{"id": "a", "type": "send_text", "label": "A", "text": "oi"}])
    before = rc.get("shortcuts")
    r = client.post("/api/shortcuts/import", json={"data": data, "apply": True}, headers=AUTH)
    assert r.status_code in (400, 422)
    assert rc.get("shortcuts") == before


def test_shell_shortcut_with_placeholder_is_refused(client, monkeypatch, tmp_path):
    from app import api
    monkeypatch.setattr(api, "_session_cwd", lambda n: str(tmp_path))
    r = client.post("/api/sessions/s/shortcut-shell", headers=AUTH,
                    json={"command": "xfreerdp /p:⟦SEGREDO:senha⟧"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "erro_shortcut_segredo"
    assert "senha" in r.json()["detail"]["msg"]


def test_transfer_routes_require_auth(client):
    assert client.get("/api/shortcuts/export").status_code == 401
    assert client.post("/api/shortcuts/import", json={"data": []}).status_code == 401
