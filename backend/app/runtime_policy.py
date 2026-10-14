"""Serviços de dados do ator; nenhum cliente CLI ou autoridade paralela de fila."""
from __future__ import annotations

import asyncio

from app import diag
from app.internal_pool import internal_thread


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


class ModeClassMissing(RuntimeError):
    """Recado da reserva do terminal sem a classe de modo; o nome da classe é o código do erro."""


def demote_awaiting(sids: list[str]) -> None:
    """`hooks.demote_awaiting`: o mapa de marcadores e o registro nativo em memória são do Python
    (a prévia e as transições leem deles), então o Rust pede aqui em vez de regravar o sidecar."""
    from app import hook_state
    for sid in sids:
        hook_state.hook_state.demote_awaiting(sid)


def _sessions():
    from app.adapters.claude_headless import sessions
    return sessions


def run(kind: str, payload: dict, metadata: dict) -> dict:
    if not isinstance(payload, dict) or not isinstance(metadata, dict):
        raise ValueError("serviço com dados inválidos")
    # Os sidecars do Claude e do Codex são gravados pelo Rust (`claude_sidecar.rs`, `codex_sidecar.rs`).
    if metadata.get("provider") != "claude":
        raise ValueError("provedor fora do runtime")
    # Só a reserva Python do terminal (`runtime_terminal._service`, modo `python`) pede estes; o Rust não.
    if kind in {"terminal_facts", "terminal_publish", "terminal_plugin_control"}:
        if not metadata.get("terminal"):
            raise ValueError("serviço terminal fora do vínculo Claude")
        from app import runtime_terminal
        return {"terminal_facts":runtime_terminal.facts, "terminal_publish":runtime_terminal.publish,
            "terminal_plugin_control":runtime_terminal.plugin_control}[kind](payload, metadata)
    raise ValueError("serviço não permitido")
