"""Recarregar uma sessão Claude sem terminal: motivo no `state`, reciclagem do processo e rota."""
import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.adapters.claude_headless import adapter as A
from app.adapters.claude_headless import sessions as S
from app.adapters.claude_headless.adapter import ClaudeHeadlessAdapter, _Sessao
from app.config import settings


@pytest.fixture
def conta(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    raiz = tmp_path / "conta"
    raiz.mkdir()
    (raiz / ".claude.json").write_text("{}")
    return raiz


def _sessao(conta, marca: str | None):
    meta = {"name": "s1", "cwd": "/tmp", "session_id": "x", "config_dir": str(conta),
            "cano": {"pid": 4242, "ts": time.time(), "config_marca": marca} if marca else None}
    return _Sessao("s1", meta)


def test_motivo_config_so_quando_mcp_ou_settings_mudam(conta):
    ad = ClaudeHeadlessAdapter()
    (conta / ".claude.json").write_text(json.dumps({"mcpServers": {"a": {"url": "x"}}, "numStartups": 1}))
    marca = A._marca_config(str(conta))

    async def motivo(sess):
        # A leitura roda em segundo plano: a primeira chamada devolve o último valor conhecido e
        # dispara a renovação; o valor de verdade vem na chamada seguinte.
        ad.motivo_recarga(sess)
        await asyncio.gather(*ad._tarefas)
        return ad.motivo_recarga(sess)

    async def fluxo():
        assert await motivo(_sessao(conta, marca)) is None
        # O próprio Claude Code reescreve o resto do .claude.json a toda hora: isso não é motivo.
        (conta / ".claude.json").write_text(json.dumps({"mcpServers": {"a": {"url": "x"}}, "numStartups": 2}))
        assert await motivo(_sessao(conta, marca)) is None
        (conta / ".claude.json").write_text(json.dumps({"mcpServers": {"a": {"url": "y"}}, "numStartups": 2}))
        assert await motivo(_sessao(conta, marca)) == "config"
        (conta / ".claude.json").write_text(json.dumps({"mcpServers": {"a": {"url": "x"}}}))
        (conta / "settings.json").write_text('{"hooks": {}}')
        assert await motivo(_sessao(conta, marca)) == "config"
        assert await motivo(_sessao(conta, None)) is None   # processo de antes da marca
        # Config ilegível: "não li" não vira "mudou" — fica o último valor e o aviso vai pro log.
        (conta / "settings.json").write_bytes(b"\xff\xfe{")
        sess = _sessao(conta, marca)
        assert await motivo(sess) is None
    asyncio.run(fluxo())


def test_marca_ilegivel_levanta_e_ausente_conta_como_vazio(conta):
    (conta / ".claude.json").unlink()
    assert A._marca_config(str(conta)) == A._marca_config(str(conta))
    (conta / ".claude.json").write_text("{nao é json")
    with pytest.raises(ValueError):
        A._marca_config(str(conta))


def test_recarregar_encerra_e_acorda_na_mesma_sessao(conta):
    ad = ClaudeHeadlessAdapter()
    sess = _sessao(conta, time.time())
    sess.proc = MagicMock(returncode=None)
    ad._sessions["s1"] = sess
    ad._encerrar = AsyncMock()
    ad.acordar = MagicMock()
    with patch.object(A, "_esquecer_cano") as esq:
        asyncio.run(ad.recarregar("s1"))
    ad._encerrar.assert_awaited_once_with(sess)
    esq.assert_called_once_with("s1", 4242)
    ad.acordar.assert_called_once_with("s1")


def test_recarregar_sessao_parada_so_acorda(conta):
    ad = ClaudeHeadlessAdapter()
    ad._encerrar = AsyncMock()
    ad.acordar = MagicMock()
    asyncio.run(ad.recarregar("s1"))
    ad._encerrar.assert_not_awaited()
    ad.acordar.assert_called_once_with("s1")


@pytest.fixture
def cliente(monkeypatch):
    import app.api as api_mod
    settings.auth_token = "secret"
    monkeypatch.setattr(api_mod, "_session_exists", lambda name: True)
    return TestClient(api_mod.app)


_H = {"Authorization": "Bearer secret"}


def test_rota_com_terminal_relanca_o_pane_com_o_comando_de_hoje(cliente, tmp_path, monkeypatch):
    # O pane restaurado no boot nasceu sem o plugin: recarregar remonta o comando (plugin, nome,
    # token) pelo mesmo caminho da troca de modo, sem subir o processo sem terminal no meio.
    import app.api as api_mod
    from app.models import SessionInfo
    monkeypatch.setattr("app.pqueue.settings.projects_dir", tmp_path)
    info = SessionInfo(name="tt", cwd="/tmp", jsonl="/tmp/x.jsonl", tracked=True, provider="claude")
    hl = ClaudeHeadlessAdapter()
    hl.recarregar = AsyncMock()
    hl.ensure_running = AsyncMock()
    ordem = MagicMock()
    with patch("app.api._cached_info", AsyncMock(return_value=info)), \
         patch("app.api._headless", return_value=False), \
         patch("app.api.get_adapter", return_value=hl), \
         patch("app.api._motivo_ocupada", AsyncMock(return_value="erro_sessao_trabalhando")), \
         patch.object(api_mod.registry, "para_headless", ordem.para_headless), \
         patch.object(api_mod.registry, "para_terminal", ordem.para_terminal):
        r = cliente.post("/api/sessions/tt/recarregar", headers=_H)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "erro_sessao_trabalhando"
    assert ordem.mock_calls == []

    with patch("app.api._cached_info", AsyncMock(return_value=info)), \
         patch("app.api._headless", return_value=False), \
         patch("app.api.get_adapter", return_value=hl), \
         patch("app.api._motivo_ocupada", AsyncMock(return_value=None)), \
         patch("app.api.perm_mode.ler_modo", return_value="plan"), \
         patch("app.api._pane_came_up", return_value=True), \
         patch.object(api_mod.registry, "para_headless", ordem.para_headless), \
         patch.object(api_mod.registry, "para_terminal", ordem.para_terminal):
        r = cliente.post("/api/sessions/tt/recarregar", headers=_H)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert [c[0] for c in ordem.mock_calls] == ["para_headless", "para_terminal"]
    assert ordem.para_headless.call_args.args == ("tt", "plan")
    hl.ensure_running.assert_not_awaited()
    hl.recarregar.assert_not_awaited()


@pytest.mark.parametrize("falha", ["excecao", "pane_morreu"])
def test_rota_com_terminal_que_nao_reabre_segue_sem_terminal(cliente, tmp_path, monkeypatch, falha):
    # O processo antigo já saiu: qualquer falha da reabertura tem que deixar a sessão viva (sem
    # terminal) e dizer isso, nunca responder ok com a sessão sem processo.
    import app.api as api_mod
    from app.models import SessionInfo
    monkeypatch.setattr("app.pqueue.settings.projects_dir", tmp_path)
    info = SessionInfo(name="tt", cwd="/tmp", jsonl="/tmp/x.jsonl", tracked=True, provider="claude")
    hl = ClaudeHeadlessAdapter()
    hl.acordar = MagicMock()
    sidecar = {"name": "tt", "cwd": "/tmp", "session_id": "x"}
    reabrir = MagicMock(side_effect=RuntimeError("tmux caiu") if falha == "excecao" else None)
    with patch("app.api._cached_info", AsyncMock(return_value=info)), \
         patch("app.api._headless", return_value=False), \
         patch("app.api.get_adapter", return_value=hl), \
         patch("app.api._motivo_ocupada", AsyncMock(return_value=None)), \
         patch("app.api.perm_mode.ler_modo", return_value=None), \
         patch.object(api_mod.registry, "para_headless", return_value=sidecar), \
         patch.object(api_mod.registry, "para_terminal", reabrir), \
         patch("app.api._pane_came_up", return_value=False), \
         patch("app.api.headless_sessions.exists", return_value=False), \
         patch("app.api.headless_sessions.restaurar") as restaurar:
        r = cliente.post("/api/sessions/tt/recarregar", headers=_H)
    assert r.status_code == 502 and r.json()["detail"]["code"] == "erro_recarregar_sem_terminal"
    restaurar.assert_called_once_with(sidecar)
    hl.acordar.assert_called_once_with("tt")


def test_rota_recusa_ocupada_e_recicla_ociosa(cliente, tmp_path, monkeypatch):
    from app.models import SessionInfo
    monkeypatch.setattr("app.pqueue.settings.projects_dir", tmp_path)
    info = SessionInfo(name="hl", cwd="/tmp", jsonl="/tmp/x.jsonl", tracked=True, provider="claude", headless=True)
    hl = ClaudeHeadlessAdapter()
    hl.recarregar = AsyncMock()
    hl._sessions["hl"] = MagicMock(vivo=True, iniciando=False, pending={}, question=None, in_progress=True)
    with patch("app.api._cached_info", AsyncMock(return_value=info)), \
         patch("app.api._headless", return_value=True), \
         patch("app.api.get_adapter", return_value=hl):
        r = cliente.post("/api/sessions/hl/recarregar", headers=_H)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "erro_sessao_trabalhando"
    hl.recarregar.assert_not_awaited()

    hl._sessions["hl"].in_progress = False
    with patch("app.api._cached_info", AsyncMock(return_value=info)), \
         patch("app.api._headless", return_value=True), \
         patch("app.api.get_adapter", return_value=hl):
        r = cliente.post("/api/sessions/hl/recarregar", headers=_H)
    assert r.status_code == 200 and r.json() == {"ok": True}
    hl.recarregar.assert_awaited_once_with("hl")
