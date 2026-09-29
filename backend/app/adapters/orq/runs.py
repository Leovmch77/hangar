"""Orquestrações `auto` vivas como linhas da lista: uma por execução, sem pane nem processo.

Só leitura: `orq.json` (marca `auto`), `eventos.jsonl` (execução encerrada sai da lista) e o
batimento do vigia (vigia parado sai). A conversa da linha é `timeline-<pasta>.jsonl`: o id do
SSE é o nome do arquivo, e `eventos.jsonl` se repete entre execuções.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from app import orq, orq_conductor

ACTIVE_S = 120

_log = logging.getLogger(__name__)


def root() -> Path:
    return orq.raiz_padrao()


def timeline_path(d: Path) -> Path:
    # Mesmo nome que o orq.py grava: a pasta resolvida, também quando a execução é um symlink.
    return d / f"timeline-{d.resolve().name}.jsonl"


def _text(v) -> str | None:
    return v if isinstance(v, str) and v else None


def _auto_run(d: Path, strict: bool = False) -> tuple[dict, str, bool] | None:
    """(orq.json, gid, encerrada) de uma execução `auto` com início gravado. `strict`: falha de
    leitura sobe como OSError em vez de passar por "não é execução"."""
    try:
        cfg = json.loads((d / "orq.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, NotADirectoryError, ValueError):
        return None
    except OSError:
        if strict:
            raise
        return None
    if not isinstance(cfg, dict) or cfg.get("auto") is not True:
        return None
    eventos = orq._le_eventos(d / "eventos.jsonl", strict=strict)
    gid = next((_text(e.get("gid")) for e in eventos if e["tipo"] == "execucao_inicio"), None)
    return (cfg, gid, orq._current_end(eventos) is not None) if gid else None


def group_phase(gid: str) -> str | None:
    """"live" / "ended" para a execução `auto` do grupo, None sem execução iniciada, "unknown"
    quando alguma execução não pôde ser lida: ela pode ser a deste grupo, e quem desfaz o grupo
    não decide no escuro. O vigia fica de fora: o reinício dele deixa uma janela sem batimento
    com a execução viva."""
    try:
        dirs = sorted(root().iterdir())
        runs = [r for d in dirs if (r := _auto_run(d, strict=True))]
    except FileNotFoundError:
        return None
    except OSError as e:
        _log.warning("orq: execuções ilegíveis, grupo %s mantido: %s", gid, e)
        return "unknown"
    fases = {r[2] for r in runs if r[1] == gid}
    return "live" if False in fases else "ended" if fases else None


def _active_run(d: Path) -> dict | None:
    run = _auto_run(d)
    if not run or run[2]:
        return None
    cfg, gid, _ = run
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


def _held(lock: Path) -> bool:
    """Trava presa por alguém, lida em /proc/locks: pegar a trava para testar faria um `advance`
    que está começando desistir. Fora do Linux fica só a regra do mtime."""
    try:
        ino = lock.stat().st_ino
        locks = Path("/proc/locks").read_text(encoding="ascii", errors="replace")
    except OSError:
        return False
    return any(len(f := l.split()) > 5 and f[1] == "FLOCK" and f[5].endswith(f":{ino}")
               for l in locks.splitlines())


def activity(timeline: str) -> tuple[str, float | None]:
    """(estado, última atividade): trabalhando com a trava do `advance` presa (merge e
    `Integração:` passam de ACTIVE_S), ou se ela ou a linha do tempo mudaram nos últimos ACTIVE_S."""
    lock = Path(timeline).parent / "advance.lock"
    marks = []
    for p in (Path(timeline), lock):
        try:
            marks.append(p.stat().st_mtime)
        except OSError:
            pass
    last = max(marks, default=None)
    busy = _held(lock) or (last is not None and time.time() - last < ACTIVE_S)
    return ("working" if busy else "idle"), last
