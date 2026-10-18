"""Modelo dos subagentes escolhido na abertura: vira CLAUDE_CODE_SUBAGENT_MODEL do processo."""
from unittest.mock import MagicMock


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


# Claude com terminal nasce no Rust; o pane aqui é o da retomada do Arquivo.
_ARCHIVE_SID = "11111111-1111-1111-1111-111111111111"


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
