"""Rotas do DONO para compartilhar uma sessão, e o laço que mantém convites e túnel coerentes."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException

from app import share_store, share_tunnel, tmux
from app.adapters.claude_headless import sessions as headless_sessions
from app.adapters.codex import sessions as codex_sessions
from app.auth import require_auth
from app.mensagens import erro
from app.share_life import session_life

_log = logging.getLogger(__name__)
router = APIRouter()

_SWEEP_INTERVAL = 60.0

# Sessões no meio da troca terminal <-> sem terminal: a identidade muda no meio e só depois o
# convite é atualizado, então a varredura (e o portão do convidado) precisam ignorá-las.
changing_mode: set[str] = set()


def sync_tunnel() -> None:
    # Revogar nunca pode falhar por causa do túnel: o registro já saiu, e o laço periódico
    # tenta de novo em um minuto. Quem nunca compartilhou não passa pelo tailscale: o funnel
    # da 8443 pode ser dele.
    if not share_store.has_any():
        return
    try:
        share_tunnel.sync(share_store.has_active())
    except share_tunnel.TunnelError as e:
        _log.warning("[share] sincronizar funnel falhou: %s", e.fix)


def confirmed_absent(name: str) -> bool:
    # `session_life` devolve None também quando o tmux falha; só vale como "morreu" com a
    # ausência confirmada (tmux respondeu que não há a sessão e não sobrou sidecar).
    return (tmux.sessao_existe(name) is False
            and not headless_sessions.exists(name) and not codex_sessions.exists(name))


def _alive(session: str, life: str) -> bool:
    if session in changing_mode:
        return True
    atual = session_life(session)
    if atual is None:
        return not confirmed_absent(session)
    return atual == life


def _sweep_once() -> None:
    share_store.sweep(_alive)
    sync_tunnel()


async def sweep_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(_sweep_once)
        except Exception:  # noqa: BLE001 — uma rodada ruim não mata o laço
            _log.exception("[share] varredura falhou")
        await asyncio.sleep(_SWEEP_INTERVAL)


def _create(name: str) -> dict:
    life = session_life(name)
    if life is None:
        raise HTTPException(404, detail=erro("erro_sessao_inexistente", "sessão não encontrada"))
    try:
        base = share_tunnel.ensure_on()
    except share_tunnel.TunnelError as e:
        raise HTTPException(409, detail=erro(
            "erro_compartilhar_pre_requisito", f"falta preparar o compartilhamento: {e.fix}",
            missing=e.missing, fix=e.fix))
    s, code = share_store.create(name, life)
    return {"id": s.id, "link": f"{base}/convite/{code}", "expires_at": s.code_expires_at}


@router.post("/api/sessions/{name}/share", dependencies=[Depends(require_auth)])
async def create_share(name: str):
    return await asyncio.to_thread(_create, name)


@router.get("/api/sessions/{name}/share", dependencies=[Depends(require_auth)])
async def list_shares(name: str):
    shares = await asyncio.to_thread(share_store.list_for, name)
    return {"shares": [{"id": s.id, "device": s.device, "created_at": s.created_at,
                        "redeemed_at": s.redeemed_at, "expires_at": s.code_expires_at,
                        "pending": s.redeemed_at is None} for s in shares]}


def _revoke_one(name: str, share_id: str) -> bool:
    alvo = next((s for s in share_store.list_for(name) if s.id == share_id), None)
    if alvo is None or not share_store.revoke(share_id):
        return False
    sync_tunnel()
    return True


@router.delete("/api/sessions/{name}/share/{share_id}", dependencies=[Depends(require_auth)])
async def revoke_share(name: str, share_id: str):
    if not await asyncio.to_thread(_revoke_one, name, share_id):
        raise HTTPException(404, detail=erro("erro_compartilhamento_inexistente",
                                             "compartilhamento não encontrado"))
    return {"ok": True}


def _revoke_all(name: str) -> int:
    n = share_store.revoke_session(name)
    sync_tunnel()
    return n


@router.delete("/api/sessions/{name}/share", dependencies=[Depends(require_auth)])
async def revoke_all_shares(name: str):
    return {"ok": True, "revoked": await asyncio.to_thread(_revoke_all, name)}
