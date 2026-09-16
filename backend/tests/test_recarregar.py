"""Recarregar uma sessão Claude sem terminal: motivo no `state`, reciclagem do processo e rota."""
import asyncio
import os
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


def _sessao(conta, subiu: float | None):
    meta = {"name": "s1", "cwd": "/tmp", "session_id": "x", "config_dir": str(conta),
            "cano": {"pid": 4242, "ts": subiu} if subiu else None}
    return _Sessao("s1", meta)


def test_motivo_config_quando_a_conta_mudou_depois_do_processo(conta):
    ad = ClaudeHeadlessAdapter()
    agora = time.time()
    os.utime(conta / ".claude.json", (agora - 100, agora - 100))
    assert ad.motivo_recarga(_sessao(conta, agora - 50)) is None       # processo é mais novo
    assert ad.motivo_recarga(_sessao(conta, agora - 200)) == "config"  # config mudou depois
    assert ad.motivo_recarga(_sessao(conta, None)) is None             # cano sem carimbo


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
