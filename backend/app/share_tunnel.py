"""Funnel (internet) SÓ para a porta do convidado, ligado enquanto houver convite ativo.

A 443 é o `tailscale serve` do dono (só tailnet) e a 10000 é a prévia de porta (tunnel.py); o
Funnel aceita 443/8443/10000, então a 8443 é a que sobra.
"""
from __future__ import annotations

import getpass
import json

from app import tunnel

GUEST_PORT = 8766
FUNNEL_PORT = 8443

_FIX_OPERATOR = "sudo tailscale set --operator=$USER"
_FIX_FUNNEL = ("libere o Funnel na política da tailnet (nodeAttrs \"funnel\"): "
               "https://login.tailscale.com/admin/acls/file")


class TunnelError(Exception):
    def __init__(self, missing: list[str], fix: str):
        super().__init__(fix)
        self.missing = missing
        self.fix = fix


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
    faltam = _missing(s)
    if faltam:
        fixes = {"operator": _FIX_OPERATOR, "funnel": _FIX_FUNNEL}
        raise TunnelError(faltam, "\n".join(fixes[f] for f in faltam))
    p = _call("funnel", "--bg", "--yes", f"--https={FUNNEL_PORT}", f"http://127.0.0.1:{GUEST_PORT}")
    if p.returncode != 0:
        raise TunnelError([], (p.stderr or p.stdout or "tailscale funnel falhou").strip())
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
