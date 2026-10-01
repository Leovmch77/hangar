"""Lado de saída do par externo: endereço e token que o OUTRO usuário entregou.

O lado de entrada (quem me chama) é um share_store.Share de kind "pair". Fica fora do
peers.json, que guarda o token de dono das máquinas do próprio usuário.
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit

from app import atomico, peers
from app.config import settings

_log = logging.getLogger("hangar")

_FILE = "external_pairs.json"
_path_override: Path | None = None
_lock = threading.RLock()
_state: list["ExternalPair"] | None = None

OWNER_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,200}$")
# Espaço e invisíveis que deixariam um cabeçalho forjado passar por texto comum.
_LEADING_RE = re.compile("[\\s​‌‍⁠﻿]*")
MAX_TEXT = 16000
MAX_SESSION = 64
FUNNEL_PORT = 8443


@dataclass
class ExternalPair:
    share_id: str
    local_session: str
    alias: str
    peer_owner: str
    peer_session: str
    peer_address: str
    peer_token: str
    created_at: float

    @property
    def address(self) -> str:
        return f"{self.alias}::{self.peer_session}"


def _path() -> Path:
    if _path_override:
        return _path_override
    from app.pair import _pair_dir
    return _pair_dir() / _FILE


def _reset() -> None:
    global _state
    with _lock:
        _state = None


def _load() -> list[ExternalPair]:
    global _state
    with _lock:
        if _state is None:
            try:
                _state = [ExternalPair(**d) for d in json.loads(_path().read_text(encoding="utf-8"))]
            except FileNotFoundError:
                _state = []
            except (OSError, ValueError, TypeError, KeyError) as e:
                # A listagem de sessões lê isto: arquivo torto não pode derrubá-la.
                _log.warning("[par-externo] %s ilegível: %s", _FILE, e)
                _state = []
        return _state


def _save() -> None:
    destino = _path()
    destino.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(destino.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump([asdict(r) for r in _load()], fh, indent=2)
        os.chmod(tmp, 0o600)
        atomico.substituir(tmp, destino)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def add(rec: ExternalPair) -> None:
    with _lock:
        _load().append(rec)
        _save()


def remove(share_id: str) -> ExternalPair | None:
    with _lock:
        estado = _load()
        rec = next((r for r in estado if r.share_id == share_id), None)
        if rec:
            estado.remove(rec)
            _save()
        return rec


def rename_local(old: str, new: str) -> None:
    with _lock:
        alvo = [r for r in _load() if r.local_session == old]
        for r in alvo:
            r.local_session = new
        if alvo:
            _save()


def all() -> list[ExternalPair]:  # noqa: A001
    with _lock:
        return list(_load())


def by_share(share_id: str) -> ExternalPair | None:
    return next((r for r in all() if r.share_id == share_id), None)


def by_address(addr: str) -> ExternalPair | None:
    return next((r for r in all() if r.address == addr), None)


def by_local(session: str) -> list[ExternalPair]:
    return [r for r in all() if r.local_session == session]


def _slug(owner: str) -> str:
    s = unicodedata.normalize("NFKD", owner).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9._-]+", "-", s).strip("-") or "par"


def free_alias(owner: str) -> str:
    base = _slug(owner)
    taken = set(peers._load()) | {settings.server_id or ""} | {r.alias for r in all()}
    alias, n = base, 2
    while alias in taken:
        alias, n = f"{base}-{n}", n + 1
    return alias


def ambiguous(alias: str) -> bool:
    return alias in peers._load() and any(r.alias == alias for r in all())


def valid_owner(owner: str) -> bool:
    return bool(OWNER_RE.fullmatch(owner or ""))


def valid_session(name: str) -> bool:
    """Nome de sessão que o outro lado informou: entra em endereço e em cabeçalho `[de fora: …]`."""
    if not isinstance(name, str) or not name or len(name) > MAX_SESSION:
        return False
    if "[" in name or "]" in name or "::" in name:
        return False
    return not any(ord(c) < 32 or c in "  \u0085" for c in name)


def valid_token(token: str) -> bool:
    return bool(TOKEN_RE.fullmatch(token or ""))


def normalize_address(addr: str) -> str | None:
    try:
        u = urlsplit((addr or "").strip())
        port = u.port
    except ValueError:
        return None
    host = u.hostname or ""
    if (u.scheme != "https" or port != FUNNEL_PORT or not host.endswith(".ts.net") or u.username
            or u.password or u.query or u.fragment or u.path not in ("", "/")):
        return None
    return f"https://{host}:{FUNNEL_PORT}"


def parse_pair_link(link: str) -> tuple[str, str] | None:
    u = urlsplit((link or "").strip())
    parts = [p for p in u.path.split("/") if p]
    if len(parts) != 2 or parts[0] != "par":
        return None
    base = normalize_address(f"{u.scheme}://{u.netloc}")
    return (base, parts[1]) if base else None


def sanitize_message(text: str) -> str:
    """Recado de fora não pode se passar por aviso do app nem por outra sessão."""
    linhas = []
    for linha in (text or "").splitlines(keepends=True):
        n = _LEADING_RE.match(linha).end()
        if linha.startswith(("[de", "[painel:", "[grupo:"), n):
            linha = linha[:n] + "(" + linha[n + 1:]
        linhas.append(linha)
    return "".join(linhas)[:MAX_TEXT]


def call(address: str, token: str | None, method: str, path: str, body: dict | None = None,
         timeout: int = 8):
    return peers.call_url(address, token, method, path, body, timeout, label=address)
