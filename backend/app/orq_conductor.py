"""Painel do condutor da orquestração: o vigia está vivo? o que passou pelo `orq`?

O watchdog é compartilhado pela lista e pelo fato interno do condutor. O feed de registro,
sombra e eventos é montado somente no Rust. Os auxiliares de leitura ainda servem à timeline.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

_log = logging.getLogger(__name__)

SYSTEMCTL_TIMEOUT_S = 3
# O mesmo VETO_P de skills/orquestrar/scripts/orq.py: veto acima dele manteve o árbitro acordado.
JEV_VETO_P = 0.40
_TASK = re.compile(r"\bT(\d+)\b|\bTask (\d+)\b")
_EXEC_DIR = re.compile(r"(?:^|\s)(?:-e|--eventos)\s+(\S+)")


def _when(v) -> datetime | None:
    # Linha antiga sem fuso vira hora local: naive contra aware levantaria no sort.
    # Data na borda do calendário estoura na conversão: a linha é pulada, nunca um 500.
    try:
        return datetime.fromisoformat(str(v)).astimezone()
    except (ValueError, OverflowError):
        return None


def _num(v) -> float | None:
    # NaN do Jev iria pro JSON, e o Starlette recusa NaN com 500.
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return float(v)


def _int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _lines(p: Path) -> list[str]:
    try:
        return p.read_text(encoding="utf-8", errors="replace").splitlines()
    except (OSError, ValueError):
        return []


def _task_of(text: str) -> int | None:
    m = _TASK.search(text)
    return int(m.group(1) or m.group(2)) if m else None


def _jev(r: dict) -> dict:
    raw = r.get("veto") if isinstance(r.get("veto"), dict) else {}
    veto = {str(k): _num(v) for k, v in raw.items()}
    return {"mode": r.get("mode"), "choice": r.get("choice"), "p": _num(r.get("p")), "veto": veto,
            # Valor ilegível conta como veto que segurou, como no orq (NaN nunca descarta).
            "held": [k for k, v in veto.items() if v is None or v > JEV_VETO_P],
            "would_drop": r.get("would_drop"), "error": r.get("error")}


def _pid_alive(pid) -> bool:
    # Só no Linux: no Windows o os.kill(pid, 0) MATA o processo, e aqui basta o /proc.
    if sys.platform != "linux" or isinstance(pid, bool) or not isinstance(pid, int):
        return True
    return Path(f"/proc/{pid}").exists()


def _heartbeat(d: Path) -> dict | None:
    try:
        hb = json.loads((d / "vigia.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return hb if isinstance(hb, dict) and _when(hb.get("ts")) else None


def _since(v) -> str | None:
    m = re.fullmatch(r"@(\d+)", v or "")
    return datetime.fromtimestamp(int(m.group(1))).astimezone().isoformat(timespec="seconds") if m else None


def units() -> dict[str, dict] | None:
    """Unidades `vigia-*` pela pasta do `-e <dir>` no ExecStart; None = não há systemd pra
    perguntar. Pasta, unidade e grupo têm nomes diferentes, então a chave é o caminho."""
    if sys.platform != "linux" or not shutil.which("systemctl"):
        return None
    try:
        r = subprocess.run(
            ["systemctl", "--user", "show", "vigia-*", "--timestamp=unix",
             "-p", "Id,ExecStart,ActiveState,ActiveEnterTimestamp,NRestarts"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=SYSTEMCTL_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        _log.warning("orq: systemctl não respondeu (%s); condutor só pelo batimento", e)
        return None
    if r.returncode != 0:
        _log.warning("orq: systemctl show saiu %s: %s", r.returncode, (r.stderr or "").strip()[:200])
        return None
    out: dict[str, dict] = {}
    for bloco in r.stdout.split("\n\n"):
        props = dict(l.split("=", 1) for l in bloco.splitlines() if "=" in l)
        m = _EXEC_DIR.search(props.get("ExecStart", ""))
        if not m:
            continue
        key = os.path.normpath(os.path.expanduser(m.group(1)))
        # Duas unidades na mesma pasta (rearmada com outro nome): vale a que está no ar.
        if out.get(key, {}).get("ActiveState") != "active":
            out[key] = props
    return out


def watchdog(d: Path, units: dict[str, dict] | None, now: datetime | None = None) -> dict:
    now = now or datetime.now().astimezone()
    hb = _heartbeat(d)
    u = units.get(os.path.normpath(str(d))) if units is not None else None
    state = u.get("ActiveState") if u else None
    if hb:
        iv = hb.get("interval_s")
        iv = iv if isinstance(iv, int) and not isinstance(iv, bool) and iv >= 0 else 60
        fresh = now - _when(hb["ts"]) <= timedelta(seconds=2 * iv + 30)
        # Unidade parada ou processo do batimento já morto não esperam o batimento envelhecer.
        alive = fresh and state in (None, "active", "activating") and _pid_alive(hb.get("pid"))
        source = "heartbeat"
    elif u:
        alive, source = state == "active", "systemd"
    else:
        alive, source = False, ("none" if units is not None else "unavailable")
    watching = hb.get("watching") if hb else None
    return {
        "alive": bool(alive),
        "last_cycle": str(hb["ts"]) if hb else None,
        "since": _since(u.get("ActiveEnterTimestamp")) if u else None,
        "restarts": _int(u.get("NRestarts")) if u else None,
        "unit": u["Id"].removesuffix(".service") if u and u.get("Id") else (hb or {}).get("unit"),
        "unit_state": state,
        "arbiter": (hb or {}).get("arbiter"),
        "watching": [str(w) for w in watching] if isinstance(watching, list) else [],
        "source": source,
    }
