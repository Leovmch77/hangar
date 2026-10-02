"""Porta local do Hangar Connect: o Caddy desta máquina entrega aqui o que veio da internet."""
from app.config import settings

CONNECT_PORT = 8768
# Endereço de documentação (RFC 5737): não é loopback, então nenhuma checagem de "acesso local" o
# aceita, e todo acesso pelo Connect divide um contador de tentativas próprio. Cuidado: o
# `ipaddress` do Python o classifica como privado — nunca decidir "local" por `is_private`.
CONNECT_PEER = "192.0.2.1"


class ConnectPortGate:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        server = scope.get("server") or (None, None)
        # O uvicorn já reescreveu o cliente pelo X-Forwarded-For do Caddy (que vem de 127.0.0.1);
        # aqui ele é trocado por inteiro, então nem o endereço real nem um forjado sobrevivem.
        if scope["type"] in ("http", "websocket") and server[1] == CONNECT_PORT \
                and settings.port != CONNECT_PORT:
            # O Caddy só fala https com a internet: o esquema sai da porta, não do X-Forwarded-Proto.
            scheme = "wss" if scope["type"] == "websocket" else "https"
            scope = {**scope, "client": (CONNECT_PEER, 0), "scheme": scheme}
        await self.app(scope, receive, send)
