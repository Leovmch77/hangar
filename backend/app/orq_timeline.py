"""A execução do orquestrador sem LLM lida dos arquivos dela: a entrada de cada linha da linha do
tempo no chat e o retrato do painel. Só leitura; arquivo que não se lê vira erro no retrato,
nunca exceção."""
from __future__ import annotations

import importlib.util
import json
import logging
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

from app import orq_conductor
from app.adapters.orq.runs import timeline_path  # noqa: F401  (reexportado: quem lê a linha do tempo pede daqui)

_log = logging.getLogger(__name__)

# O notify grava o Jev, envia (teto de 30 s no orq.py) e só então escreve a linha.
JEV_MATCH_S = 45
_TRIAGE = Path(__file__).resolve().parents[2] / "skills" / "orquestrar" / "scripts" / "orq_triage.py"
_lines = orq_conductor._lines   # nome próprio no módulo: o teste conta as leituras por ele

KINDS = ("advance", "woke", "would_drop", "dropped", "failed", "notice")
WOKE = re.compile(r"^acordou o árbitro: (.*)$", re.S)
WOULD = re.compile(r"^teria descartado \((jev|regex: [^)]*)\); acordou o árbitro: (.*)$", re.S)
DROPPED = re.compile(r"^recado registrado sem acordar o árbitro \((jev|regex: [^)]*)\): (.*)$", re.S)
# Um nível de parênteses dentro do motivo: "hangar-send x failed (rc=1): …".
NOT_DELIVERED = re.compile(r"^recado ao árbitro não entregue \(((?:[^()]|\([^()]*\))*)\): (.*)$", re.S)
ORCH_WOKE = ("lote de prova pronto", "todas as Tasks integradas")
MARK = re.compile(r"^\s*\[(aviso|decis[aã]o)\]\s*", re.I)
VIGIA = re.compile(r"^\s*\[vigia\]\s*", re.I)
HEAD = re.compile(r"^T(\d+)(?:\s+R(\d+)\s+reprovad[ao])?\s*:\s*")
PARECER = re.compile(r"\s*Parecer:\s*(/\S+?)[.,;)]*(?=\s|$)(?:\s*\([^)]*\))?")
# Quebra frase só antes de maiúscula: "??" no meio de código não termina frase.
SENTENCE = re.compile(r"(?<=[.!?])(?<!\?\?)\s+(?=[A-ZÀ-Ý\[`'\"(])")
QUESTION_END = re.compile(r"(?<!\?)\?$")
# ponytail: heurística de identificador (caminho com extensão, a.b, camelCase, f(x)); "e.g." vira código.
CODE = re.compile(
    r"(?<![^\s(\[\"'])((?:~?/)?(?:[\w.-]+/)*[\w.-]+\.(?:tsx?|svelte|py|rs|md|jsonl?|jsx?|kt|swift|sh|ps1)(?::\d+)?"
    r"|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?:\([^()\s]*\))?|[a-z]+[A-Z]\w*(?:\([^()\s]*\))?)(?=[\s,;:.)\]\"'(]|$)")
OPENED = re.compile(r"^T(\d+): abriu (.+) e entregou o kick-off$")
OPENED_WHO = re.compile(r"([^\s()]+) \(([^,()]+), ([^()]+)\)")
INTEGRATED = re.compile(r"^T(\d+) fechada → (merge → )?integração verde$")
DELIVERED = re.compile(r"^T(\d+) entregou a rodada (\d+)(?: · ([0-9a-f]+))?$")
RED_BACK = re.compile(r"^T(\d+): integração vermelha → devolvida ao executor (\S+)$")
RED_RETRY = re.compile(r"^T(\d+): integração vermelha, rodando de novo uma vez$")

_decide = None
_decide_tried = False


def _triage():
    """`orq_triage.decide`, carregado uma vez; None (e um log só) se o arquivo não carrega."""
    global _decide, _decide_tried
    if not _decide_tried:
        _decide_tried = True
        try:
            spec = importlib.util.spec_from_file_location("orq_triage", _TRIAGE)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _decide = mod.decide
        except Exception:
            _log.warning("orq_triage não carregou: a regra não aparece nas entradas", exc_info=True)
    return _decide


@dataclass
class RunFiles:
    dir: Path
    _jev_sig: tuple | None = None
    _jev_by_text: dict = field(default_factory=dict)
    _warned: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def _jev_index(self) -> dict:
        path = self.dir / "jev-shadow.jsonl"
        try:
            st = path.stat()
            sig = (st.st_mtime_ns, st.st_size)
        except FileNotFoundError:
            sig = None
        except OSError:
            sig = None
            if not self._warned:
                self._warned = True
                _log.warning("jev-shadow.jsonl ilegível: %s", path, exc_info=True)
        with self._lock:
            if sig != self._jev_sig:
                index: dict = {}
                rows = _lines(path) if sig else []
                if sig and sig[1] and not rows and not self._warned:
                    self._warned = True
                    _log.warning("jev-shadow.jsonl existe e não foi lido: %s", path)
                for line in rows:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(row, dict) or not isinstance(row.get("text"), str):
                        continue
                    when = orq_conductor._when(row.get("ts"))
                    if when is not None:
                        index.setdefault(row["text"], []).append((when, row))
                self._jev_by_text, self._jev_sig = index, sig
            return self._jev_by_text

    def jev_for(self, msg: str, when) -> dict | None:
        """O registro do Jev deste recado: mesmo texto (o orq grava os 500 primeiros caracteres)
        e gravado até JEV_MATCH_S antes da linha."""
        # ponytail: dois recados iguais na mesma janela pegam o registro mais recente.
        if when is None:
            return None
        best = None
        for w, row in self._jev_index().get(msg[:500], ()):
            if 0 <= (when - w).total_seconds() <= JEV_MATCH_S and (best is None or w > best[0]):
                best = (w, row)
        if best is None:
            return None
        row = best[1]
        raw = row.get("probs") if isinstance(row.get("probs"), dict) else {}
        probs = {str(k): n for k, v in raw.items() if (n := orq_conductor._num(v)) is not None}
        return {**orq_conductor._jev(row), "probs": probs}


_RUNS: dict[str, RunFiles] = {}


_RUNS_MAX = 16


def run_files(d: Path) -> RunFiles:
    key = str(d.resolve())
    run = _RUNS.get(key)
    if run is None:
        while len(_RUNS) >= _RUNS_MAX:
            _RUNS.pop(next(iter(_RUNS)), None)
        run = _RUNS.setdefault(key, RunFiles(d))
    return run


def _advance_line(text: str) -> tuple[dict | None, int | None]:
    if m := OPENED.match(text):
        who = [{"name": n, "provider": p, "model": mo} for n, p, mo in OPENED_WHO.findall(m.group(2))]
        return {"code": "opened", "sessions": who}, int(m.group(1))
    if m := INTEGRATED.match(text):
        return {"code": "integrated", "merge": m.group(2) is not None}, int(m.group(1))
    if m := DELIVERED.match(text):
        return {"code": "delivered", "round": int(m.group(2)), "commit": m.group(3)}, int(m.group(1))
    if m := RED_BACK.match(text):
        return {"code": "red_back", "executor": m.group(2)}, int(m.group(1))
    if m := RED_RETRY.match(text):
        return {"code": "red_retry"}, int(m.group(1))
    return None, None


def _split_question(body: str) -> tuple[str, str | None]:
    """A última frase que termina em pergunta sai do corpo e vira `question`."""
    cuts = list(SENTENCE.finditer(body))
    starts = [0] + [m.end() for m in cuts]
    ends = [m.start() for m in cuts] + [len(body)]
    for s, e in reversed(list(zip(starts, ends))):
        if QUESTION_END.search(body[s:e]):
            return (body[:s].rstrip() + " " + body[e:].lstrip()).strip(), body[s:e]
    return body, None


def _code(s: str) -> str:
    return CODE.sub(r"`\1`", s)


def _decided_by(source, rule=None, jev=None, regex=None, agreed=None) -> dict:
    return {"source": source, "rule": rule, "jev": jev, "regex": regex, "regex_agreed": agreed}


def entry(obj: dict, run: RunFiles | None) -> dict | None:
    """A leitura estruturada de uma linha da linha do tempo; None para linha sem texto."""
    text = obj.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    kind = obj.get("kind") if obj.get("kind") in KINDS else "notice"
    obj_task = orq_conductor._int(obj.get("task"))
    out = {"kind": kind, "task": obj_task, "line": None, "origin": None, "sender": None, "mark": None,
           "alarm": False, "rejected_round": None, "body": text, "question": None, "parecer": None,
           "error": None, "decided_by": None}

    if kind in ("advance", "notice"):
        out["line"], from_line = _advance_line(text)
        if out["task"] is None:
            out["task"] = from_line if from_line is not None else orq_conductor._task_of(text)
        return out

    why = err = None
    msg = text
    if m := WOULD.match(text) or DROPPED.match(text):
        why, msg = m.group(1), m.group(2)
    elif m := NOT_DELIVERED.match(text):
        err, msg = m.group(1), m.group(2)
    elif m := WOKE.match(text):
        msg = m.group(1)
    outside_wake_format = (kind == "failed" and err is None) or (kind == "woke" and not WOKE.match(text))

    if "from" in obj:
        origin = "notify"
    elif ((kind == "woke" and obj_task is not None) or msg.startswith(ORCH_WOKE) or outside_wake_format):
        origin = "orchestrator"
    else:
        origin = "notify"
    sender = obj.get("from") if isinstance(obj.get("from"), str) else None

    body = msg.strip()
    mark = None
    if m := MARK.match(body):
        mark = "decisao" if m.group(1).lower().startswith("decis") else None
        body = body[m.end():]
    alarm = bool(VIGIA.match(body))
    if alarm:
        body = VIGIA.sub("", body, count=1)
        sender = sender or "vigia"
    task, rejected = obj_task, None
    if m := HEAD.match(body):
        task = task if task is not None else int(m.group(1))
        rejected = int(m.group(2)) if m.group(2) else None
        body = body[m.end():]
    parecer = None
    if m := PARECER.search(body):
        parecer = m.group(1)
        body = body[:m.start()] + body[m.end():]
    body, question = _split_question(body.strip())
    if task is None:
        task = orq_conductor._task_of(text)

    decided = None
    if origin == "orchestrator" and kind != "failed":
        decided = _decided_by("rule", "orchestrator")
    elif origin == "notify" and kind != "failed":
        if mark:
            decided = _decided_by("rule", "mark")
        elif alarm:
            decided = _decided_by("alarm")
        else:
            jev = run.jev_for(msg, orq_conductor._when(obj.get("ts"))) if run else None
            usable = jev is not None and not jev.get("error")
            source = "regex" if ((why or "").startswith("regex") or (kind == "woke" and not usable)) else "jev"
            regex = None
            decide = _triage() if run else None
            if decide:
                verdict, category = decide(msg)
                regex = {"verdict": verdict, "category": category}
            agreed = (regex["verdict"] == "drop") == bool(jev["would_drop"]) if regex and usable else None
            decided = _decided_by(source, None, jev, regex, agreed)

    out.update(task=task, origin=origin, sender=sender, mark=mark, alarm=alarm, rejected_round=rejected,
               body=_code(body), question=_code(question) if question else None, parecer=parecer,
               error=err, decided_by=decided)
    return out
