"""Ponte do plugin de function hooks: a regra de quem fica com o pedido de permissão e a ida e volta
da resposta do app. O resto (envio por `fill`) depende de tmux e é conferido no uso real."""
import asyncio
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import plugin_bridge as pb


@pytest.fixture(autouse=True)
def _limpa():
    yield
    for d in (pb._perguntas, pb._waiters, pb._estados, pb._batidas, pb._eventos, pb._fechadas):
        d.clear()
    pb._apps_abertos = 0


def _corpo(id: str, **extra) -> pb.AskBody:
    return pb.AskBody(sessao="s1", token=pb.mint("s1"), id=id, **extra)


def test_token_e_por_sessao_e_recusa_o_de_outra():
    assert pb.mint("s1") == pb.mint("s1") and pb.mint("s1") != pb.mint("s2")
    with pytest.raises(HTTPException) as e:
        asyncio.run(pb.ask(pb.AskBody(sessao="s1", token=pb.mint("s2"), id="x")))
    assert e.value.status_code == 403


def test_permissao_sem_ninguem_no_app_volta_pro_terminal(monkeypatch):
    # Segurar o `ask` esconde o diálogo do terminal: sem app aberto, não há quem responda.
    monkeypatch.setattr(pb, "terminal_preso", lambda name: False)
    assert asyncio.run(pb.ask(_corpo("perm:t1", tool="Bash"))) == {"soltar": True}
    assert pb.pergunta_pendente("s1") is None


def test_permissao_com_terminal_preso_volta_pro_terminal(monkeypatch):
    monkeypatch.setattr(pb, "terminal_preso", lambda name: True)
    pb.app_entrou()
    assert asyncio.run(pb.ask(_corpo("perm:t1", tool="Bash"))) == {"soltar": True}


def test_resposta_do_app_chega_ao_hook_e_so_vale_com_o_aviso_dele(monkeypatch):
    monkeypatch.setattr(pb, "terminal_preso", lambda name: False)
    monkeypatch.setattr(pb, "CONFIRMA_S", 3.0)
    pb.app_entrou()
    resultado: dict = {}

    async def cena():
        espera = asyncio.create_task(pb.ask(_corpo("perm:t1", tool="Bash", resumo="echo ok")))
        while pb.pergunta_pendente("s1") is None:
            await asyncio.sleep(0.01)
        assert pb.pergunta_pendente("s1")["resumo"] == "echo ok"
        # A rota do app roda em thread do pool, nunca no loop.
        t = threading.Thread(
            target=lambda: resultado.update(ok=pb.responder_pergunta("s1", {"permitir": True})))
        t.start()
        recebido = await espera
        await pb.ask_fim(pb.AskFimBody(sessao="s1", token=pb.mint("s1"), id="perm:t1", vencedor="app"))
        await asyncio.to_thread(t.join)
        return recebido

    assert asyncio.run(cena()) == {"permitir": True}
    assert resultado["ok"] is True
    assert pb.pergunta_pendente("s1") is None


def test_portao_desligado_nao_poe_nada_na_sessao_e_ligado_poe_o_plugin(monkeypatch):
    # Desligado, a sessão nasce byte a byte como antes: sem flag, sem env. É a promessa do fallback.
    from app.adapters import get_adapter
    monkeypatch.setattr(pb, "ligado", lambda: False)
    assert pb.raizes_dos_plugins() == [] and pb.env_da_sessao("s1") == {}
    assert get_adapter("claude").spawn_command("/tmp/p", "sid") == ["claude", "--session-id", "sid"]

    monkeypatch.setattr(pb, "ligado", lambda: True)
    (raiz,) = pb.raizes_dos_plugins()
    assert Path(raiz).parts[-2:] == ("plugins", "hangar")
    assert get_adapter("claude").spawn_command("/tmp/p", "sid")[:5] == [
        "claude", "--session-id", "sid", "--plugin-dir", raiz]
    env = pb.env_da_sessao("s1")
    assert env["HANGAR_PLUGIN_TOKEN"] == pb.mint("s1") and env["HANGAR_PLUGIN_URL"].endswith("/api/plugin")


def test_resposta_sem_ninguem_segurando_nao_e_entrega():
    assert pb.responder_pergunta("s1", {"permitir": True}) is False


def test_resposta_repetida_de_pergunta_que_o_app_ja_fechou_conta_como_entregue():
    # Toque duplo no app: a segunda chega com a pergunta já fechada. Devolver False a mandaria de
    # novo pela tecla — a mesma resposta duas vezes.
    pb._fechadas["s1"] = ("toolu_1", "app")
    assert pb.responder_pergunta("s1", {"answers": {}}, "toolu_1") is True
    assert pb.responder_pergunta("s1", {"answers": {}}, "toolu_2") is False
    pb._fechadas["s1"] = ("toolu_1", "terminal")
    assert pb.responder_pergunta("s1", {"answers": {}}, "toolu_1") is False


def test_entrega_roda_sob_a_trava_de_envio_da_sessao(monkeypatch):
    # O Enter, a conferência e a limpeza tocam o mesmo composer do `send_prompt`.
    from app import terminal_input
    visto: dict = {}
    monkeypatch.setattr(pb, "_entregar",
                        lambda n, t, m: visto.update(travada=terminal_input._send_lock(n).locked()))
    pb.entregar("s1", "oi")
    assert visto["travada"] is True
    assert terminal_input._send_lock("s1").locked() is False
