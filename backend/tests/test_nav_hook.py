"""nav_hook: com navegador aberto diz a página; fechado, a dica só vai em mensagem de tela (Jev
primeiro, regex sem ele), com ou sem terminal."""
import importlib.util
import io
import json
import os
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "hooks" / "nav_hook.py"


def carregar():
    spec = importlib.util.spec_from_file_location("nav_hook", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def preparar(tmp_path, monkeypatch, url: str | None, prompt: str = "", headless: bool = False):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    nav = tmp_path / ".hangar" / "nav"; nav.mkdir(parents=True)
    (nav / "_srv.json").write_text(json.dumps({"pid": os.getpid()}))
    if url:
        (nav / "s.json").write_text(json.dumps({"chave": "s", "url": url}))
    monkeypatch.delenv("TMUX_PANE", raising=False)
    monkeypatch.delenv("CP_SESSION_KEY", raising=False)
    if headless or url:
        pasta = tmp_path / ".hangar" / "claude-headless"; pasta.mkdir(parents=True)
        (pasta / "s.json").write_text(json.dumps({"key": "k1", "name": "s"}))
        monkeypatch.setenv("CP_SESSION_KEY", "k1")
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"prompt": prompt})))


def test_mensagem_que_nao_e_de_tela_nao_leva_dica(tmp_path, monkeypatch, capsys):
    preparar(tmp_path, monkeypatch, url=None, prompt="faz o commit e roda os testes do backend")
    carregar().main()
    assert capsys.readouterr().out == ""


def test_mensagem_de_tela_leva_dica_com_as_tools_do_mcp(tmp_path, monkeypatch, capsys):
    for headless in (False, True):
        preparar(tmp_path / str(headless), monkeypatch, url=None, headless=headless,
                 prompt="abre a página de login e vê se o botão aparece")
        carregar().main()
        ctx = json.loads(capsys.readouterr().out)["hookSpecificOutput"]["additionalContext"]
        assert "browser_open" in ctx and "Não use agent-browser" in ctx, headless


def test_navegador_aberto_sempre_diz_a_url(tmp_path, monkeypatch, capsys):
    preparar(tmp_path, monkeypatch, url="http://x", prompt="faz o commit")
    carregar().main()
    assert "http://x" in capsys.readouterr().out


def test_jev_decide_antes_da_regex_e_regex_vale_quando_ele_falha(monkeypatch):
    mod = carregar()
    monkeypatch.setattr(mod, "_jev_precisa", lambda p: False)
    assert mod.precisa_de_navegador("abre a página de login") is False
    monkeypatch.setattr(mod, "_jev_precisa", lambda p: True)
    assert mod.precisa_de_navegador("faz o commit") is True
    monkeypatch.setattr(mod, "_jev_precisa", lambda p: None)
    assert mod.precisa_de_navegador("abre a página de login") is True
    assert mod.precisa_de_navegador("faz o commit") is False
    assert mod.precisa_de_navegador("") is False


def test_regex_ignora_palavra_comum_de_codigo(monkeypatch):
    mod = carregar()
    monkeypatch.setattr(mod, "_jev_precisa", lambda p: None)
    assert mod.precisa_de_navegador("roda os testes do backend") is False
    assert mod.precisa_de_navegador("a interface do adapter mudou") is False
    assert mod.precisa_de_navegador("o teste do login quebrou") is False
    assert mod.precisa_de_navegador("testa o login") is True


def test_notificacao_de_subagente_nao_recebe_a_dica(tmp_path, monkeypatch, capsys):
    # Nem com o navegador aberto: ninguem escreveu a notificacao pedindo tela.
    preparar(tmp_path, monkeypatch, url="http://x",
             prompt="<task-notification>\n<summary>testa a tela do front</summary>")
    carregar().main()
    assert capsys.readouterr().out == ""
