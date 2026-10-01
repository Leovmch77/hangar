"""Rotas do DONO para compartilhar uma sessão, e o laço que mantém convites e túnel coerentes."""
from __future__ import annotations

import asyncio
import logging
import socket

from fastapi import APIRouter, Depends, HTTPException

from app import share_store, share_tunnel, tmux
from app.adapters.claude_headless import sessions as headless_sessions
from app.adapters.codex import sessions as codex_sessions
from app.auth import require_auth
from app.config import detect_lan_ip, resolve_bind_ip, settings
from app.mensagens import erro
from app.share_life import session_life

_log = logging.getLogger(__name__)
router = APIRouter()

_SWEEP_INTERVAL = 60.0

# Sessões no meio da troca terminal <-> sem terminal: a identidade muda no meio e só depois o
# convite é atualizado, então a varredura (e o portão do convidado) precisam ignorá-las.
changing_mode: set[str] = set()


# O funnel sobrevive um pouco ao último convite: o convidado ainda conectado precisa alcançar
# o servidor para receber o 410 "encerrado" em vez de parecer que a máquina caiu.
ENDED_GRACE = 120.0


def sync_tunnel() -> None:
    # Revogar nunca pode falhar por causa do túnel: o registro já saiu, e o laço periódico
    # tenta de novo em um minuto. Quem nunca compartilhou não passa pelo tailscale: o funnel
    # da 8443 pode ser dele.
    if not share_store.has_any(internet_only=True):
        return
    try:
        share_tunnel.sync(share_store.has_active(internet_only=True)
                          or share_store.recently_ended(ENDED_GRACE, internet_only=True))
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


def _escuta(ip: str, port: int) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=1):
            return True
    except OSError:
        return False


def _create(name: str, local: bool = False) -> dict:
    life = session_life(name)
    if life is None:
        raise HTTPException(404, detail=erro("erro_sessao_inexistente", "sessão não encontrada"))
    if share_tunnel.port_clash():
        raise HTTPException(409, detail=erro(
            "erro_compartilhar_porta_do_convite",
            f"o app roda na porta do convite ({share_tunnel.GUEST_PORT}): troque CP_PORT no backend/.env e reinicie",
            port=share_tunnel.GUEST_PORT))
    if local:
        # Mesma rede, sem Tailscale: só com a porta do convite de fato escutando no IP da rede
        # (bind 0.0.0.0, porta livre no boot). Senão o link sairia sem ninguém atendendo.
        ip = detect_lan_ip()
        if resolve_bind_ip(settings) not in ("0.0.0.0", "::") or not _escuta(ip, share_tunnel.GUEST_PORT):
            raise HTTPException(409, detail=erro(
                "erro_compartilhar_sem_rede_local",
                "esta máquina só escuta em 127.0.0.1: grave CP_LAN_BIND_IP=0.0.0.0 no backend/.env e reinicie"))
        base = f"http://{ip}:{share_tunnel.GUEST_PORT}"
    else:
        try:
            base = share_tunnel.ensure_on()
        except share_tunnel.TunnelError as e:
            raise _prereq_error(e)
    s, code = share_store.create(name, life, local=local)
    return {"id": s.id, "link": f"{base}/convite/{code}", "expires_at": s.code_expires_at}


def _prereq_error(e: share_tunnel.TunnelError) -> HTTPException:
    params = {"missing": e.missing, "fix": e.fix}
    if e.enable_url:
        params["enable_url"] = e.enable_url
    return HTTPException(409, detail=erro(
        "erro_compartilhar_pre_requisito", f"falta preparar o compartilhamento: {e.fix}", **params))


def _prereqs() -> dict:
    try:
        return share_tunnel.prereqs()
    except share_tunnel.TunnelError as e:
        # Sem tailscale ou deslogado: mesma resposta do gerar, e quem confere segue esperando.
        raise _prereq_error(e)


@router.get("/api/share/prereqs", dependencies=[Depends(require_auth)])
async def share_prereqs():
    return await asyncio.to_thread(_prereqs)


@router.post("/api/sessions/{name}/share", dependencies=[Depends(require_auth)])
async def create_share(name: str, local: bool = False):
    return await asyncio.to_thread(_create, name, local)


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
