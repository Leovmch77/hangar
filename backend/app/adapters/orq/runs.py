"""Orquestrações `auto` vivas como linhas da lista: uma por execução, sem pane nem processo.

Só leitura: `orq.json` (marca `auto`), `eventos.jsonl` (execução encerrada sai da lista) e o
batimento do vigia (vigia parado sai). A conversa da linha é `timeline-<pasta>.jsonl`: o id do
SSE é o nome do arquivo, e `eventos.jsonl` se repete entre execuções.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from app import orq, orq_conductor

ACTIVE_S = 120


def root() -> Path:
    return orq.raiz_padrao()


def timeline_path(d: Path) -> Path:
    return d / f"timeline-{d.name}.jsonl"


def _text(v) -> str | None:
    return v if isinstance(v, str) and v else None


def _active_run(d: Path) -> dict | None:
    try:
        cfg = json.loads((d / "orq.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(cfg, dict) or cfg.get("auto") is not True:
        return None
    eventos = orq._le_eventos(d / "eventos.jsonl")
    gid = next((_text(e.get("gid")) for e in eventos if e["tipo"] == "execucao_inicio"), None)
    if not gid or orq._current_end(eventos) is not None:
        return None
    # Sem systemctl (units=None): isto roda a cada varredura da lista, e o batimento basta.
    wd = orq_conductor.watchdog(d, None)
    if not wd["alive"]:
        return None
    return {"name": f"{gid}-orq", "gid": gid, "repo": _text(cfg.get("repo")),
            "arbiter": _text(wd.get("arbiter")) or _text(cfg.get("arbiter")),
            "timeline": str(timeline_path(d))}


def active() -> list[dict]:
    try:
        dirs = sorted(root().iterdir())
    except OSError:
        return []
    return [r for d in dirs if (r := _active_run(d))]


def find(name: str) -> dict | None:
    if not name.endswith("-orq"):
        return None
    return next((r for r in active() if r["name"] == name), None)


def activity(timeline: str) -> tuple[str, float | None]:
    """(estado, última atividade): trabalhando se a linha do tempo ou a trava do `advance`
    mudaram nos últimos ACTIVE_S."""
    marks = []
    for p in (Path(timeline), Path(timeline).parent / "advance.lock"):
        try:
            marks.append(p.stat().st_mtime)
        except OSError:
            pass
    last = max(marks, default=None)
    return ("working" if last is not None and time.time() - last < ACTIVE_S else "idle"), last
