"""Servidor MCP do Hangar: as operações do `hangar-send` como tools, montadas no backend em /mcp.

Quem chama se identifica pelos cabeçalhos X-Hangar-* (app.quem_chama); o token é o mesmo bearer
do backend, conferido ANTES do sub-app porque `app.mount()` passa por fora do `Depends`.
Cada tool chama a mesma função de rota que o CLI chama por HTTP — nada de funcionalidade só do MCP.
"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
from typing import Any

from fastapi import HTTPException
from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings

from app import peers, quem_chama
from app.config import settings

mcp = MCPServer("hangar")


def _cabecalhos(ctx: Context) -> dict[str, str]:
    req = getattr(ctx.request_context, "request", None)
    return dict(req.headers) if req is not None else {}


async def _eu(ctx: Context) -> str:
    try:
        nome, _ = await asyncio.to_thread(quem_chama.resolver, _cabecalhos(ctx))
    except quem_chama.SessaoDesconhecida as e:
        raise ToolError(f"sessao_desconhecida: {e}") from e
    return nome


def _detalhe(e: HTTPException) -> str:
    d = e.detail
    return d.get("msg", str(d)) if isinstance(d, dict) else str(d)


@mcp.tool(description="Quem é esta sessão no Hangar (nome e por qual cabeçalho foi resolvida). "
                      "Diagnóstico; equivale a `hangar-send` descobrindo a própria sessão.")
async def quem_sou(ctx: Context) -> dict[str, str]:
    try:
        nome, origem = await asyncio.to_thread(quem_chama.resolver, _cabecalhos(ctx))
    except quem_chama.SessaoDesconhecida as e:
        raise ToolError(f"sessao_desconhecida: {e}") from e
    return {"name": nome, "origem": origem}


@mcp.tool(description="Lista as sessões vivas nesta máquina (nome, estado, cwd, provider). "
                      "Equivale a `hangar-send --list` sem os servidores remotos.")
async def sessoes() -> list[dict[str, Any]]:
    from app import api
    infos = await api.list_sessions()
    return [{"name": s.name, "state": getattr(s, "state", None), "cwd": s.cwd,
             "provider": s.provider, "headless": s.headless} for s in infos]


@mcp.tool(description="Manda um recado 1:1 pra outra sessão, como `hangar-send <sessao> <msg>`: "
                      "chega lá como `[de: <você>] texto`. `alvo` aceita `servidor::sessao` "
                      "pra outro servidor. Recusa alvo Claude local com caminho nativo "
                      "(use SendMessage) a menos que `tmux=true`.")
async def enviar(ctx: Context, alvo: str, texto: str, tmux: bool = False) -> dict[str, Any]:
    from app import api
    eu = await _eu(ctx)
    if peers.is_remote(alvo):
        srv, sess = peers.split_addr(alvo)
        if not settings.server_id:
            raise ToolError("CP_SERVER_ID ausente no backend/.env — obrigatório pra envio cross-server")
        corpo = {"text": f"[de: {settings.server_id}::{eu}] {texto}", "steer": True}
        try:
            _, resp = await asyncio.to_thread(peers.call, srv, "POST", f"/api/sessions/{sess}/input", corpo)
        except peers.PeerError as e:
            raise ToolError(str(e)) from e
        return {"alvo": alvo, **(resp or {})}
    if not tmux:
        uds = (await api.peer_address(alvo)).get("uds")
        if uds:
            raise ToolError(f"recusado: '{alvo}' é sessão Claude desta máquina e o caminho nativo "
                             "alcança os dois lados. Use SendMessage (o alvo aparece no ListAgents); "
                             "se não aparecer, repita com tmux=true.")
    try:
        resp = await api.input_prompt(alvo, api.InputBody(text=f"[de: {eu}] {texto}", steer=True))
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e
    return {"alvo": alvo, **resp}


# O gerenciador de sessões do SDK só roda UMA vez por instância: o sub-app nasce no lifespan.
_sub = None


async def _responder(send, status: int, corpo: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": corpo})


async def asgi(scope, receive, send):
    """Sub-app com o bearer conferido na porta: mount não passa pelo `require_auth` das rotas."""
    if scope["type"] != "http":
        return
    auth = dict(scope["headers"]).get(b"authorization", b"")
    token = auth[7:] if auth.startswith(b"Bearer ") else b""
    if not secrets.compare_digest(token, settings.auth_token.encode()):
        await _responder(send, 401, b'{"detail":"unauthorized"}')
        return
    if _sub is None:
        await _responder(send, 503, b'{"detail":"mcp ainda nao subiu"}')
        return
    await _sub(scope, receive, send)


@contextlib.asynccontextmanager
async def lifespan():
    global _sub
    # Só sessões desta máquina falam com o /mcp; o Host de fora é recusado (DNS rebinding).
    seguranca = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*", "[::1]", "[::1]:*"],
        allowed_origins=["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"])
    sub = mcp.streamable_http_app(streamable_http_path="/", transport_security=seguranca)
    async with sub.router.lifespan_context(sub):
        _sub = sub
        try:
            yield
        finally:
            _sub = None
