"""Tela remota do navegador servida pelo app nativo: o `navsock` fala com o `/cdp` dele em vez da 9223."""
import asyncio
import json

import pytest
import websockets

from app import navshell, navsock

SIDECAR = {"chave": "srv1::nav-teste", "url": "http://x/", "targetId": None, "pid": 123}


class _Tela:
    """O `WebSocket` do celular, só com o que o fluxo de quadros usa."""

    def __init__(self):
        self.enviados: list[dict] = []

    async def send_text(self, texto: str) -> None:
        self.enviados.append(json.loads(texto))


def _srv(monkeypatch, porta: int, pid: int = 123) -> None:
    monkeypatch.setattr(navshell, "_servidor", lambda: {"porta": porta, "token": "tok", "pid": pid})


def test_conexao_escolhe_o_dono_do_navegador(monkeypatch):
    eletron = navsock._conexao({"chave": "s::a", "targetId": "ABC"})
    assert eletron and eletron._url == "ws://127.0.0.1:9223/devtools/page/ABC" and eletron._headers is None

    _srv(monkeypatch, 4567)
    nativo = navsock._conexao(SIDECAR)
    assert nativo and nativo._url == "ws://127.0.0.1:4567/cdp?chave=srv1%3A%3Anav-teste"
    assert nativo._headers == {"Authorization": "Bearer tok"}

    # O `_srv.json` é de outro processo (o Electron subiu depois): o token dele não abre este navegador.
    _srv(monkeypatch, 4567, pid=999)
    assert navsock._conexao(SIDECAR) is None

    def _sem_app():
        raise navshell.ShellIndisponivel("fechado")
    monkeypatch.setattr(navshell, "_servidor", _sem_app)
    assert navsock._conexao(SIDECAR) is None
    assert navsock._conexao({"chave": "s::a", "targetId": None}) is None


async def test_quadros_entrada_e_fim_pelo_repasse_do_nativo(monkeypatch):
    recebidos: list[dict] = []
    cabecalhos: dict = {}
    pronto = asyncio.Event()

    async def nativo(ws):
        cabecalhos["Authorization"] = ws.request.headers.get("Authorization")
        cabecalhos["path"] = ws.request.path
        async for bruto in ws:
            msg = json.loads(bruto)
            recebidos.append(msg)
            await ws.send(json.dumps({"id": msg["id"], "result": {}}))
            if msg["method"] == "Page.startScreencast":
                await ws.send(json.dumps({"method": "Page.screencastFrame", "params": {
                    "data": "QUJD", "sessionId": 7, "metadata": {"deviceWidth": 390, "deviceHeight": 844}}}))
                await ws.send(json.dumps({"method": "Page.frameNavigated",
                                          "params": {"frame": {"url": "http://y/"}}}))
            if msg["method"] == "Input.dispatchMouseEvent":
                pronto.set()
                await ws.send(json.dumps({"method": "Inspector.detached",
                                          "params": {"reason": "replaced_by_another_viewer"}}))

    async with websockets.serve(nativo, "127.0.0.1", 0) as server:
        _srv(monkeypatch, server.sockets[0].getsockname()[1])
        conexao = navsock._conexao(SIDECAR)
        assert conexao
        tela = _Tela()
        estado = {"w": 1280, "h": 800, "pedida": 390}
        async with conexao as cdp:
            assert await navsock._url_atual(cdp, SIDECAR) == "http://x/"
            fluxo = asyncio.create_task(navsock._fluxo_de_quadros(cdp, tela, estado))
            while not any(m.get("t") == "url" for m in tela.enviados):
                await asyncio.sleep(0.01)
            await navsock._aplicar_entrada(cdp, {"t": "m", "acao": "press", "x": 0.5, "y": 0.5},
                                           estado["w"], estado["h"])
            await asyncio.wait_for(pronto.wait(), 5)
            with pytest.raises(ConnectionError, match="outro aparelho"):
                await asyncio.wait_for(fluxo, 5)

    assert cabecalhos["Authorization"] == "Bearer tok"
    assert cabecalhos["path"] == "/cdp?chave=srv1%3A%3Anav-teste"
    metodos = [m["method"] for m in recebidos]
    # Sem `Runtime.evaluate`: o repasse do nativo não o abre, e a url vem do sidecar.
    assert "Runtime.evaluate" not in metodos
    assert metodos[:2] == ["Page.enable", "Page.startScreencast"]
    ack = next(m for m in recebidos if m["method"] == "Page.screencastFrameAck")
    assert ack["params"] == {"sessionId": 7}
    clique = next(m for m in recebidos if m["method"] == "Input.dispatchMouseEvent")
    assert (clique["params"]["x"], clique["params"]["y"]) == (195, 422)
    assert {"t": "q", "d": "QUJD", "w": 390, "h": 844} in tela.enviados
    assert {"t": "url", "url": "http://y/"} in tela.enviados


class _CdpFalso:
    def __init__(self):
        self.enviados: list[tuple[str, dict]] = []

    def envia(self, metodo: str, params: dict) -> None:
        self.enviados.append((metodo, params))


async def test_tecla_nomeada_leva_codigo_virtual():
    cdp = _CdpFalso()
    await navsock._aplicar_entrada(cdp, {"t": "k", "key": "Backspace"}, 390, 844)
    await navsock._aplicar_entrada(cdp, {"t": "k", "key": "Enter"}, 390, 844)
    (_, desce), (_, sobe), (_, enter), (_, enter_sobe) = cdp.enviados
    assert (desce["type"], desce["windowsVirtualKeyCode"], desce["code"]) == ("keyDown", 8, "Backspace")
    assert sobe["type"] == "keyUp" and "text" not in sobe
    # Enter leva `\r` só na descida: é o que faz o formulário enviar.
    assert (enter["windowsVirtualKeyCode"], enter["text"]) == (13, "\r")
    assert "text" not in enter_sobe


@pytest.mark.parametrize("nome, motivo", [("sem-terminal", "sessao sem navegador"),
                                          ("nenhuma", "sessao nao existe")])
def test_rota_aceita_sessao_sem_terminal(monkeypatch, nome, motivo):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    import app.api as api_mod
    from app import tmux
    from app.config import settings
    monkeypatch.setattr(settings, "auth_token", "secret")
    monkeypatch.setattr(tmux, "has_session", lambda n: False)
    monkeypatch.setattr(api_mod, "_session_exists", lambda n: n == "sem-terminal")
    monkeypatch.setattr(navsock, "alvo_da_sessao", lambda n, exige_alvo=True: None)
    cliente = TestClient(api_mod.app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 1))
    with pytest.raises(WebSocketDisconnect) as e:
        with cliente.websocket_connect(f"/api/sessions/{nome}/nav-remoto?token=secret"):
            pass
    # Sem terminal passa da checagem de sessão e só para por não ter navegador.
    assert (e.value.code, e.value.reason) == (1008, motivo)


def test_token_do_dono_abre_de_qualquer_origem(monkeypatch):
    """Token na query não é credencial ambiente: a Origin não é conferida e a conexão segue."""
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    import app.api as api_mod
    from app import tmux
    from app.config import settings
    monkeypatch.setattr(settings, "auth_token", "secret")
    monkeypatch.setattr(tmux, "has_session", lambda n: False)
    monkeypatch.setattr(api_mod, "_session_exists", lambda n: False)
    cliente = TestClient(api_mod.app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 1))
    with pytest.raises(WebSocketDisconnect) as e:
        with cliente.websocket_connect("/api/sessions/x/nav-remoto?token=secret",
                                       headers={"origin": "https://evil.com"}):
            pass
    assert (e.value.code, e.value.reason) == (1008, "sessao nao existe")


def _layout_falso(monkeypatch, inicial: str = "desktop", recusa: str = "") -> dict:
    layout = {"atual": inicial}

    def verbo(name, v, args=None, aba=None, teto_s=0):
        assert (name, v) == ("s", "layout")
        if args:
            pedido = "x".join(args) if len(args) == 2 else args[0]
            if pedido == recusa:
                return f"erro: layout {pedido}: recusado"
            layout["atual"] = pedido
        return f"layout: {layout['atual']}"

    monkeypatch.setattr(navshell, "verbo", verbo)
    monkeypatch.setattr(navsock, "_imposto", {})
    return layout


async def test_espectador_impoe_o_tamanho_dele_e_devolve_o_de_antes(monkeypatch):
    layout = _layout_falso(monkeypatch, inicial="mobile")
    a, b, tela = {"w": 1280, "h": 800}, {"w": 1280, "h": 800}, _Tela()

    await navsock._layout_do_espectador("s", {"t": "layout", "w": 900, "h": 700}, a, tela)
    assert (layout["atual"], a["w"], a["h"]) == ("900x700", 900, 700)
    # Reconexão com o mesmo tamanho: a conexão velha cai depois e não desfaz o da nova.
    await navsock._layout_do_espectador("s", {"t": "layout", "w": 900, "h": 700}, b, tela)
    await navsock._devolver_layout("s", a)
    assert layout["atual"] == "900x700", "quem saiu não desfaz o tamanho de quem está olhando"
    await navsock._devolver_layout("s", b)
    assert (layout["atual"], navsock._imposto) == ("mobile", {}), "o de antes é o da sessão, não o do primeiro espectador"
    await navsock._layout_do_espectador("s", {"t": "layout", "w": 0, "h": 700}, a, tela)
    assert layout["atual"] == "mobile", "tamanho inválido não chega ao navegador"


async def test_recusa_e_troca_pelo_celular_nao_deixam_tamanho_preso(monkeypatch):
    layout = _layout_falso(monkeypatch, recusa="900x700")
    a, tela = {"w": 1280, "h": 800}, _Tela()

    await navsock._layout_do_espectador("s", {"t": "layout", "w": 900, "h": 700}, a, tela)
    assert (layout["atual"], navsock._imposto, tela.enviados[-1]["t"]) == ("desktop", {}, "layout")
    assert tela.enviados[-1]["resposta"].startswith("erro:"), "a recusa chega a quem olha"

    await navsock._layout_do_espectador("s", {"t": "layout", "w": 600, "h": 500}, a, tela)
    layout["atual"] = "mobile"   # o celular trocou o layout no meio
    await navsock._devolver_layout("s", a)
    assert (layout["atual"], navsock._imposto) == ("mobile", {}), "a escolha de depois fica, e nada sobra guardado"


async def test_print_em_laco_sem_esperar_screencast_a_cada_quadro(monkeypatch):
    """Sem compositor, a espera pelo screencast é paga uma vez; o print segue no ritmo dele."""
    monkeypatch.setattr(navsock, "ESPERA_SCREENCAST", 0.3)
    monkeypatch.setattr(navsock, "INTERVALO_PRINT", 0.05)

    class Cdp:
        eventos: asyncio.Queue = asyncio.Queue()
        pedidos: list[tuple[str, dict]] = []

        async def cmd(self, metodo, params=None, espera=10):
            self.pedidos.append((metodo, params or {}))
            return {"result": {"data": "QUJD"}} if metodo == "Page.captureScreenshot" else {"result": {}}

    cdp, tela = Cdp(), _Tela()
    estado = {"w": 1280, "h": 800, "pedida": 1200, "qualidade": 80}
    fluxo = asyncio.create_task(navsock._fluxo_de_quadros(cdp, tela, estado))
    await asyncio.sleep(1.0)
    fluxo.cancel()
    prints = [m for m in tela.enviados if m.get("t") == "q" and m.get("lento")]
    assert len(prints) >= 6, f"{len(prints)} prints em 1 s"
    qualidades = {p.get("quality") for m, p in cdp.pedidos if m in ("Page.startScreencast", "Page.captureScreenshot")}
    assert qualidades == {80}, "quem olha numa tela grande pede a qualidade"
