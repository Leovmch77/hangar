"""Marcador idle velho na lista: transcript escrito depois dele manda a decisão para o pane."""
import os

import pytest

from app import registry
from app.registry import SessionInfo

pytestmark = pytest.mark.asyncio

_SID = "4b6b4507-7fb7-4cdc-9e7b-5794e3b07009"


def _sessao(tmp_path, mtime: float) -> SessionInfo:
    jsonl = tmp_path / f"{_SID}.jsonl"
    jsonl.write_text("{}\n")
    os.utime(jsonl, (mtime, mtime))
    return SessionInfo(name="cc", cwd="/p", jsonl=str(jsonl), tracked=True, provider="claude")


async def _estado(tmp_path, monkeypatch, mtime: float, frames: list[str]) -> str:
    reg = registry.SessionRegistry(projects_dir=tmp_path)
    info = _sessao(tmp_path, mtime)
    monkeypatch.setattr(reg, "list", lambda: [info])
    monkeypatch.setattr(registry.hook_state, "get_state", lambda sid: ("idle", 1000.0) if sid == _SID else None)
    quadros = iter(frames)
    monkeypatch.setattr(registry.tmux, "capture_pane", lambda *a, **k: next(quadros))
    out = {s.name: s for s in await reg.list_with_state([info])}
    return out["cc"].state


async def test_idle_com_transcript_novo_e_spinner_animando_vira_working(tmp_path, monkeypatch):
    frames = ["✽ Whirring… (1m 20s · thinking)\n", "✶ Whirring… (1m 21s · thinking)\n"] + ["❯ \n"] * 4
    assert await _estado(tmp_path, monkeypatch, 1010.0, frames) == "working"


async def test_idle_com_transcript_novo_e_pane_parado_segue_idle(tmp_path, monkeypatch):
    frames = ["✻ Worked for 8s\n"] * 6
    assert await _estado(tmp_path, monkeypatch, 1010.0, frames) == "idle"


async def test_idle_com_transcript_da_folga_pos_stop_nao_raspa_o_pane(tmp_path, monkeypatch):
    def proibido(*a, **k):
        pytest.fail("raspou o pane de sessão parada")
    reg = registry.SessionRegistry(projects_dir=tmp_path)
    info = _sessao(tmp_path, 1000.5)
    monkeypatch.setattr(reg, "list", lambda: [info])
    monkeypatch.setattr(registry.hook_state, "get_state", lambda sid: ("idle", 1000.0))
    monkeypatch.setattr(registry.tmux, "capture_pane", proibido)
    out = {s.name: s for s in await reg.list_with_state([info])}
    assert out["cc"].state == "idle"
