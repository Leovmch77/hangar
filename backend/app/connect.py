"""Hangar Connect neste PC: código de ligação, configs do frpc e do Caddy, binários e os dois processos."""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from app import atomico
from app.connect_port import CONNECT_PORT

CADDY_PORT = 18443
# fullmatch, não ^…$: o `$` do Python aceita um \n no fim, que quebraria o TOML.
_NAME = re.compile(r"(?=.{1,253}\Z)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+")
_TOKEN = re.compile(r"[A-Za-z0-9._~+/=-]{16,256}")


class ConnectError(Exception):
    def __init__(self, status: int, code: str, msg: str):
        super().__init__(msg)
        self.status, self.code, self.msg = status, code, msg


@dataclass(frozen=True)
class Code:
    server: str
    token: str
    host: str


def folder() -> Path:
    return Path.home() / ".hangar" / "connect"


def parse_code(text: str) -> Code:
    # Os três valores vão crus para dentro do TOML e do Caddyfile: a regex é o que impede injeção.
    raw = text.strip()
    try:
        data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except (binascii.Error, ValueError) as e:
        raise ConnectError(400, "erro_connect_codigo_invalido", "código de ligação ilegível") from e
    server, token, host = (data.get(k) if isinstance(data, dict) else None for k in ("server", "token", "host"))
    if not (isinstance(data, dict) and data.get("v") == 1
            and isinstance(server, str) and _NAME.fullmatch(server)
            and isinstance(host, str) and _NAME.fullmatch(host) and host.count(".") >= 2
            and isinstance(token, str) and _TOKEN.fullmatch(token)):
        raise ConnectError(400, "erro_connect_codigo_invalido", "código de ligação incompleto")
    return Code(server, token, host)


def render_frpc(code: Code) -> str:
    return (
        f'serverAddr = "{code.server}"\nserverPort = 443\ntransport.protocol = "wss"\n'
        f'auth.method = "token"\nauth.token = "{code.token}"\nloginFailExit = false\n'
        'log.to = "console"\nlog.level = "warn"\n\n'
        f'[[proxies]]\nname = "{code.host}"\ntype = "https"\nlocalIP = "127.0.0.1"\n'
        f'localPort = {CADDY_PORT}\ncustomDomains = ["{code.host}"]\n')


def render_caddyfile(code: Code, data: Path) -> str:
    # TLS-ALPN-01 pela 443 repassada: a porta 80 da VPS é do traefik, o desafio HTTP nunca chegaria.
    return (
        "{\n\tadmin off\n\thttp_port 18080\n\thttps_port %d\n\tauto_https disable_redirects\n"
        '\tstorage file_system "%s"\n\tlog {\n\t\tlevel WARN\n\t}\n}\n\n'
        "%s {\n\tbind 127.0.0.1\n\ttls {\n\t\tissuer acme {\n\t\t\tdisable_http_challenge\n\t\t}\n\t}\n"
        "\treverse_proxy 127.0.0.1:%d\n}\n"
    ) % (CADDY_PORT, data.as_posix(), code.host, CONNECT_PORT)


def _state_file() -> Path:
    return folder() / "connect.json"


def read_state() -> dict:
    try:
        data = json.loads(_state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_private(dest: Path, content: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(content)
    atomico.substituir(tmp, dest)


def write_state(state: dict) -> None:
    _write_private(_state_file(), json.dumps(state).encode())
