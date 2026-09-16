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
    assert ad.motivo_recarga(_sessao(conta, marca)) is None
    # O próprio Claude Code reescreve o resto do .claude.json a toda hora: isso não é motivo.
    (conta / ".claude.json").write_text(json.dumps({"mcpServers": {"a": {"url": "x"}}, "numStartups": 2}))
    assert ad.motivo_recarga(_sessao(conta, marca)) is None
    (conta / ".claude.json").write_text(json.dumps({"mcpServers": {"a": {"url": "y"}}, "numStartups": 2}))
    assert ad.motivo_recarga(_sessao(conta, marca)) == "config"
    (conta / ".claude.json").write_text(json.dumps({"mcpServers": {"a": {"url": "x"}}}))
    (conta / "settings.json").write_text('{"hooks": {}}')
    assert ad.motivo_recarga(_sessao(conta, marca)) == "config"
    assert ad.motivo_recarga(_sessao(conta, None)) is None   # processo de antes da marca


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


def test_rota_recusa_com_terminal_e_ocupada_e_recicla_ociosa(cliente, tmp_path, monkeypatch):
    from app.models import SessionInfo
    monkeypatch.setattr("app.pqueue.settings.projects_dir", tmp_path)
    info = SessionInfo(name="hl", cwd="/tmp", jsonl="/tmp/x.jsonl", tracked=True, provider="claude", headless=True)
    hl = ClaudeHeadlessAdapter()
    hl.recarregar = AsyncMock()
    with patch("app.api._cached_info", AsyncMock(return_value=info)), \
         patch("app.api._headless", return_value=False), \
         patch("app.api.get_adapter", return_value=hl):
        r = cliente.post("/api/sessions/hl/recarregar", headers=_H)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "erro_recarregar_so_sem_terminal"

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
