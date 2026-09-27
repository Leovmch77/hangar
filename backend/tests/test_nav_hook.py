"""nav_hook: a dica genérica do navegador não entra em sessão sem terminal; a URL aberta entra."""
import importlib.util
import json
import os
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "hooks" / "nav_hook.py"


def carregar():
    spec = importlib.util.spec_from_file_location("nav_hook", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def preparar(tmp_path, monkeypatch, headless: bool, url: str | None):
    monkeypatch.setenv("HOME", str(tmp_path))
    nav = tmp_path / ".hangar" / "nav"; nav.mkdir(parents=True)
    (nav / "_srv.json").write_text(json.dumps({"pid": os.getpid()}))
    if url:
        (nav / "s.json").write_text(json.dumps({"chave": "s", "url": url}))
    monkeypatch.delenv("TMUX_PANE", raising=False)
    if headless:
        pasta = tmp_path / ".hangar" / "claude-headless"; pasta.mkdir(parents=True)
        (pasta / "s.json").write_text(json.dumps({"key": "k1", "name": "s"}))
        monkeypatch.setenv("CP_SESSION_KEY", "k1")
    else:
        monkeypatch.delenv("CP_SESSION_KEY", raising=False)


def test_sem_terminal_sem_navegador_aberto_nao_diz_nada(tmp_path, monkeypatch, capsys):
    preparar(tmp_path, monkeypatch, headless=True, url=None)
    carregar().main()
    assert capsys.readouterr().out == ""


def test_sem_terminal_com_navegador_aberto_diz_a_url(tmp_path, monkeypatch, capsys):
    preparar(tmp_path, monkeypatch, headless=True, url="http://x")
    carregar().main()
    assert "http://x" in capsys.readouterr().out


def test_terminal_session_without_open_browser_keeps_generic_hint(tmp_path, monkeypatch, capsys):
    preparar(tmp_path, monkeypatch, headless=False, url=None)
    carregar().main()
    assert "hangar-preview open <url>" in capsys.readouterr().out
