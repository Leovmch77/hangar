"""Criar/retomar sessão com motor.

O motor é aplicado prefixando o comando com `hangar-engine --exec`, não com `tmux -e`: assim a key não
aparece em /proc/<pid>/cmdline (legível por qualquer usuário) e o tmux.py não muda.
E o motor tem que sobreviver aos DOIS resumes — senão uma sessão Kimi ressuscita na conta Anthropic
continuando um transcript de Kimi, calado.
"""
import asyncio
import os

import pytest

from app import engines as eng
from app import procinfo
from app import registry as reg


# Capturado no IMPORT, antes de qualquer fixture: o `_isola` abaixo troca `reg._exigir_cp_engine`
# por um no-op, entao la dentro nao ha mais como alcancar a funcao de verdade.
_EXIGIR_ORIGINAL = reg._exigir_cp_engine


@pytest.fixture(autouse=True)
def _isola(tmp_path, monkeypatch):
    monkeypatch.setattr(eng, "caminho", lambda: tmp_path / "engines.json")
    # A guarda que recusa quando o `hangar-engine` nao esta no PATH e sobre o AMBIENTE do servidor, nao
    # sobre a montagem do comando, que e o assunto deste arquivo. Sem desliga-la aqui, todos estes
    # casos passariam a depender de o lancador estar instalado na maquina que roda a suite — verde
    # no Linux (onde o install-claude-wrapper.sh o poe no PATH) e vermelho no Windows, pelo
    # ambiente e nao pelo codigo. A guarda tem teste proprio, logo abaixo.
    monkeypatch.setattr(reg, "_exigir_cp_engine", lambda: None)
    yield


def test_recusa_alto_quando_o_cp_engine_nao_esta_no_path(monkeypatch):
    """A guarda em si — o unico caso que NAO desliga o `_exigir_cp_engine`.

    Sem ela o pane nasce rodando um comando que nao existe, morre no ato, e o `tmux new-session`
    devolve 0 assim mesmo (medido no psmux: rc=0 e, 3s depois, `has-session` ja responde 1). O app
    entao reporta "sessao criada" pra uma sessao que evaporou.
    """
    monkeypatch.setattr(reg.shutil, "which", lambda nome: None)
    with pytest.raises(ValueError, match="hangar-engine"):
        _EXIGIR_ORIGINAL()

    monkeypatch.setattr(reg.shutil, "which", lambda nome: "/qualquer/hangar-engine")
    _EXIGIR_ORIGINAL()           # com o lancador no PATH, passa calado


def _motor():
    eng.salvar("kimi", {"base_url": "https://api.kimi.com/coding",
                        "api_key": "sk-kimi-1234", "model": "k3"})


def _reg(tmp_path, monkeypatch, visto):
    def _fake_new(name, cwd, command, config_dir=None, *, provider="claude", env=None):
        visto["command"] = command
        return True

    monkeypatch.setattr(reg.tmux, "new_session", _fake_new)
    monkeypatch.setattr(reg.tmux, "has_session", lambda n: False)
    monkeypatch.setattr(reg, "_pretrust_cwd", lambda cwd, cfg: None)
    return reg.SessionRegistry(projects_dir=tmp_path)


def _fixed_proxy(monkeypatch):
    from app import cliproxy, cliproxy_accounts
    account = {"account": "default", "prefix": "fixed", "credential_id": "codex:/tmp/codex",
               "home": "/tmp/codex", "base_url": "http://127.0.0.1:8317"}
    monkeypatch.setattr(cliproxy, "account_for_engine", lambda cfg, name, home=None: account)
    monkeypatch.setattr(cliproxy_accounts, "resolve", lambda name, home=None: account)
    monkeypatch.setattr("app.engine_probe.listar_modelos", lambda *a: [{"id": "fixed/gpt-5.5"}])
    eng.salvar("proxy", {"base_url": "http://127.0.0.1:8317", "api_key": "test", "model": "gpt-5.5"})


@pytest.mark.parametrize("tier", ["default", "priority"])
def test_rebuild_incompatible_service_tier(tmp_path, monkeypatch, tier):
    from app import cliproxy
    _motor()
    monkeypatch.setattr(cliproxy, "supports_fast", lambda *a: False)
    meta = {"session_id": "11111111-1111-1111-1111-111111111111", "engine": "kimi", "model": "k3", "service_tier": tier}
    if tier == "priority":
        with pytest.raises(ValueError, match="service_tier"):
            reg.SessionRegistry._comando_terminal(meta, resume=True)
    else:
        assert "--service-tier" not in reg.SessionRegistry._comando_terminal(meta, resume=True)


def test_proxy_init_response_does_not_replace_fixed_route(tmp_path, monkeypatch):
    from app.adapters.claude_headless.adapter import ClaudeHeadlessAdapter, _Sessao
    from app.adapters.claude_headless import sessions
    monkeypatch.setattr(sessions, "_dir", lambda: tmp_path / "hl")
    meta = sessions.save("fixed", str(tmp_path), "11111111-1111-1111-1111-111111111111",
                         engine="proxy", engine_account="default", model="fixed/gpt-5.5")
    session = _Sessao("fixed", meta)
    asyncio.run(ClaudeHeadlessAdapter()._on_system(session, {"subtype": "init", "model": "gpt-5.5"}))
    assert session.model == "fixed/gpt-5.5"
    assert sessions.load("fixed")["engine_account"] == "default"


_ARCHIVE_SID = "11111111-2222-3333-4444-555555555555"


@pytest.mark.skipif(os.name != "posix",
                    reason="exercita o ramo /proc do _engine_of contra um /proc de mentira; no "
                           "Windows o despacho vai pro psutil e nao ha o que este caso testa")
def test_engine_of_le_o_cp_engine_do_proc(tmp_path, monkeypatch):
    # Mesmo truque do _config_dir_of: o env do processo VIVO é o registro autoritativo — um sidecar
    # em disco pode divergir do que está de fato rodando no pane.
    environ = tmp_path / "environ"
    environ.write_bytes(b"PATH=/usr/bin\x00CP_ENGINE=kimi\x00HOME=/home/x\x00")
    monkeypatch.setattr(procinfo, "_proc_environ_path", lambda pid: str(environ))
    assert reg._engine_of(1234) == "kimi"


def test_engine_of_sem_a_marca_e_none(tmp_path, monkeypatch):
    environ = tmp_path / "environ"
    environ.write_bytes(b"PATH=/usr/bin\x00")
    monkeypatch.setattr(procinfo, "_proc_environ_path", lambda pid: str(environ))
    assert reg._engine_of(1234) is None


def _prep_resume(tmp_path, monkeypatch, visto, motor):
    sid = "11111111-2222-3333-4444-555555555555"
    proj = tmp_path / "projects" / "-tmp"
    proj.mkdir(parents=True)
    (proj / f"{sid}.jsonl").write_text("", encoding="utf-8")

    def _fake_new(name, cwd, command, config_dir=None, *, provider="claude", env=None):
        visto["command"] = command
        visto["config_dir"] = config_dir
        return True

    monkeypatch.setattr(reg, "_engine_of", lambda pid: motor)
    monkeypatch.setattr(reg, "_config_dir_of", lambda pid: None)
    monkeypatch.setattr(reg, "sanitize_cwd", lambda cwd: "-tmp")
    monkeypatch.setattr(reg.tmux, "kill_session", lambda n: None)
    monkeypatch.setattr(reg.tmux, "new_session", _fake_new)
    # O cache é da classe: sem zerar, o "s" de um teste anterior sobrevive até aqui.
    monkeypatch.setattr(reg.SessionRegistry, "_jsonl_cache", {})
    r = reg.SessionRegistry(projects_dir=tmp_path / "projects")
    monkeypatch.setattr(r, "_pane_of", lambda name: {"cwd": "/tmp", "pid": 4242})
    monkeypatch.setattr(r, "_forget", lambda name: None)
    # Sem isto a busca do `claude` dentro do pane leria o /proc real, onde o pid 4242 pode existir.
    monkeypatch.setattr(reg, "agente_do_pane", lambda pid, children=None: ("claude", None))
    return r, sid


# ── Task 3: escolha de modelo/janela entra no prefixo hangar-engine ────────────────────────────────

