import asyncio

import pytest

from app import runtime_policy


def test_policy_failure_is_visible_and_redacted(monkeypatch):
    from app import diag
    records = []
    monkeypatch.setattr(diag, "registrar", lambda *args, **kwargs: records.append((args, kwargs)))
    async def scenario():
        result = await runtime_policy.execute("unsupported", {"text":"private-input", "token":"private-secret"}, {"provider":"claude"})
        assert result["ok"] is False
        assert result["error_type"] == "ValueError"
    asyncio.run(scenario())
    assert "private-input" not in repr(records)
    assert "private-secret" not in repr(records)


@pytest.mark.parametrize("kind", ["prepare_prompt", "format_status", "skill_catalog", "answer_body", "quota",
                                  "session.marker", "diag.error", "last_usage", "reload_stamp", "unknown_private",
                                  "launch_env", "native_message"])
def test_services_that_moved_to_rust_are_gone(kind):
    # O ator Rust roda estes por conta própria; o Python não responde mais.
    for provider in ("claude", "codex"):
        with pytest.raises(ValueError):
            runtime_policy.run(kind, {"text": "Olá", "catalog": {}, "questions": [], "answers": []}, {"provider": provider})


@pytest.mark.parametrize("kind", ["terminal_facts", "terminal_publish", "terminal_plugin_control"])
def test_python_terminal_reserve_still_reaches_its_services(monkeypatch, kind):
    # A reserva do terminal no modo `python` (`runtime_terminal._service`) ainda passa por aqui.
    from app import runtime_terminal
    for attr in ("facts", "publish", "plugin_control"):
        monkeypatch.setattr(runtime_terminal, attr, lambda payload, metadata, attr=attr: attr)
    assert runtime_policy.run(kind, {}, {"provider": "claude", "terminal": {"pane": "%1"}}) == kind.removeprefix("terminal_")


@pytest.mark.parametrize("provider,module", [("claude", "claude_headless"), ("codex", "codex")])
@pytest.mark.parametrize("kind,payload", [("session.patch_meta", {"model": "m"}), ("session.patch_meta", {"cano": {"pid": 5}}),
                                          ("session.clear_cano", {"pid": 5})])
def test_sidecars_are_written_only_by_rust(monkeypatch, provider, module, kind, payload):
    # Sidecar e cano são do Rust (`claude_sidecar.rs`, `codex_sidecar.rs`): o Python recusa sem ler nem gravar.
    import importlib
    sessions = importlib.import_module(f"app.adapters.{module}.sessions")
    for attr in ("load", "update"):
        monkeypatch.setattr(sessions, attr, lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("sidecar tocado")))
    with pytest.raises(ValueError):
        runtime_policy.run(kind, payload, {"provider": provider, "name": "s", "key": "k", "validate": lambda: None})
