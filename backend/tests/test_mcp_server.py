import contextlib

import httpx2
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app import mcp_server, quem_chama
from app.config import settings

pytestmark = pytest.mark.asyncio


@contextlib.asynccontextmanager
async def sessao_mcp(cabecalhos: dict[str, str]):
    settings.auth_token = "secret"
    async with mcp_server.lifespan():
        transporte = httpx2.ASGITransport(app=mcp_server.asgi)
        async with httpx2.AsyncClient(transport=transporte, base_url="http://127.0.0.1",
                                      headers={"Authorization": "Bearer secret", **cabecalhos}) as hc:
            async with streamable_http_client("http://127.0.0.1/", http_client=hc) as (r, w, *_):
                async with ClientSession(r, w) as s:
                    await s.initialize()
                    yield s


@pytest.fixture
def identidade(monkeypatch):
    monkeypatch.setattr(quem_chama, "resolver",
                        lambda h: ("eu", "pane") if h.get("x-hangar-pane") == "%3" else
                        (_ for _ in ()).throw(quem_chama.SessaoDesconhecida(quem_chama.DICA)))


async def test_sem_token_401():
    settings.auth_token = "secret"
    async with mcp_server.lifespan():
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=mcp_server.asgi),
                                      base_url="http://127.0.0.1") as hc:
            assert (await hc.post("/", json={})).status_code == 401


async def test_lista_tools_e_quem_sou(identidade):
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        nomes = {t.name for t in (await s.list_tools()).tools}
        assert nomes == {"quem_sou", "sessoes", "enviar"}
        res = await s.call_tool("quem_sou", {})
        assert not res.is_error and res.structured_content == {"name": "eu", "origem": "pane"}


async def test_sem_identidade_e_erro_nao_cli(identidade):
    async with sessao_mcp({}) as s:
        res = await s.call_tool("quem_sou", {})
        assert res.is_error and "sessao_desconhecida" in res.content[0].text


async def test_enviar_prefixa_de_e_recusa_caminho_nativo(identidade, monkeypatch):
    from app import api
    enviados = []

    async def input_prompt(name, body):
        enviados.append((name, body.text, body.steer))
        return {"delivered": True, "steered": True}

    uds = {"valor": None}
    monkeypatch.setattr(api, "input_prompt", input_prompt)
    monkeypatch.setattr(api, "peer_address", lambda name: _coro({"uds": uds["valor"]}))
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        res = await s.call_tool("enviar", {"alvo": "outra", "texto": "oi"})
        assert not res.is_error and res.structured_content["steered"] is True
        assert enviados == [("outra", "[de: eu] oi", True)]
        uds["valor"] = "/tmp/x.sock"
        res = await s.call_tool("enviar", {"alvo": "outra", "texto": "oi"})
        assert res.is_error and "SendMessage" in res.content[0].text
        res = await s.call_tool("enviar", {"alvo": "outra", "texto": "oi", "tmux": True})
        assert not res.is_error and len(enviados) == 2


async def _coro(v):
    return v
