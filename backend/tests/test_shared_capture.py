"""Quadro de pane compartilhado entre estado e prévia, e /api/sessions servido do refresher."""
import asyncio
import threading
import time
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import sse, state
from app.config import settings
from app.models import SessionInfo


def _fake_capture(calls, text="● oi\n", delay=0.05):
    def capture(name):
        calls.append(name)
        time.sleep(delay)
        return text
    return capture


def test_concurrent_consumers_share_one_capture(monkeypatch):
    calls = []
    monkeypatch.setattr(state.tmux, "capture_pane", _fake_capture(calls))

    async def run():
        return await asyncio.gather(state.shared_capture("s", 0.5), state.shared_capture("s", 0.1))

    assert asyncio.run(run()) == ["● oi\n", "● oi\n"]
    assert calls == ["s"]


def test_fresh_frame_reused_stale_recaptured(monkeypatch):
    calls = []
    monkeypatch.setattr(state.tmux, "capture_pane", _fake_capture(calls, delay=0))

    async def run():
        await state.shared_capture("s", 0.5)
        await state.shared_capture("s", 0.5)      # dentro da idade: reusa
        assert len(calls) == 1
        await asyncio.sleep(0.05)
        await state.shared_capture("s", 0.01)     # quem pede quadro mais novo captura
        assert len(calls) == 2

    asyncio.run(run())


def test_empty_frame_is_not_shared(monkeypatch):
    # Pane vazio leva o monitor ao has-session; reaproveitar "" esconderia a sessão voltando.
    calls = []
    monkeypatch.setattr(state.tmux, "capture_pane", _fake_capture(calls, text="", delay=0))

    async def run():
        await state.shared_capture("s", 0.5)
        await state.shared_capture("s", 0.5)

    asyncio.run(run())
    assert len(calls) == 2


def test_capture_runs_on_tmux_pool(monkeypatch):
    threads = []

    def capture(name):
        threads.append(threading.current_thread().name)
        return "x"

    monkeypatch.setattr(state.tmux, "capture_pane", capture)
    asyncio.run(state.shared_capture("s", 0))
    assert threads[0].startswith("hangar-tmux")


def _client(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "secret")
    from app.api import app
    return TestClient(app), {"Authorization": "Bearer secret"}


def test_sessions_route_serves_recent_refresher_list(monkeypatch):
    client, h = _client(monkeypatch)
    sse._list_refresher.latest = (time.monotonic(), [SessionInfo(name="viva", cwd="/p", state="working")])
    with patch("app.api.registry.list_with_state", side_effect=AssertionError("recalculou")):
        r = client.get("/api/sessions", headers=h)
    assert r.status_code == 200
    assert [(s["name"], s["state"]) for s in r.json()] == [("viva", "working")]


def test_sessions_route_recomputes_when_refresher_is_stale(monkeypatch):
    client, h = _client(monkeypatch)
    sse._list_refresher.latest = (time.monotonic() - 10, [SessionInfo(name="velha", cwd="/p")])
    with patch("app.api.registry.list", return_value=[SessionInfo(name="nova", cwd="/p")]):
        r = client.get("/api/sessions", headers=h)
    assert [s["name"] for s in r.json()] == ["nova"]
