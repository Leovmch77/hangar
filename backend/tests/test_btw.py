"""Pergunta lateral (/btw): a rota é do servidor Rust. Sem ele, o Python diz isso com código."""
from fastapi.testclient import TestClient

from app.api import app
from app.config import settings


def test_btw_without_the_rust_server_says_so(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "t-btw")
    client = TestClient(app)
    auth = {"Authorization": "Bearer t-btw"}
    for resp in (client.post("/api/sessions/s/btw", json={"question": "q"}, headers=auth),
                 client.get("/api/sessions/s/btw", headers=auth)):
        assert resp.status_code == 503, resp.text
        assert resp.json()["detail"]["code"] == "btw_needs_rust_server"
    assert client.get("/api/sessions/s/btw").status_code == 401
