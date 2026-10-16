"""O MCP `hangar` é do Rust: com ele fora, `/mcp` responde o código próprio em vez de cair no estático."""
from fastapi.testclient import TestClient

from app.api import app
from app.config import settings


def test_mcp_without_the_rust_server_says_so(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "t-mcp")
    client = TestClient(app)
    for path in ("/mcp", "/mcp/"):
        resp = client.post(path, json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                           headers={"Authorization": "Bearer t-mcp"}, follow_redirects=False)
        assert resp.status_code == 503, (path, resp.status_code)
        assert resp.json()["detail"]["code"] == "mcp_needs_rust_server"
    assert client.post("/mcp/", json={}).status_code == 401
