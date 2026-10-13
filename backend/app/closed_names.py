"""Nome que a sessão tinha no Hangar quando foi fechada, por transcript.

O transcript não guarda o nome da sessão, e o resume nasce com o nome da pasta: sem este registro,
"reabre a auditoria-migracao" não acha a conversa fechada. Um escritor só (este processo).
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from app import atomico
from app.config import _backend_config_base

_log = logging.getLogger(__name__)

_FILE = "closed-sessions.json"
# ponytail: teto fixo; as mais antigas saem. A lista de recentes só mostra até 100.
_KEEP = 500
_path_override: Path | None = None
_lock = threading.Lock()


def _path() -> Path:
    return _path_override or Path(_backend_config_base()) / _FILE


def _set_aside(path: Path) -> None:
    """Guarda o arquivo ilegível ao lado (`.bad`, `.bad.2`…) antes da gravação nova apagar o que ele tinha."""
    dest, i = path.with_name(path.name + ".bad"), 2
    while dest.exists():
        dest, i = path.with_name(f"{path.name}.bad.{i}"), i + 1
    try:
        os.replace(path, dest)
        _log.warning("closed names unreadable, moved to %s", dest.name)
    except OSError as e:
        _log.warning("closed names unreadable and not moved aside: %s", e)


def _load(set_aside: bool = False) -> dict[str, dict]:
    """`set_aside`: quem vai gravar move o arquivo ilegível para o lado em vez de sobrescrevê-lo."""
    path = _path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        _log.warning("closed names unreadable, starting empty: %s", e)
        raw = None
    if isinstance(raw, dict):
        return raw
    if set_aside:
        _set_aside(path)
    return {}


def record(jsonl: str, name: str, now: float | None = None) -> None:
    """Guarda `name` para o transcript `jsonl` (caminho real); o fechamento mais novo vence."""
    key = os.path.realpath(jsonl)
    with _lock:
        data = _load(set_aside=True)
        data[key] = {"name": name, "closed_at": time.time() if now is None else now}
        if len(data) > _KEEP:
            keep = sorted(data.items(), key=lambda kv: kv[1].get("closed_at") or 0, reverse=True)[:_KEEP]
            data = dict(keep)
        dest = _path()
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(dest.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            atomico.substituir(tmp, dest)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


def names() -> dict[str, str]:
    """Caminho real do transcript → nome da sessão fechada."""
    with _lock:
        data = _load()
    return {k: v["name"] for k, v in data.items() if isinstance(v, dict) and isinstance(v.get("name"), str)}
