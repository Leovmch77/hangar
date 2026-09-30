"""OrqAdapter: o orquestrador sem LLM como sessão só de leitura.

Não há pane nem processo: a conversa é a linha do tempo da execução (uma frase por passo) e o
estado sai da atividade dela. Entrada nenhuma chega aqui: a API recusa antes (`erro_sessao_orq`).
"""
import asyncio
import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator, Callable

from app import orq_timeline
from app.adapters.orq import runs
from app.state import StateEvent
from app.transcript import ChatEvent, TranscriptTailer

POLL_S = 2.0
_log = logging.getLogger(__name__)


def parse_obj(obj: dict, run_dir: Path | None = None) -> list[ChatEvent]:
    text = obj.get("text")
    if not isinstance(text, str) or not text.strip():
        return []
    try:
        ts = datetime.fromisoformat(obj.get("ts")).timestamp()
    except (TypeError, ValueError):
        ts = None
    # A linha não tem id: o hash dela é o mesmo no tail e no /history, e o cliente junta por id.
    key = json.dumps(obj, sort_keys=True).encode("utf-8")
    # Exceção aqui mataria o tail da sessão inteira: a linha segue como notice cru.
    try:
        orq = orq_timeline.entry(obj, orq_timeline.run_files(run_dir) if run_dir else None)
    except Exception:
        _log.warning("orq_timeline.entry falhou", exc_info=True)
        orq = None
    return [ChatEvent(kind="notice", id=f"orq:{hashlib.sha1(key).hexdigest()[:16]}", text=text, ts=ts, orq=orq)]


def line_parser(run_dir: Path | None) -> Callable[[str], list[ChatEvent]]:
    def parse_line(line: str) -> list[ChatEvent]:
        try:
            obj = json.loads(line)
        except ValueError:
            return []   # linha pela metade: o tailer relê quando ela fechar
        return parse_obj(obj, run_dir) if isinstance(obj, dict) else []
    return parse_line


parse_line = line_parser(None)


class OrqAdapter:
    provider = "orq"

    def transcript_stream(self, path: str, start_offset: int | None = None) -> AsyncIterator[ChatEvent]:
        return TranscriptTailer(path, parse_line=line_parser(Path(path).parent)).follow(start_offset)

    def state_monitor(self, name: str, sid_get: Callable[[], str],
                      transcript_get: Callable[[], str | None] | None = None) -> AsyncIterator[StateEvent]:
        return self._states(name, transcript_get or (lambda: None))

    async def _states(self, name: str, transcript_get: Callable[[], str | None]) -> AsyncIterator[StateEvent]:
        prev = None
        while True:
            path = transcript_get()
            state = (await asyncio.to_thread(runs.activity, path))[0] if path else "idle"
            if state != prev:
                prev = state
                yield StateEvent(session=name, state=state)
            await asyncio.sleep(POLL_S)

    async def drain(self, name: str, path: str) -> int:
        return 0   # nada entra na fila: a API recusa a entrada

    async def send_prompt(self, name: str, text: str) -> str:
        raise RuntimeError("orq: o orquestrador não recebe entrada")

    async def deliverable(self, name: str) -> bool:
        return False

    def spawn_command(self, cwd: str, session_id: str,
                      model: str | None = None, effort: str | None = None,
                      permission_mode: str | None = None) -> list[str]:
        raise RuntimeError("orq: a linha nasce do `orq init --auto`, não do Hangar")

    def transcript_path(self, cwd: str, session_id: str) -> str:
        raise RuntimeError("orq: a linha do tempo vem de runs.active()")
