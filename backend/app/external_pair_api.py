"""Par externo: convite, aceite e resgate entre máquinas de pessoas diferentes."""
from __future__ import annotations

import asyncio
import html
import logging
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app import external_pairs, pair, pair_texto, peers, share_api, share_store, share_tunnel
from app.auth import require_auth
from app.external_pairs import ExternalPair
from app.mensagens import erro
from app.share_guest_api import _PAGE, _REASONS, _owner
from app.share_life import session_life

_log = logging.getLogger(__name__)
router = APIRouter()

_CODE_RE = re.compile(r"[A-Za-z0-9]{1,64}")


def _my_owner() -> str:
    # O nome da máquina pode ter espaço e acento; o outro lado só aceita o alfabeto de valid_owner.
    return external_pairs._slug(_owner())[:40]


def _code_error(e: share_store.ShareError) -> HTTPException:
    code, msg = _REASONS[e.reason]
    return HTTPException(404 if e.reason == "unknown" else 410, detail=erro(code, msg, reason=e.reason))


def _invite(name: str) -> dict:
    life = session_life(name)
    if life is None:
        raise HTTPException(404, detail=erro("erro_sessao_inexistente", "sessão não encontrada"))
    if share_tunnel.port_clash():
        raise HTTPException(409, detail=erro(
            "erro_compartilhar_porta_do_convite",
            f"o app roda na porta do convite ({share_tunnel.GUEST_PORT}): troque CP_PORT no backend/.env e reinicie",
            port=share_tunnel.GUEST_PORT))
    try:
        base = share_tunnel.ensure_on()
    except share_tunnel.TunnelError as e:
        raise share_api._prereq_error(e)
    s, code = share_store.create(name, life, kind="pair")
    return {"id": s.id, "link": f"{base}/par/{code}", "expires_at": s.code_expires_at}


@router.post("/api/sessions/{name}/pair-invite", dependencies=[Depends(require_auth)])
async def pair_invite(name: str):
    return await asyncio.to_thread(_invite, name)


@router.get("/par/{code}", response_class=HTMLResponse)
def pair_page(code: str):
    # GET nunca gasta o código: prévia de link (WhatsApp) também faz GET.
    try:
        share_store.peek(code, kind="pair")
    except share_store.ShareError as e:
        corpo = f"<h1>Convite indisponível</h1><p>{html.escape(_REASONS[e.reason][1])}.</p>"
    else:
        corpo = (f"<h1>{html.escape(_owner())} quer parear uma sessão com a tua</h1>"
                 "<p>No app desktop do Hangar, clique com o botão direito na sessão que vai "
                 "trabalhar junto e escolha <b>Parear por convite…</b>. Ou cole este link "
                 "na conversa da sessão e peça para ela aceitar.</p>"
                 '<button onclick="navigator.clipboard.writeText(location.href);'
                 "this.textContent='Link copiado'\">Copiar link</button>")
    return HTMLResponse(_PAGE.format(corpo=corpo),
                        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


class PairRedeemBody(BaseModel):
    code: str
    session: str
    address: str
    token: str
    owner: str


@router.post("/api/pair/redeem")
async def pair_redeem(body: PairRedeemBody):
    from app import api
    address = external_pairs.normalize_address(body.address)
    if (address is None or not external_pairs.valid_token(body.token)
            or not external_pairs.valid_session(body.session)):
        raise HTTPException(400, detail=erro("erro_par_endereco_invalido", "endereço do par inválido"))
    if not external_pairs.valid_owner(body.owner):
        raise HTTPException(400, detail=erro("erro_par_nome_invalido", "nome da máquina do par inválido"))
    try:
        invite = share_store.peek(body.code, kind="pair")
        my_host = await asyncio.to_thread(share_tunnel.host)
    except share_store.ShareError as e:
        raise _code_error(e)
    except share_tunnel.TunnelError:
        raise HTTPException(503, detail=erro("erro_sessao_indisponivel", "indisponível por instantes"))
    name = invite.session
    alias = external_pairs.free_alias(body.owner)
    peer = f"{alias}::{body.session}"
    harness = {s.name: s.provider for s in await asyncio.to_thread(api.registry.list)}
    # Junta antes de gastar o código: grupo recusado não queima o convite.
    try:
        _, snap = await asyncio.to_thread(pair.join_group, name, [peer], "", substituir_task=True, harness=harness)
    except pair.PairMixError as e:
        raise HTTPException(409, detail=erro("erro_pareamento_mistura_cross", str(e)))
    except pair.TaskConflito as e:
        raise HTTPException(409, detail=erro("erro_pareamento_tarefa_existente",
                                             f"o grupo já tem tarefa: {e.existente!r}", existente=e.existente))
    try:
        share, token = await asyncio.to_thread(share_store.redeem, body.code, body.owner, None, None, "pair")
    except share_store.ShareError as e:
        await asyncio.to_thread(pair.restore, snap)
        raise _code_error(e)
    try:
        external_pairs.add(ExternalPair(share.id, name, alias, body.owner, body.session, address,
                                        body.token, time.time()))
        falha = await api._deliver(name, pair_texto.texto_par_externo(name, peer, body.owner))
    except Exception as e:  # noqa: BLE001 — código já gasto: desfaz tudo antes de propagar
        await _undo_local(snap, share.id)
        raise HTTPException(500, detail=erro("erro_pareamento_desfeito",
                                             f"pareamento desfeito: {e}", avisos=str(e)))
    if falha:
        await _undo_local(snap, share.id)
        raise HTTPException(502, detail=erro("erro_pareamento_aviso_falhou",
                                             f"pareamento desfeito: falha ao avisar '{name}': {api._erro_texto(falha)}",
                                             nome=name, erro=falha))
    return {"session": name, "owner": _my_owner(), "address": f"https://{my_host}:{share_tunnel.FUNNEL_PORT}",
            "token": token}


async def _undo_local(snap: dict, share_id: str) -> None:
    await asyncio.to_thread(pair.restore, snap)
    share_store.revoke(share_id)
    try:
        external_pairs.remove(share_id)
    except OSError as ex:
        _log.warning("par externo: registro %s não removido: %s", share_id, ex)


class PairAcceptBody(BaseModel):
    link: str


def _refused(e: peers.PeerError) -> HTTPException:
    """O outro lado respondeu com o envelope de erro dele: convite usado/vencido vira a frase própria."""
    d = e.detail
    if isinstance(d, dict):
        for reason, (code, msg) in _REASONS.items():
            if d.get("code") == code:
                return HTTPException(e.status, detail=erro(code, msg, reason=reason))
        texto = d.get("msg") if isinstance(d.get("msg"), str) else str(d)
    else:
        texto = str(d) if d is not None else str(e)
    return HTTPException(e.status, detail=erro("erro_par_recusado", texto[:300], detalhe=texto[:300]))


async def _undo_remote(address: str, token: str) -> None:
    try:
        await asyncio.to_thread(external_pairs.call, address, token, "DELETE", "/api/pair")
    except (peers.PeerError, ValueError) as ex:
        _log.warning("par externo: outro lado não desfeito (%s): %s", address, ex)


@router.post("/api/sessions/{name}/pair-accept", dependencies=[Depends(require_auth)])
async def pair_accept(name: str, body: PairAcceptBody):
    from app import api
    parsed = external_pairs.parse_pair_link(body.link)
    if parsed is None or not _CODE_RE.fullmatch(parsed[1]):
        raise HTTPException(400, detail=erro("erro_par_link_invalido", "link de par inválido"))
    address, code = parsed
    life = await asyncio.to_thread(session_life, name)
    if life is None:
        raise HTTPException(404, detail=erro("erro_sessao_inexistente", "sessão não encontrada"))
    # Antes de chamar o outro lado: recusar depois queimaria o código dele à toa.
    if await asyncio.to_thread(lambda: pair.PairLink(name).get()) is not None:
        raise HTTPException(409, detail=erro(
            "erro_pareamento_mistura_cross",
            "a sessão já está em grupo ou pareada — desfaça esse par antes de parear com outra máquina"))
    if share_tunnel.port_clash():
        raise HTTPException(409, detail=erro("erro_compartilhar_porta_do_convite", "porta do convite",
                                             port=share_tunnel.GUEST_PORT))
    try:
        my_base = await asyncio.to_thread(share_tunnel.ensure_on)
    except share_tunnel.TunnelError as e:
        raise share_api._prereq_error(e)
    # Vale antes do resgate: recado do outro lado pode chegar antes de este lado terminar.
    mine, my_token = await asyncio.to_thread(share_store.create_redeemed, name, life, "pair")
    try:
        _, resp = await asyncio.to_thread(external_pairs.call, address, None, "POST", "/api/pair/redeem",
                                          {"code": code, "session": name, "address": my_base,
                                           "token": my_token, "owner": _my_owner()})
    except peers.PeerError as e:
        share_store.revoke(mine.id)
        if e.status in (404, 410, 409, 400):
            raise _refused(e)
        raise HTTPException(502, detail=erro("erro_par_fora_do_ar", str(e)))
    resp = resp if isinstance(resp, dict) else {}
    owner, session, token = resp.get("owner", ""), resp.get("session", ""), resp.get("token", "")
    if not (isinstance(owner, str) and isinstance(session, str) and isinstance(token, str)
            and external_pairs.valid_owner(owner) and external_pairs.valid_session(session)
            and external_pairs.valid_token(token)):
        share_store.revoke(mine.id)
        # O outro lado já gravou o par com o nosso token: desfaz lá, se o token dele serve pra isso.
        if isinstance(token, str) and token and token.isascii() and token.isprintable():
            await _undo_remote(address, token)
        raise HTTPException(502, detail=erro("erro_par_resposta_invalida", "resposta do par inválida"))
    alias = external_pairs.free_alias(owner)
    peer = f"{alias}::{session}"
    snap = None
    try:
        external_pairs.add(ExternalPair(mine.id, name, alias, owner, session, address, token, time.time()))
        harness = {s.name: s.provider for s in await asyncio.to_thread(api.registry.list)}
        _, snap = await asyncio.to_thread(pair.join_group, name, [peer], "", substituir_task=True, harness=harness)
        falha = await api._deliver(name, pair_texto.texto_par_externo(name, peer, owner))
        if falha:
            raise RuntimeError(api._erro_texto(falha))
    except Exception as e:  # noqa: BLE001 — qualquer falha aqui desfaz os dois lados
        if snap is not None:
            await asyncio.to_thread(pair.restore, snap)
        external_pairs.remove(mine.id)
        share_store.revoke(mine.id)
        await _undo_remote(address, token)
        raise HTTPException(502, detail=erro("erro_pareamento_desfeito",
                                             f"pareamento desfeito: falha ao avisar as sessões ({e})",
                                             avisos=str(e)))
    return {"ok": True, "alias": alias, "owner": owner, "session": session}
