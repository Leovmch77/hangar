"""Modelo dos subagentes escolhido na abertura: vira CLAUDE_CODE_SUBAGENT_MODEL do processo."""
from unittest.mock import MagicMock, patch

import pytest

from app import registry as reg
from app import tmux
from app.adapters.claude_headless import sessions as S


def _reg(tmp_path, monkeypatch, visto):
    def _fake_new(name, cwd, command, config_dir=None, *, provider="claude", env=None):
        visto["env"] = env
        return True

    monkeypatch.setattr(reg.tmux, "new_session", _fake_new)
    monkeypatch.setattr(reg.tmux, "has_session", lambda n: False)
    monkeypatch.setattr(reg, "_pretrust_cwd", lambda cwd, cfg: None)
    return reg.SessionRegistry(projects_dir=tmp_path)


def test_create_no_terminal_exporta_a_variavel_no_pane(tmp_path, monkeypatch):
    visto = {}
    _reg(tmp_path, monkeypatch, visto).create("s", str(tmp_path), subagent_model="claude-opus-5")
    assert visto["env"]["CLAUDE_CODE_SUBAGENT_MODEL"] == "claude-opus-5"


def test_create_sem_escolha_nao_exporta_nada(tmp_path, monkeypatch):
    visto = {}
    _reg(tmp_path, monkeypatch, visto).create("s", str(tmp_path))
    assert "CLAUDE_CODE_SUBAGENT_MODEL" not in visto["env"]


@pytest.mark.parametrize("kw", [{"provider": "pi"}, {"engine": "kimi"}])
def test_create_recusa_fora_do_claude_sem_motor(tmp_path, monkeypatch, kw):
    with pytest.raises(ValueError, match="subagentes"):
        _reg(tmp_path, monkeypatch, {}).create("s", str(tmp_path), subagent_model="opus", **kw)


def test_create_recusa_valor_que_vira_flag(tmp_path, monkeypatch):
    with pytest.raises(ValueError):
        _reg(tmp_path, monkeypatch, {}).create("s", str(tmp_path), subagent_model="--dangerously")


def test_sem_terminal_grava_no_sidecar(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    meta = S.save("s", str(tmp_path), "11111111-1111-1111-1111-111111111111", subagent_model="opus")
    assert S.load("s")["subagent_model"] == "opus" == meta["subagent_model"]


def test_new_session_passa_o_env_como_e(monkeypatch):
    rodou = {}
    # A sonda de `systemd-run` também passa pelo `_run`: guardar a PRIMEIRA chamada pegaria ela
    # numa máquina sem systemd e o teste falharia só ali.
    def _fake_run(args):
        if "new-session" in args:
            rodou["args"] = args
        return MagicMock(returncode=1)

    monkeypatch.setattr(tmux, "_run", _fake_run)
    tmux.new_session("s", "/tmp", "claude", env={"CLAUDE_CODE_SUBAGENT_MODEL": "opus"})
    args = rodou["args"]
    assert args[args.index("CLAUDE_CODE_SUBAGENT_MODEL=opus") - 1] == "-e"


def test_api_recusa_fora_do_claude(monkeypatch):
    from fastapi.testclient import TestClient
    from app.api import app
    from app.config import settings
    monkeypatch.setattr(settings, "auth_token", "secret")
    with patch("app.api.registry.create") as cr:
        r = TestClient(app).post("/api/sessions", headers={"Authorization": "Bearer secret"}, json={
            "name": "s", "cwd": "/tmp", "provider": "pi", "subagent_model": "opus"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "erro_subagente_so_claude"
    cr.assert_not_called()
