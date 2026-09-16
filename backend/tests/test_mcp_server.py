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


async def test_sem_token_401_e_fora_da_maquina_403():
    settings.auth_token = "secret"
    async with mcp_server.lifespan():
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=mcp_server.asgi),
                                      base_url="http://127.0.0.1") as hc:
            assert (await hc.post("/", json={})).status_code == 401
        settings.auth_token = ""
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=mcp_server.asgi),
                                      base_url="http://127.0.0.1", headers={"Authorization": "Bearer "}) as hc:
            assert (await hc.post("/", json={})).status_code == 401
        settings.auth_token = "secret"
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=mcp_server.asgi, client=("10.0.0.5", 1)),
                                      base_url="http://127.0.0.1", headers={"Authorization": "Bearer secret"}) as hc:
            assert (await hc.post("/", json={})).status_code == 403


async def test_lista_tools_e_quem_sou(identidade):
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        nomes = {t.name for t in (await s.list_tools()).tools}
        assert nomes == {"quem_sou", "sessoes", "enviar", "grupo", "parear", "desparear", "nova_sessao",
                         "nav_abrir", "nav", "nav_lote"}
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


async def test_nav_sem_app_desktop_da_o_erro_do_cli(identidade, monkeypatch):
    def sem_shell(*a, **k):
        raise mcp_server.navshell.ShellIndisponivel("o app desktop não está aberto nesta máquina")
    monkeypatch.setattr(mcp_server.navshell, "verbo", sem_shell)
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        res = await s.call_tool("nav", {"verbo": "snapshot"})
        assert res.is_error and "app desktop não está aberto" in res.content[0].text
        res = await s.call_tool("nav", {"verbo": "voar"})
        assert res.is_error and "verbo desconhecido" in res.content[0].text


async def test_nav_shot_gera_caminho_e_aba_passa(identidade, monkeypatch, tmp_path):
    chamadas = []

    def verbo(name, v, args=None, aba=None):
        chamadas.append((name, v, args, aba))
        return f"ok: {v} {args[0] if args else ''}"

    monkeypatch.setattr(mcp_server.navshell, "verbo", verbo)
    monkeypatch.setattr(mcp_server.Path, "home", lambda: tmp_path)
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        res = await s.call_tool("nav", {"verbo": "shot", "aba": 2})
        assert not res.is_error
        nome, v, args, aba = chamadas[0]
        assert (nome, v, aba) == ("eu", "shot", 2)
        assert args[0].startswith(str(tmp_path / ".hangar" / "nav" / "shots" / "eu")) and args[0].endswith(".png")
        assert (tmp_path / ".hangar" / "nav" / "shots" / "eu").is_dir()


async def test_nav_layout_encaminha_tamanho_personalizado(identidade, monkeypatch):
    chamadas = []

    def verbo(name, v, args=None, aba=None):
        chamadas.append((name, v, args, aba))
        return "layout: 1366x768"

    monkeypatch.setattr(mcp_server.navshell, "verbo", verbo)
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        res = await s.call_tool("nav", {"verbo": "layout", "args": [1366, 768]})

    assert not res.is_error and res.content[0].text == "layout: 1366x768"
    assert chamadas == [("eu", "layout", ["1366", "768"], None)]


async def test_nav_lote_para_no_primeiro_erro(identidade, monkeypatch):
    def verbo(name, v, args=None, aba=None):
        return "erro: ref @e9 nao existe" if v == "click" else f"ok: {v}"

    monkeypatch.setattr(mcp_server.navshell, "verbo", verbo)
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        res = await s.call_tool("nav_lote", {"passos": [{"verbo": "snapshot"}, {"verbo": "click", "args": ["@e9"]},
                                                        {"verbo": "text"}]})
        assert res.is_error
        txt = res.content[0].text
        assert "parou no passo 1 (click)" in txt and "@e9" in txt and "ok: snapshot" in txt
        res = await s.call_tool("nav_lote", {"passos": [{"verbo": "snapshot"}, {"verbo": "text"}]})
        assert not res.is_error and res.structured_content == {"feitos": ["ok: snapshot", "ok: text"]}


async def test_grupo_parear_nova_sessao_chamam_as_rotas_como_eu(identidade, monkeypatch):
    from app import api
    from app.models import SessionInfo
    chamadas = {}

    async def group_message(name, body):
        chamadas["grupo"] = (name, body.text, body.forcar_tmux); return {"peers": ["x"], "pulados": []}

    async def pair_session(name, body):
        chamadas["parear"] = (name, body.peer, body.task); return {"ok": True}

    async def unpair_session(name):
        chamadas["desparear"] = name; return {"ok": True}

    async def create_session(body):
        chamadas["nova"] = (body.name, body.cwd, body.provider, body.headless)
        return SessionInfo(name=body.name, cwd=body.cwd, provider=body.provider, headless=body.headless)

    for n, f in (("group_message", group_message), ("pair_session", pair_session),
                 ("unpair_session", unpair_session), ("create_session", create_session)):
        monkeypatch.setattr(api, n, f)
    async with sessao_mcp({"X-Hangar-Pane": "%3"}) as s:
        assert not (await s.call_tool("grupo", {"texto": "marco"})).is_error
        assert not (await s.call_tool("parear", {"alvo": "outra", "tarefa": "t"})).is_error
        assert not (await s.call_tool("desparear", {})).is_error
        res = await s.call_tool("nova_sessao", {"nome": "nova", "cwd": "/tmp", "provider": "codex", "headless": True})
        assert res.structured_content["name"] == "nova"
        res = await s.call_tool("nova_sessao", {"nome": "n2", "cwd": "/tmp", "provider": "pi", "headless": True})
        assert res.is_error and "headless só vale" in res.content[0].text
    assert chamadas == {"grupo": ("eu", "marco", False), "parear": ("eu", "outra", "t"), "desparear": "eu",
                        "nova": ("nova", "/tmp", "codex", True)}


async def _coro(v):
    return v
