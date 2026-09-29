"""Convites de compartilhamento de sessão: um registro por link gerado.

Só hashes vão ao disco — o código e o token crus existem só na resposta que os entrega.
Este processo é o único escritor do arquivo, então o dicionário em memória é a verdade e o
disco é a cópia para sobreviver ao restart.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from app import atomico
from app.config import _backend_config_base

_log = logging.getLogger(__name__)

CODE_TTL = 24 * 3600.0
# Código vencido sem uso some depois disto; revogado fica mais tempo para o convidado receber
# "encerrado" (410) em vez de "token inválido" (401), que os clientes tratam como login perdido.
_KEEP_EXPIRED = 24 * 3600.0
_KEEP_REVOKED = 30 * 24 * 3600.0

_FILE = "shares.json"
_path_override: Path | None = None
_lock = threading.RLock()
_state: dict[str, "Share"] | None = None


class ShareError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class Share:
    id: str
    session: str
    life: str
    created_at: float
    code_expires_at: float
    code_hash: str
    token_hash: str | None = None
    device: str | None = None
    redeemed_at: float | None = None
    revoked_at: float | None = None

    def active(self, now: float) -> bool:
        if self.revoked_at is not None:
            return False
        return self.redeemed_at is not None or now <= self.code_expires_at


def _path() -> Path:
    return _path_override or Path(_backend_config_base()) / _FILE


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _norm_code(code: str) -> str:
    return "".join(code.split()).upper()


def _reset() -> None:
    global _state
    with _lock:
        _state = None


def _load() -> dict[str, Share]:
    global _state
    with _lock:
        if _state is None:
            try:
                raw = json.loads(_path().read_text(encoding="utf-8"))
                _state = {d["id"]: Share(**d) for d in raw}
            except FileNotFoundError:
                _state = {}
            except (OSError, ValueError, TypeError, KeyError) as e:
                # Arquivo ilegível vira "nenhum convite": perde acessos, mas não derruba o backend.
                _log.warning("[share] %s ilegivel, comecando vazio: %s", _path(), e)
                _state = {}
        return _state


def _save() -> None:
    destino = _path()
    destino.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(destino.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump([asdict(s) for s in _load().values()], fh, indent=2)
        # 0600 antes do rename: o arquivo nunca fica visível com permissão aberta.
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        atomico.substituir(tmp, destino)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def create(session: str, life: str, now: float | None = None) -> tuple[Share, str]:
    now = time.time() if now is None else now
    code = base64.b32encode(secrets.token_bytes(16)).decode().rstrip("=")
    s = Share(id=secrets.token_hex(8), session=session, life=life, created_at=now,
              code_expires_at=now + CODE_TTL, code_hash=_hash(code))
    with _lock:
        _load()[s.id] = s
        _save()
    return s, code


def peek(code: str, now: float | None = None) -> Share:
    now = time.time() if now is None else now
    h = _hash(_norm_code(code))
    with _lock:
        s = next((x for x in _load().values() if x.code_hash == h), None)
    if s is None:
        raise ShareError("unknown")
    if s.revoked_at is not None:
        raise ShareError("revoked")
    if s.redeemed_at is not None:
        raise ShareError("used")
    if now > s.code_expires_at:
        raise ShareError("expired")
    return s


def redeem(code: str, device: str, now: float | None = None) -> tuple[Share, str]:
    now = time.time() if now is None else now
    with _lock:
        s = peek(code, now)
        token = secrets.token_urlsafe(32)
        s.token_hash = _hash(token)
        s.device = (device or "").strip()[:80] or None
        s.redeemed_at = now
        _save()
    return s, token


def lookup_token(token: str) -> Share | None:
    if not token:
        return None
    h = _hash(token)
    with _lock:
        return next((x for x in _load().values() if x.token_hash == h), None)


def by_token(token: str) -> Share | None:
    s = lookup_token(token)
    return s if s is not None and s.revoked_at is None else None


def list_for(session: str, now: float | None = None) -> list[Share]:
    now = time.time() if now is None else now
    with _lock:
        return sorted((x for x in _load().values() if x.session == session and x.active(now)),
                      key=lambda x: x.created_at)


def revoke(share_id: str) -> bool:
    with _lock:
        s = _load().get(share_id)
        if s is None or s.revoked_at is not None:
            return False
        s.revoked_at = time.time()
        _save()
        return True


def revoke_session(session: str) -> int:
    now = time.time()
    with _lock:
        alvo = [x for x in _load().values() if x.session == session and x.revoked_at is None]
        for x in alvo:
            x.revoked_at = now
        if alvo:
            _save()
        return len(alvo)


def rename(old: str, new: str) -> None:
    with _lock:
        alvo = [x for x in _load().values() if x.session == old]
        for x in alvo:
            x.session = new
        if alvo:
            _save()


def set_life(session: str, life: str | None) -> None:
    if life is None:
        return
    with _lock:
        alvo = [x for x in _load().values() if x.session == session and x.revoked_at is None]
        for x in alvo:
            x.life = life
        if alvo:
            _save()


def has_any() -> bool:
    # Revogado fica guardado por dias, então "tem registro" cobre o funnel a desligar depois do
    # último revoke; quem nunca compartilhou não tem nenhum.
    with _lock:
        return bool(_load())


def has_active(now: float | None = None) -> bool:
    now = time.time() if now is None else now
    with _lock:
        return any(x.active(now) for x in _load().values())


def recently_ended(window: float, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    with _lock:
        return any(x.revoked_at is not None and now - x.revoked_at <= window
                   for x in _load().values())


def active_sessions(now: float | None = None) -> set[str]:
    now = time.time() if now is None else now
    with _lock:
        return {x.session for x in _load().values() if x.active(now)}


def sweep(alive: Callable[[str, str], bool], now: float | None = None) -> int:
    """Revoga convites de sessão que acabou ou renasceu com o mesmo nome; apaga os velhos."""
    now = time.time() if now is None else now
    # `alive` chama o tmux (segundos por convite): fora do lock, que o loop de eventos também toma.
    with _lock:
        candidatos = {x.id: (x.session, x.life) for x in _load().values()
                      if x.revoked_at is None and x.active(now)}
    mortos = {k for k, (session, life) in candidatos.items() if not alive(session, life)}
    with _lock:
        estado = _load()
        revogados = 0
        for k in mortos:
            x = estado.get(k)
            # Mudou no meio (trocou de modo, foi revogado): a leitura de fora do lock não vale.
            if x is not None and x.revoked_at is None and (x.session, x.life) == candidatos[k]:
                x.revoked_at = now
                revogados += 1
        velhos = [k for k, x in estado.items()
                  if (x.revoked_at is not None and now - x.revoked_at > _KEEP_REVOKED)
                  or (x.redeemed_at is None and x.revoked_at is None
                      and now > x.code_expires_at + _KEEP_EXPIRED)]
        for k in velhos:
            del estado[k]
        if revogados or velhos:
            _save()
        return revogados
