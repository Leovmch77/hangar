"""Origem com terminal da transferência para o Codex saindo do pane (ordem: o pane morre antes do
sidecar, o que passa de um lado pro outro, a volta quando o sidecar não grava) e a recusa da troca
de modo, que é do Rust."""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.adapters.claude_headless import sessions as S
from app.adapters.claude_headless.adapter import ClaudeHeadlessAdapter
from app.config import settings

SID = "11111111-1111-1111-1111-111111111111"


def _tm(tmp_path):
    """O que a transferência gravou da origem; bate com o pane de `_pane`."""
    return {"session_id": SID, "cwd": str(tmp_path), "pane_pid": 999, "key": "k-t1", "transfer_id": "tr-1"}


@pytest.fixture
def reg(tmp_path, monkeypatch):
    from app import pqueue, registry as R
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    monkeypatch.setattr(S, "_trocando", {})
    monkeypatch.setattr(R.procinfo, "pid_vivo", lambda pid: False)
    monkeypatch.setattr(R.tmux, "has_session", lambda n: False)
    return R.SessionRegistry(str(tmp_path / "projects"))


@pytest.mark.parametrize("resume", [False, True])
def test_terminal_command_keeps_plugins_and_choices(monkeypatch, resume):
    import shlex
    from app import plugin_bridge, registry as R
    roots = ["/plugins/hangar", "/plugins/outro mod"]
    monkeypatch.setattr(plugin_bridge, "raizes_dos_plugins", lambda: roots)
    meta = {"session_id": SID, "cwd": "/projeto", "model": "haiku", "effort": "low",
            "permission_mode": "acceptEdits"}
    argv = shlex.split(R.SessionRegistry._comando_terminal(meta, resume=resume))
    assert argv[:3] == ["claude", "--resume" if resume else "--session-id", SID]
    assert [argv[i + 1] for i, value in enumerate(argv[:-1]) if value == "--plugin-dir"] == roots
    assert argv[argv.index("--model") + 1] == "haiku"
    assert argv[argv.index("--effort") + 1] == "low"
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"


def _pane(reg, tmp_path, monkeypatch, *, mata=True):
    from app import registry as R
    jsonl = str(tmp_path / "projects" / "x" / f"{SID}.jsonl")
    monkeypatch.setattr(reg, "_pane_of", lambda n: {"name": n, "cwd": str(tmp_path), "pid": 999})
    monkeypatch.setattr(R.SessionRegistry, "_refuse_non_claude_resume", staticmethod(lambda p, **_: False))
    monkeypatch.setattr(reg, "resolve_tracked", lambda n, c: (jsonl, True))
    monkeypatch.setattr(R, "_config_dir_of", lambda pid: tmp_path / ".claude-b")
    monkeypatch.setattr(R, "_engine_of", lambda pid: None)
    monkeypatch.setattr(R.procinfo, "_model_of", lambda pid: ("sonnet", "high"))
    monkeypatch.setattr(R.procinfo, "_env_var_of",
                        lambda pid, n: "haiku" if n == "CLAUDE_CODE_SUBAGENT_MODEL" else None)
    monkeypatch.setattr(R, "_descendant_pids", lambda pid: [999, 1000])
    monkeypatch.setattr(R, "agente_do_pane", lambda pid, children=None: ("claude", 999))
    monkeypatch.setattr(R, "_escolhas_status", lambda sid: (None, None))
    mortos = []

    def kill(n):
        mortos.append((n, S.exists(n)))
        return mata
    monkeypatch.setattr(R.tmux, "kill_session", kill)
    return mortos


def test_pane_vira_sem_terminal_com_sid_vivo_conta_e_modo(reg, tmp_path, monkeypatch):
    mortos = _pane(reg, tmp_path, monkeypatch)
    meta = reg.para_headless("t1", "plan", transfer_meta=_tm(tmp_path))
    assert mortos == [("t1", False)]                 # pane morre antes do sidecar existir
    assert meta["session_id"] == SID and S.load("t1")["session_id"] == SID
    assert meta["config_dir"] == str(tmp_path / ".claude-b")
    assert (meta["model"], meta["effort"], meta["permission_mode"]) == ("sonnet", "high", "plan")
    assert meta["subagent_model"] == "haiku"


@pytest.mark.parametrize("tier", ["default", "priority"])
@pytest.mark.parametrize("rollback", [False, True])
@pytest.mark.parametrize("fixed_account", [False, True])
@pytest.mark.parametrize("live_model", ["gpt-6.1-sol", None])
def test_engine_tier_survives_transport_and_rollback(reg, tmp_path, monkeypatch, tier, rollback, fixed_account, live_model):
    from app import registry as R, engines, cliproxy, cliproxy_accounts
    stopped = _pane(reg, tmp_path, monkeypatch)
    monkeypatch.setattr(engines, "caminho", lambda: tmp_path / "engines.json")
    engines.salvar("proxy", {"base_url": "http://127.0.0.1:8317", "api_key": "test", "model": "gpt-5.5"})
    monkeypatch.setattr(R, "_engine_of", lambda pid: "proxy")
    monkeypatch.setattr(R.procinfo, "_model_of", lambda pid: ("gpt-5.5", "high"))
    monkeypatch.setattr(R, "_escolhas_status", lambda sid: (live_model, "high"))
    monkeypatch.delenv("CLAUDE_CODE_EXTRA_BODY", raising=False)
    historical = tmp_path / "projects" / "x" / f"{SID}.jsonl"
    historical.parent.mkdir(parents=True, exist_ok=True)
    historical.write_text('{"type":"assistant","message":{"model":"gpt-4","usage":{"input_tokens":100}}}', encoding="utf-8")
    monkeypatch.setattr(cliproxy, "supports_fast", lambda *a: True)
    monkeypatch.setattr(R, "_exigir_cp_engine", lambda: None)
    account = {"account": "default", "prefix": "fixed", "credential_id": "codex:/tmp/codex",
               "home": "/tmp/codex", "base_url": "http://127.0.0.1:8317"}
    monkeypatch.setattr(cliproxy, "account_for_engine", lambda *a, **k: account)
    monkeypatch.setattr(cliproxy_accounts, "resolve", lambda *a, **k: account)
    monkeypatch.setattr("app.engine_probe.listar_modelos", lambda *a: [{"id": "fixed/gpt-5.5"}, {"id": "fixed/gpt-6.1-sol"}])
    markers = {"CP_ENGINE_SERVICE_TIER": tier}
    if fixed_account:
        markers.update(CP_ENGINE_ACCOUNT="default", CP_ENGINE_CREDENTIAL_ID="codex:/tmp/codex",
                       CP_ENGINE_ACCOUNT_BASE_URL="http://127.0.0.1:8317")
    expected_model = ("fixed/" if fixed_account else "") + (live_model or "gpt-5.5")
    def read(pid, name):
        assert not stopped
        return markers.get(name)
    monkeypatch.setattr(R.procinfo, "_env_var_of", read)
    commands = []
    monkeypatch.setattr(R.tmux, "new_session", lambda name, cwd, cmd, *a, **k: commands.append(cmd) or True)
    if rollback:
        monkeypatch.setattr(S, "save", MagicMock(side_effect=OSError("sidecar indisponível")))
        monkeypatch.setattr("app.terminal_input._wait_input_ready", lambda name, timeout=None: True)
        with pytest.raises(OSError, match="sidecar indisponível"):
            reg.para_headless("t1", "acceptEdits", transfer_meta=_tm(tmp_path))
    else:
        meta = reg.para_headless("t1", "acceptEdits", transfer_meta=_tm(tmp_path))
        assert meta["service_tier"] == tier and S.load("t1")["service_tier"] == tier
        assert meta["model"] == expected_model and S.load("t1")["model"] == expected_model
        # A volta ao terminal é do Rust; o comando que ela montaria sai do sidecar gravado.
        commands.append(R.SessionRegistry._comando_terminal(S.load("t1"), resume=True))
    assert stopped == [("t1", False)]
    assert f"--service-tier {tier} -- claude" in commands[0]
    assert f"--model {expected_model}" in commands[0] and "--model gpt-4" not in commands[0]
    if live_model is not None:
        assert "--model gpt-5.5" not in commands[0]
    if fixed_account:
        assert "--account default --account-home /tmp/codex" in commands[0]


@pytest.mark.parametrize("removed", [False, True])
def test_transport_incompatible_priority_refuses_before_kill_or_clears_fallback(reg, tmp_path, monkeypatch, removed):
    from app import registry as R, engines, cliproxy
    stopped = _pane(reg, tmp_path, monkeypatch)
    monkeypatch.setattr(engines, "caminho", lambda: tmp_path / "engines.json")
    engines.salvar("proxy", {"base_url": "http://127.0.0.1:8317", "api_key": "test", "model": "gpt-5.5"})
    monkeypatch.setattr(R, "_engine_of", lambda pid: "removed" if removed else "proxy")
    monkeypatch.setattr(R.procinfo, "_env_var_of", lambda pid, name: "priority" if name == "CP_ENGINE_SERVICE_TIER" else None)
    monkeypatch.setattr(cliproxy, "supports_fast", lambda *a: False)
    if removed:
        meta = reg.para_headless("t1", "acceptEdits", transfer_meta=_tm(tmp_path))
        assert "service_tier" not in meta and meta["engine"] is None
    else:
        with pytest.raises(ValueError, match="service_tier"):
            reg.para_headless("t1", "acceptEdits", transfer_meta=_tm(tmp_path))
        assert not stopped and not S.exists("t1")


def test_pane_aberto_no_shell_le_conta_e_escolhas_do_claude_filho(reg, tmp_path, monkeypatch):
    # Sessão aberta no terminal: o pid do pane é o fish, e só o `claude` filho tem a conta e o modelo.
    from app import registry as R
    _pane(reg, tmp_path, monkeypatch)
    so_filho = lambda valor: (lambda pid, *a: valor if pid == 1000 else None)
    monkeypatch.setattr(R, "agente_do_pane", lambda pid, children=None: ("claude", 1000))
    monkeypatch.setattr(R, "_config_dir_of", so_filho(tmp_path / ".claude-b"))
    monkeypatch.setattr(R.procinfo, "_model_of", lambda pid: ("sonnet", "high") if pid == 1000 else (None, None))
    monkeypatch.setattr(R.procinfo, "_env_var_of",
                        lambda pid, key: "haiku" if pid == 1000 and key == "CLAUDE_CODE_SUBAGENT_MODEL" else None)
    meta = reg.para_headless("t1", "plan", transfer_meta=_tm(tmp_path))
    assert meta["config_dir"] == str(tmp_path / ".claude-b")
    assert (meta["model"], meta["effort"], meta["subagent_model"]) == ("sonnet", "high", "haiku")


def test_pane_leva_o_modelo_em_uso_nao_o_do_boot(reg, tmp_path, monkeypatch):
    # Aberta sem --model (ou trocada por /model na TUI): quem sabe o modelo em uso é a statusline.
    from app import registry as R
    _pane(reg, tmp_path, monkeypatch)
    monkeypatch.setattr(R.procinfo, "_model_of", lambda pid: (None, None))
    monkeypatch.setattr(R, "_escolhas_status", lambda sid: ("claude-opus-5[1m]", "high"))
    meta = reg.para_headless("t1", "plan", transfer_meta=_tm(tmp_path))
    assert (meta["model"], meta["effort"]) == ("claude-opus-5[1m]", "high")


def test_esforco_que_nao_existe_na_abertura_nao_trava_a_troca(reg, tmp_path, monkeypatch):
    # `ultracode` só existe no /effort em voo; a flag --effort recusa e a troca dava 409.
    from app import registry as R
    _pane(reg, tmp_path, monkeypatch)
    monkeypatch.setattr(R, "_escolhas_status", lambda sid: ("claude-opus-5[1m]", "ultracode"))
    meta = reg.para_headless("t1", "plan", transfer_meta=_tm(tmp_path))
    assert (meta["model"], meta["effort"]) == ("claude-opus-5[1m]", "high")


def test_pane_que_nao_morre_nao_vira_sem_terminal(reg, tmp_path, monkeypatch):
    from app.registry import KillFailed
    _pane(reg, tmp_path, monkeypatch, mata=False)
    with pytest.raises(KillFailed):
        reg.para_headless("t1", "manual", transfer_meta=_tm(tmp_path))
    assert not S.exists("t1")


def test_monitor_sem_terminal_nao_diz_dead_durante_a_troca(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    monkeypatch.setattr(S, "_trocando", {})
    S.marcar_troca("hl")
    ad = ClaudeHeadlessAdapter()

    async def fluxo():
        gen = ad.state_monitor("hl", lambda: None)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(gen.__anext__(), 1.5)
        S._trocando.clear()
        gen = ad.state_monitor("hl", lambda: None)
        assert (await gen.__anext__()).state == "dead"
    asyncio.run(fluxo())


@pytest.fixture
def cliente(monkeypatch):
    import app.api as api_mod
    settings.auth_token = "secret"
    monkeypatch.setattr(api_mod, "_session_exists", lambda name: True)
    return TestClient(api_mod.app)


_H = {"Authorization": "Bearer secret"}


@pytest.mark.parametrize("provider", ["claude", "codex", "pi"])
def test_mode_switch_is_rust_only(cliente, provider):
    from app.models import SessionInfo
    info = SessionInfo(name="s1", cwd="/tmp", provider=provider)
    with patch("app.api._cached_info", AsyncMock(return_value=info)):
        r = cliente.post("/api/sessions/s1/modo-execucao", headers=_H, json={"terminal": True})
    if provider == "pi":
        assert r.status_code == 409 and r.json()["detail"]["code"] == "erro_modo_so_claude"
    else:
        assert r.status_code == 503 and r.json()["detail"]["code"] == "session_open_needs_rust_server"

