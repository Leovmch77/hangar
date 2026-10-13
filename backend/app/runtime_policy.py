"""Serviços de dados do ator; nenhum cliente CLI ou autoridade paralela de fila."""
from __future__ import annotations

import asyncio
import json
import threading
import uuid
from pathlib import Path

from app import diag
from app.internal_pool import internal_thread

# O sidecar do Codex é gravado pelo Rust (`codex_sidecar.rs`); aqui só o do Claude.
_PATCH = {
    "claude": {"session_id", "cwd", "model", "effort", "permission_mode", "previous_non_plan", "context_window", "problema", "cano"},
}
_unknown_guard = threading.Lock()
_mutation_locks = {}


async def execute(kind: str, payload: dict, metadata: dict) -> dict:
    task = asyncio.create_task(internal_thread(run, kind, payload, metadata))
    try:
        data = await asyncio.shield(task)
        return {"ok": True, "data": data}
    except asyncio.CancelledError:
        try:
            await asyncio.shield(task)
        finally:
            raise
    except Exception as exc:
        diag.registrar("runtime.policy_failed", "erro", codigo=type(exc).__name__)
        return {"ok": False, "error_type": type(exc).__name__}


def native_message(payload, metadata):
    from app import api, uds_messaging
    text = payload.get("text")
    operation_id = metadata.get("operation_id")
    if not isinstance(text, str) or not isinstance(operation_id, str) or not operation_id:
        raise ValueError("recado sem operação registrada")
    sender, _ = uds_messaging.separar_prefixo(text)
    if sender is None:
        return {"outcome": "not_written", "reason": "ordinary_input"}
    endpoint = uds_messaging.socket_da_sessao(metadata.get("session_id", ""), metadata.get("config_dir"))
    if not endpoint:
        return {"outcome": "not_written", "reason": "no_socket"}
    # A classe confirmada vem do Rust, dono da memória de modo; sem ela, o cálculo pelo transcript e pela conta.
    mode = payload.get("mode") if payload.get("mode") in ("bypass", "prompting") else \
        api._classe_modo(sender, metadata["name"], metadata.get("config_dir"), metadata.get("jsonl"))
    mid = str(uuid.uuid5(uuid.NAMESPACE_URL, "hangar:" + metadata["key"] + ":" + operation_id))
    validate = metadata.get("validate")
    if validate is None:
        raise RuntimeError("recado sem confirmação de posse")
    validate()
    try:
        uds_messaging.enviar(endpoint, text, sender, mode, msg_id=mid)
    except Exception:
        return {"outcome": "unknown", "msg_id": mid}
    return {"outcome": "written", "msg_id": mid}


def demote_awaiting(sids: list[str]) -> None:
    """`hooks.demote_awaiting`: o mapa de marcadores e o registro nativo em memória são do Python
    (a prévia e as transições leem deles), então o Rust pede aqui em vez de regravar o sidecar."""
    from app import hook_state
    for sid in sids:
        hook_state.hook_state.demote_awaiting(sid)


def _sessions():
    from app.adapters.claude_headless import sessions
    return sessions


def clear_cano(payload: dict, metadata: dict) -> dict:
    """Tira o `cano` do arquivo da sessão só se ele ainda for o processo `pid`; arquivo apagado fica apagado."""
    pid = payload.get("pid")
    if type(pid) is not int or set(payload) != {"pid"}:
        raise ValueError("pid do cano inválido")
    validate = metadata.get("validate")
    if validate is None:
        raise RuntimeError("alteração sem confirmação de posse")
    sessions = _sessions()
    with _unknown_guard:
        lock = _mutation_locks.setdefault(metadata["key"], threading.Lock())
    with lock:
        validate()
        current = sessions.load(metadata["name"])
        if not current or current.get("key") != metadata["key"] or (current.get("cano") or {}).get("pid") != pid:
            return {"cleared": False}
        return {"cleared": sessions.update(metadata["name"], cano=None) is not None}


def run(kind: str, payload: dict, metadata: dict) -> dict:
    if not isinstance(payload, dict) or not isinstance(metadata, dict):
        raise ValueError("serviço com dados inválidos")
    provider = metadata.get("provider")
    if provider not in _PATCH:
        raise ValueError("provedor fora do runtime")
    # Só a reserva Python do terminal (`runtime_terminal._service`, modo `python`) pede estes; o Rust não.
    if kind in {"terminal_facts", "terminal_publish", "terminal_plugin_control"}:
        if provider != "claude" or not metadata.get("terminal"):
            raise ValueError("serviço terminal fora do vínculo Claude")
        from app import runtime_terminal
        return {"terminal_facts":runtime_terminal.facts, "terminal_publish":runtime_terminal.publish,
            "terminal_plugin_control":runtime_terminal.plugin_control}[kind](payload, metadata)
    if kind == "native_message":
        return native_message(payload, metadata)
    if kind == "session.clear_cano":
        return clear_cano(payload, metadata)
    if kind == "session.patch_meta":
        if set(payload) - _PATCH[provider]:
            raise ValueError("campo fora do catálogo do sidecar")
        validate = metadata.get("validate")
        if validate is None:
            raise RuntimeError("alteração sem confirmação de posse")
        with _unknown_guard:
            lock = _mutation_locks.setdefault(metadata["key"], threading.Lock())
        with lock:
            validate()
            state_path = metadata.get("state_path")
            view = (json.loads(Path(state_path).read_bytes())["runtime_state"].get("view") or {}) if state_path else {}
            for key, value in payload.items():
                source = "conversation" if key == "session_id" else key
                if source in view and view[source] != value:
                    return {"updated": False, "stale": True}
            sessions = _sessions()
            current = sessions.load(metadata["name"])
            if not current or current.get("key") != metadata["key"]:
                raise RuntimeError("sidecar de outra vida")
            updated = sessions.update(metadata["name"], **payload)
            if updated is None:
                raise RuntimeError("sidecar desapareceu durante a alteração")
        if provider == "claude" and payload.get("session_id"):
            from app import claude_customizations
            try:
                claude_customizations.remember(payload["session_id"], updated.get("claude_settings"))
            except claude_customizations.CustomizationsError as exc:
                diag.registrar("claude.customizations_not_saved", "aviso", codigo=exc.code)
                with lock:
                    validate()
                    current = sessions.load(metadata["name"])
                    if current and current.get("key") == metadata["key"]:
                        sessions.update(metadata["name"], problema=[exc.code, exc.detail])
                return {"updated": True, "customizations_persisted": False, "warning": exc.detail}
        return {"updated": True}
    raise ValueError("serviço não permitido")
