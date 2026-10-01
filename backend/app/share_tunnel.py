"""Funnel (internet) SÓ para a porta do convidado, ligado enquanto houver convite ativo.

A 443 é o `tailscale serve` do dono (só tailnet) e a 10000 é a prévia de porta (tunnel.py); o
Funnel aceita 443/8443/10000, então a 8443 é a que sobra.
"""
from __future__ import annotations

import getpass
import json
import re
import sys

from app import tunnel
from app.config import settings

GUEST_PORT = 8766
FUNNEL_PORT = 8443


def port_clash() -> bool:
    # App na mesma porta do convite: o porteiro trancaria o dono e o Funnel exporia a API inteira.
    return settings.port == GUEST_PORT

_FIX_OPERATOR = "sudo tailscale set --operator=$USER"
_FIX_FUNNEL = ("libere o Funnel na política da tailnet (nodeAttrs \"funnel\"): "
               "https://login.tailscale.com/admin/acls/file")
_LOGIN_URL = re.compile(r"https://login\.tailscale\.com/\S+")


class TunnelError(Exception):
    def __init__(self, missing: list[str], fix: str, enable_url: str | None = None):
        super().__init__(fix)
        self.missing = missing
        self.fix = fix
        self.enable_url = enable_url


def _run(*args: str):
    return tunnel._run(*args)


def _call(*args: str):
    try:
        return _run(*args)
    except tunnel.TunnelError as e:
        raise TunnelError([], e.detail) from e


def _status() -> dict:
    p = _call("status", "--json")
    try:
        return json.loads(p.stdout)["Self"]
    except (ValueError, KeyError, TypeError):
        raise TunnelError([], (p.stderr or "tailscale status falhou").strip())


def host() -> str:
    name = (_status().get("DNSName") or "").rstrip(".")
    if not name:
        raise TunnelError([], "tailscale sem DNSName (logado?)")
    return name


def _missing(self_status: dict) -> list[str]:
    faltam = []
    # Operador é coisa do tailscaled do Linux; no Windows e no macOS o app do Tailscale não o usa.
    if sys.platform.startswith("linux"):
        p = _call("debug", "prefs")
        try:
            operador = json.loads(p.stdout).get("OperatorUser") or ""
        except ValueError:
            operador = ""
        if operador != getpass.getuser():
            faltam.append("operator")
    caps = self_status.get("CapMap") or {}
    if not any(k == "funnel" or k.startswith("https://tailscale.com/cap/funnel") for k in caps):
        faltam.append("funnel")
    return faltam


def _prereqs(self_status: dict) -> dict:
    faltam = _missing(self_status)
    fixes = {"operator": _FIX_OPERATOR, "funnel": _FIX_FUNNEL}
    node = self_status.get("ID") or ""
    enable_url = f"https://login.tailscale.com/f/funnel?node={node}" if node and "funnel" in faltam else None
    return {"missing": faltam, "fix": "\n".join(fixes[f] for f in faltam), "enable_url": enable_url}


def prereqs() -> dict:
    """O que falta para o Funnel subir, sem ligar nada."""
    return _prereqs(_status())


def _is_on() -> bool:
    p = _call("funnel", "status", "--json")
    try:
        allow = json.loads(p.stdout or "{}").get("AllowFunnel") or {}
    except ValueError:
        return False
    return any(k.endswith(f":{FUNNEL_PORT}") and v for k, v in allow.items())


def ensure_on() -> str:
    s = _status()
    name = (s.get("DNSName") or "").rstrip(".")
    pre = _prereqs(s)
    if pre["missing"]:
        raise TunnelError(pre["missing"], pre["fix"], pre["enable_url"])
    p = _call("funnel", "--bg", "--yes", f"--https={FUNNEL_PORT}", f"http://127.0.0.1:{GUEST_PORT}")
    if p.returncode != 0:
        out = (p.stderr or p.stdout or "tailscale funnel falhou").strip()
        # A tailnet recusou o Funnel e o próprio tailscale imprimiu o link para liberar.
        if hit := _LOGIN_URL.search(p.stdout + p.stderr):
            raise TunnelError(["funnel"], _FIX_FUNNEL, hit.group(0).rstrip(".,;)"))
        raise TunnelError([], out)
    return f"https://{name}:{FUNNEL_PORT}"


def ensure_off() -> None:
    p = _call("funnel", f"--https={FUNNEL_PORT}", "off")
    out = p.stdout + p.stderr
    if p.returncode != 0 and "does not exist" not in out:
        raise TunnelError([], (p.stderr or "falha ao desligar o funnel").strip())


def sync(active: bool) -> None:
    try:
        on = _is_on()
    except TunnelError:
        # Sem tailscale e sem convite: nada a desligar, e o laço periódico não vira log por minuto.
        if active:
            raise
        return
    if active and not on:
        ensure_on()
    elif on and not active:
        ensure_off()
