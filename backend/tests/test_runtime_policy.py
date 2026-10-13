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


def test_metadata_patch_has_a_strict_catalog(monkeypatch):
    from app.adapters.claude_headless import sessions
    monkeypatch.setattr(sessions, "update", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("escrita indevida")))
    with pytest.raises(ValueError):
        runtime_policy.run("session.patch_meta", {"key":"changed"}, {"provider":"claude", "name":"session"})


@pytest.mark.parametrize("kind", ["prepare_prompt", "format_status", "skill_catalog", "answer_body", "quota",
                                  "session.marker", "diag.error", "last_usage", "reload_stamp", "unknown_private",
                                  "launch_env"])
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


@pytest.mark.parametrize("kind,payload", [("session.patch_meta", {"cano": {"pid": 5}}), ("session.clear_cano", {"pid": 5})])
def test_codex_sidecar_is_written_only_by_rust(monkeypatch, kind, payload):
    # Sidecar e cano do Codex são do Rust (`codex_sidecar.rs`): o Python recusa sem ler nem gravar.
    from app.adapters.codex import sessions
    for attr in ("load", "update"):
        monkeypatch.setattr(sessions, attr, lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("sidecar tocado")))
    with pytest.raises(ValueError):
        runtime_policy.run(kind, payload, {"provider": "codex", "name": "cx", "key": "k", "validate": lambda: None})


def test_native_message_has_journal_before_uds(monkeypatch):
    from app import api, uds_messaging
    validated = []
    monkeypatch.setattr(uds_messaging, "socket_da_sessao", lambda *args: "fake.sock")
    monkeypatch.setattr(api, "_classe_modo", lambda *args: "prompting")
    def send(*args, **kwargs):
        assert validated == [True]
        assert kwargs["msg_id"]
        raise OSError("write sem prova")
    monkeypatch.setattr(uds_messaging, "enviar", send)
    result = runtime_policy.native_message({"text":"[de: source] Olá"}, {"key":"key", "name":"session",
        "session_id":"sid", "operation_id":"op", "validate":lambda: validated.append(True)})
    assert result["outcome"] == "unknown"


def test_native_message_uses_the_mode_the_rust_sent(monkeypatch):
    # Decisão do usuário (M6): o Rust manda a classe confirmada junto do recado; o Python não consulta
    # memória nem volta ao Rust. Sem ela (ou inválida), vale o cálculo de antes.
    from app import api, uds_messaging
    sent = []
    monkeypatch.setattr(uds_messaging, "socket_da_sessao", lambda *args: "fake.sock")
    monkeypatch.setattr(api, "_classe_modo", lambda *args: "prompting")
    monkeypatch.setattr(uds_messaging, "enviar", lambda sock, text, sender, mode, **kw: sent.append(mode))
    meta = {"key":"key", "name":"session", "session_id":"sid", "operation_id":"op", "validate":lambda: None}
    runtime_policy.native_message({"text":"[de: source] Olá", "mode":"bypass"}, meta)
    runtime_policy.native_message({"text":"[de: source] Olá", "mode":"turbo"}, meta)
    runtime_policy.native_message({"text":"[de: source] Olá"}, meta)
    assert sent == ["bypass", "prompting", "prompting"]
