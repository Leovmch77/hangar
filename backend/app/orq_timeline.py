"""A execução do orquestrador sem LLM lida dos arquivos dela: a entrada de cada linha da linha do
tempo no chat e o retrato do painel. Só leitura; arquivo que não se lê vira erro no retrato,
nunca exceção."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path

from app import costs, costs_claude_transcript, costs_sources, orq, orq_conductor, orq_start, pricing
from app.adapters.orq.runs import timeline_path  # noqa: F401  (reexportado: quem lê a linha do tempo pede daqui)
from app.config import list_config_dirs

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


def event_id(obj: dict) -> str:
    """O id da linha na conversa: o hash dela é o mesmo no tail, no /history e no painel."""
    return "orq:" + hashlib.sha1(json.dumps(obj, sort_keys=True).encode("utf-8")).hexdigest()[:16]


# ── retrato do painel ────────────────────────────────────────────────────────────────────────

_PANEL_FILES = ("jev-shadow.jsonl", "eventos.jsonl", "closed.jsonl", "checks.jsonl", "orq.json", "sessions.jsonl")
_PANELS: dict[str, tuple[tuple, dict, dict]] = {}
_panels_lock = threading.Lock()
_VERDICT = {"aprova": "approved", "corrige": "approved", "reprova": "rejected", "devolvido": "rejected"}


def _verdict(ev: dict) -> str | None:
    r = ev.get("resultado")
    return _VERDICT.get(r) if isinstance(r, str) else None


_OUTCOME = {"integrada": "green", "integracao_vermelha": "red", "conflito": "conflict",
            "advance_falhou": "failed"}


def _sig(p: Path):
    try:
        st = p.stat()
        return st.st_mtime_ns, st.st_size
    except OSError:
        return None


def _err(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"


def _read_jsonl(p: Path) -> tuple[list[dict], str | None]:
    """(objetos, erro): arquivo ausente não é erro; linha que não é objeto JSON é pulada."""
    try:
        # `replace`: meio caractere no fim (arquivo sendo escrito) não pode zerar o painel.
        text = p.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return [], None
    except OSError as e:
        return [], _err(e)
    rows = []
    for line in text.splitlines():
        try:
            v = json.loads(line)
        except ValueError:
            continue
        if isinstance(v, dict):
            rows.append(v)
    return rows, None


def _first_sentence(body: str) -> str:
    s = SENTENCE.split(body.replace("`", "").strip(), 1)[0].strip()
    return s if len(s) <= 160 else s[:159].rstrip() + "…"


def _decision_rows(entries: list[tuple[dict, dict]], evs: list[dict]) -> list[dict]:
    """Decisão do orquestrador que espera o árbitro: nenhuma entrega, veredito ou integração da
    mesma Task veio depois dela."""
    later: dict[int, list] = {}
    for ev in evs:
        if ev.get("tipo") in ("entrega", "veredito", "integrada") and isinstance(ev.get("task"), int):
            when = orq_conductor._when(ev.get("ts"))
            if when is not None:
                later.setdefault(ev["task"], []).append(when)
    out = []
    for obj, e in reversed(entries):
        orchestrator = e["origin"] == "orchestrator"
        asks = (e["kind"] in ("woke", "would_drop") and (e["mark"] == "decisao" or orchestrator)) or (
            e["kind"] == "failed" and orchestrator)
        if not asks or e["task"] is None:
            continue
        when = orq_conductor._when(obj.get("ts"))
        if when is not None and any(w > when for w in later.get(e["task"], ())):
            continue
        out.append({"task": e["task"], "ts": obj.get("ts"), "question": e["question"] or _first_sentence(e["body"]),
                    "parecer": e["parecer"], "event_id": event_id(obj)})
    return out


def _automation(cfg: dict, entries: list[tuple[dict, dict]], shadow: list[dict]) -> dict:
    woke = {"total": 0, "decisions": 0, "alarms": 0, "messages": 0}
    alone = {"total": 0, "opened": 0, "integrated": 0, "dropped": 0}
    dropped_by_jev = would_drop = by_rule = 0
    for _, e in entries:
        kind, orchestrator = e["kind"], e["origin"] == "orchestrator"
        if kind in ("woke", "would_drop") or (kind == "failed" and orchestrator):
            woke["total"] += 1
            woke["decisions" if e["mark"] or orchestrator else "alarms" if e["alarm"] else "messages"] += 1
        if kind == "would_drop":
            would_drop += 1
        code = (e["line"] or {}).get("code")
        if kind == "advance" and code in ("opened", "integrated"):
            alone[code] += 1
        elif kind == "dropped":
            alone["dropped"] += 1
            dropped_by_jev += (e["decided_by"] or {}).get("source") == "jev"
        by_rule += (e["decided_by"] or {}).get("source") in ("rule", "alarm")
    alone["total"] = alone["opened"] + alone["integrated"] + alone["dropped"]

    decide = _triage()
    judged = disagree = 0
    lowest = None
    for row in shadow:
        if row.get("error") or not isinstance(row.get("text"), str):
            continue
        judged += 1
        if decide and (decide(row["text"])[0] == "drop") != bool(row.get("would_drop")):
            disagree += 1
        probs = row.get("probs") if isinstance(row.get("probs"), dict) else {}
        choice = row.get("choice")
        p = orq_conductor._num(probs.get(choice)) if choice in probs else (
            orq_conductor._num(row.get("p")) if choice == "nothing" else None)
        if p is not None and (lowest is None or p < lowest["p"]):
            lowest = {"p": p, "choice": choice, "ts": row.get("ts"), "text": row["text"][:120]}
    return {"mode": {"jev": cfg.get("jev", "shadow"), "regex": cfg.get("regex", "shadow")},
            "woke": woke, "alone": alone, "dropped_by_jev": dropped_by_jev,
            "advanced": {"would_drop": would_drop, "disagree": disagree, "judged": judged,
                         "min_confidence": lowest, "by_rule": by_rule}}


def _task_rows(evs: list[dict], plan: list[dict], integrated: set[int]) -> list[dict]:
    """Uma linha por Task do plano e por Task que só existe nos eventos; o estado é o do último
    evento dela, e `round` a rodada desse evento."""
    titles = {t["n"]: t["title"] for t in plan}
    deciding: dict[int, tuple[str, int | None]] = {}
    for ev in evs:
        n, t = ev.get("task"), ev.get("tipo")
        if not isinstance(n, int):
            continue
        rnd = ev.get("rodada") if isinstance(ev.get("rodada"), int) else None
        titles.setdefault(n, "")
        if t == "task_inicio":
            titles[n] = titles[n] or ev.get("titulo") or ""
            deciding[n] = ("executing", None)
        elif t == "entrega":
            deciding[n] = ("in_review", rnd)
        elif t == "veredito" and _verdict(ev):
            deciding[n] = (_verdict(ev), rnd)
        elif t in ("integracao_vermelha", "conflito") or (t == "advance_falhou" and ev.get("passo") == "integrate"):
            deciding[n] = ("integration_red", None)
        elif t == "integrada":
            deciding[n] = ("integrated", None)
    rows = []
    for n in sorted(titles):
        state, rnd = deciding.get(n, ("integrated" if n in integrated else "queued", None))
        rows.append({"n": n, "title": titles[n], "state": state, "round": rnd})
    return rows


def _team(m, cfg: dict, st: dict, evs: list[dict]) -> list[dict]:
    """Quem trabalha na execução e o último passo de cada um: o árbitro atual primeiro, depois os
    anteriores, depois cada Task da mais nova para a mais antiga."""
    roles: dict[int, dict] = {}
    last: dict[str, dict] = {}
    slot: dict[str, tuple[int, str]] = {}
    arbiter, before = cfg.get("arbiter"), []
    for ev in evs:
        t, n, ts = ev.get("tipo"), ev.get("task"), ev.get("ts")
        rnd = ev.get("rodada") if isinstance(ev.get("rodada"), int) else None
        if t == "task_inicio":
            roles[n] = {"executor": ev.get("executor"), "par": ev.get("par")}
            for who in roles[n].values():
                if isinstance(who, str):
                    last[who] = {"code": "started", "round": None, "ts": ts}
        elif t == "entrega" and isinstance(who := roles.get(n, {}).get("executor"), str):
            last[who] = {"code": "delivered", "round": rnd, "ts": ts}
        elif t == "veredito" and isinstance(ev.get("sessao"), str) and _verdict(ev):
            last[ev["sessao"]] = {"code": _verdict(ev), "round": rnd, "ts": ts}
        elif t == "sessao_trocada":
            de, para = ev.get("de"), ev.get("para")
            if de == arbiter:
                before.append(de)
                arbiter = para
            for k, r in roles.items():
                for key in ("executor", "par"):
                    if r.get(key) == de:
                        r[key] = para
                        slot[de] = (k, "executor" if key == "executor" else "reviewer")
                        if isinstance(para, str):
                            last[para] = {"code": "swapped_in", "round": None, "ts": ts}
    rows = [{"name": st["arbiter"], "role": "arbiter", "task": None, "last": None, "current": True}]
    rows += [{"name": n, "role": "arbiter", "task": None, "last": None, "current": False}
             for n in reversed(before)]
    replaced: dict[int, list[dict]] = {}
    for de, _para in st["replaced"]:
        if de in slot:
            n, role = slot[de]
            replaced.setdefault(n, []).append(
                {"name": de, "role": role, "task": n, "last": last.get(de), "current": False})
    for n in sorted(st["roles"], reverse=True):
        for key, role in (("executor", "executor"), ("par", "reviewer")):
            who = st["roles"][n].get(key)
            # `par` também guarda a frase "subagente" ou a descrição de quem revisa: nome de sessão não tem espaço.
            if isinstance(who, str) and who.strip() and " " not in who and who != m.SUBAGENT:
                rows.append({"name": who, "role": role, "task": n, "last": last.get(who), "current": True})
        rows += replaced.get(n, [])
    seen: set[str] = set()
    return [r for r in rows if not (r["name"] in seen or seen.add(r["name"]))]


def _integration(m, evs: list[dict], closes: dict, checks: list[dict]) -> dict:
    begin = next((e for e in evs if e.get("tipo") == "execucao_inicio"), {})
    done = [e for e in evs if e.get("tipo") == "integrada"]
    last = done[-1] if done else None
    outcome = None
    if closes:
        n, close = list(closes.items())[-1]
        outcome = _OUTCOME.get(m._outcome(evs, n, close))
    red = [e for e in evs if e.get("tipo") == "integracao_vermelha" and isinstance(e.get("motivo"), str)]
    latest = {c["task"]: c for c in checks if isinstance(c.get("task"), int)}
    return {"branch": begin.get("branch"),
            "last": {"task": last.get("task"), "commit": str(last.get("commit") or "")[:7], "ts": last.get("ts")}
            if last else None,
            "outcome": outcome, "red_log": red[-1]["motivo"] if red else None,
            "delivery_checks": {"ok": sum(1 for c in latest.values() if c.get("ok")), "total": len(latest),
                                "failing": sorted(n for n, c in latest.items() if not c.get("ok"))}}


def panel(d: Path, live=None) -> dict:
    """Um retrato da execução, lido dos arquivos dela. O mesmo retrato serve enquanto nenhum
    arquivo muda; leitura que falha vira item de `errors`, nunca exceção. O consumo tem cache
    próprio (por tempo), porque muda sem que nenhum arquivo da execução mude."""
    key = str(d.resolve())
    plan_path = None
    try:
        plan_path = json.loads((d / "orq.json").read_text(encoding="utf-8")).get("plan")
    except (OSError, ValueError, AttributeError):
        pass
    sig = tuple(_sig(p) for p in (timeline_path(d), *(d / f for f in _PANEL_FILES),
                                  Path(plan_path).expanduser() if isinstance(plan_path, str) else d / "plan"))
    with _panels_lock:
        hit = _PANELS.get(key)
    if hit and hit[0] == sig:
        _, out, aux = hit
    else:
        out, aux = _build_panel(d)
        with _panels_lock:
            while len(_PANELS) >= _RUNS_MAX and key not in _PANELS:
                _PANELS.pop(next(iter(_PANELS)), None)
            _PANELS[key] = (sig, out, aux)
    out = _with_timing(out, aux, datetime.now().astimezone())
    names = [m["name"] for m in out["team"]]
    if not names and out["errors"]:
        # Time que falhou: sem nomes o consumo sairia zerado, e não se guarda; o erro próprio evita "calculando" eterno.
        return {**out, "errors": [*out["errors"], {"file": "consumption", "error": _NO_TEAM_ERROR}],
                "consumption": None}
    consumption, error = _consumption(d, names, aux, live)
    if error:
        return {**out, "errors": [*out["errors"], {"file": "consumption", "error": error}], "consumption": None}
    return {**out, "consumption": consumption}


def _timing_bounds(evs: list[dict]) -> dict:
    begin = next((e.get("ts") for e in evs if e.get("tipo") == "execucao_inicio"), None)
    end = orq._current_end([e for e in evs if "tipo" in e])
    tasks: dict[int, dict] = {}
    for ev in evs:
        n, kind = ev.get("task"), ev.get("tipo")
        if not isinstance(n, int) or isinstance(n, bool):
            continue
        task = tasks.setdefault(n, {"started_at": None, "finished_at": None})
        if kind == "task_inicio" and task["started_at"] is None:
            task["started_at"] = ev.get("ts")
        if kind == "integrada":
            task["finished_at"] = ev.get("ts")
        elif kind in ("task_inicio", "entrega", "veredito", "integracao_vermelha", "conflito") or (
            kind == "advance_falhou" and ev.get("passo") == "integrate"
        ):
            task["finished_at"] = None
    return {"started_at": begin, "finished_at": end.get("ts") if end else None, "tasks": tasks}


def _with_timing(out: dict, aux: dict, now: datetime) -> dict:
    """O relógio avança a cada leitura sem invalidar o cache dos arquivos."""
    bounds = aux["timing"]

    def timing(start, finish):
        first, last = orq_conductor._when(start), orq_conductor._when(finish)
        seconds = None
        if first is not None and (last is not None or finish is None):
            delta = ((last or now) - first).total_seconds()
            if delta >= 0:
                seconds = int(delta)
        return {"started_at": first.isoformat() if first else None,
                "finished_at": last.isoformat() if last else None, "elapsed_seconds": seconds}

    rows = []
    for row in out["tasks"]["rows"]:
        task = bounds["tasks"].get(row["n"], {})
        rows.append({**row, "timing": timing(task.get("started_at"),
                                             task.get("finished_at") or bounds["finished_at"])})
    return {**out, "timing": timing(bounds["started_at"], bounds["finished_at"]),
            "tasks": {**out["tasks"], "rows": rows}}


def _build_panel(d: Path) -> tuple[dict, dict]:
    m = orq_start._orq()
    errors: list[dict] = []

    def fail(file: str, error: str) -> None:
        if not any(e["file"] == file for e in errors):
            errors.append({"file": file, "error": error})

    def guard(fn, default, file: str, exact: bool = False):
        """Bloco que estoura vira item de `errors` e o resto do retrato sai igual. `exact`: o
        nome do bloco, não o do arquivo que o `OSError` cita."""
        try:
            return fn()
        except Exception as e:
            if not isinstance(e, (m.OrqError, OSError, ValueError)):
                _log.warning("orq_timeline: bloco %s falhou no painel", file, exc_info=True)
            name = file if exact else Path(getattr(e, "filename", None) or file).name
            fail(name, _err(e))
            return default

    cfg: dict = {}
    try:
        cfg = json.loads((d / "orq.json").read_text(encoding="utf-8"))
        if not isinstance(cfg, dict):
            raise ValueError("orq.json não é um objeto")
    except (OSError, ValueError) as e:
        cfg = {}
        fail("orq.json", _err(e))

    lines, err = _read_jsonl(timeline_path(d))
    if err:
        fail(timeline_path(d).name, err)
    evs, err = _read_jsonl(d / "eventos.jsonl")
    if err:
        fail("eventos.jsonl", err)
    shadow, err = _read_jsonl(d / "jev-shadow.jsonl")
    if err:
        fail("jev-shadow.jsonl", err)
    checks, err = _read_jsonl(d / "checks.jsonl")
    if err:
        fail("checks.jsonl", err)

    run = run_files(d)
    entries = []
    for obj in lines:
        try:
            if (e := entry(obj, run)) is not None:
                entries.append((obj, e))
        except Exception as ex:
            _log.warning("orq_timeline.entry falhou no painel", exc_info=True)
            fail(timeline_path(d).name, _err(ex))

    st = guard(lambda: m.state(d), None, "orq.json") if cfg else None
    closes = guard(lambda: m._closes(d), {}, "closed.jsonl")
    integrated = guard(lambda: {n for n, c in closes.items() if m._outcome(evs, n, c) == "integrada"},
                       set(), "tasks", exact=True)

    plan = None
    if isinstance(cfg.get("plan"), str):
        plan = guard(lambda: m.plan_tasks(m.plan_text(cfg["plan"])), None, "plan", exact=True)
    rows = guard(lambda: _task_rows(evs, plan or [], integrated), [], "tasks", exact=True)
    begin = next((e for e in evs if e.get("tipo") == "execucao_inicio"), {})
    aux = {"since": begin.get("ts"), "models": _opened_models(entries), "timing": _timing_bounds(evs)}
    return {
        "run": d.resolve().name, "gid": begin.get("gid") or "", "errors": errors,
        "empty": not lines and not any(e.get("tipo") == "task_inicio" for e in evs),
        "tasks": {"integrated": sum(r["state"] == "integrated" for r in rows),
                  "total": len(plan) if plan is not None else max((r["n"] for r in rows), default=0),
                  "total_known": plan is not None, "rows": rows},
        "team": guard(lambda: _team(m, cfg, st, evs), [], "team", exact=True) if st else [],
        "decisions": guard(lambda: _decision_rows(entries, evs), [], "decisions", exact=True),
        "automation": guard(lambda: _automation(cfg, entries, shadow), _no_automation(cfg), "automation",
                            exact=True),
        "consumption": None,
        "integration": guard(lambda: _integration(m, evs, closes, checks), _NO_INTEGRATION, "integration",
                             exact=True),
    }, aux


_NO_TEAM_ERROR = "sem o time não há como somar o consumo"

_NO_INTEGRATION = {"branch": None, "last": None, "outcome": None, "red_log": None,
                   "delivery_checks": {"ok": 0, "total": 0, "failing": []}}


def _no_automation(cfg: dict) -> dict:
    return {"mode": {"jev": cfg.get("jev", "shadow"), "regex": cfg.get("regex", "shadow")},
            "woke": {"total": 0, "decisions": 0, "alarms": 0, "messages": 0},
            "alone": {"total": 0, "opened": 0, "integrated": 0, "dropped": 0}, "dropped_by_jev": 0,
            "advanced": {"would_drop": 0, "disagree": 0, "judged": 0, "min_confidence": None, "by_rule": 0}}


def _opened_models(entries: list[tuple[dict, dict]]) -> dict[str, str]:
    """Modelo que cada sessão abriu, dito na linha "abriu …": serve a quem o transcript não nomeia."""
    out: dict[str, str] = {}
    for _, e in entries:
        line = e["line"] or {}
        if line.get("code") == "opened":
            out.update({s["name"]: s["model"] for s in line["sessions"]})
    return out


# ── consumo ──────────────────────────────────────────────────────────────────────────────────

CONSUMPTION_TTL_S = 60
_UNAVAILABLE_TTL_S = 5     # transcript que não pôde ser lido agora: tenta de novo logo
_CONSUMPTION: dict[str, tuple[float, dict | None, str | None, bool]] = {}
_consumption_locks: dict[str, threading.Lock] = {}
_consumption_guard = threading.Lock()


def _exists(p: str) -> bool:
    return Path(p).is_file()


def _find_rollout(codex_home: str | None, thread_id: str) -> str | None:
    """Rollout do Codex pelo id da thread; nasce no primeiro turno, então só existe depois."""
    for home in ([codex_home] if codex_home else []) + [str(costs_sources.raiz_codex().parent)]:
        hit = next(Path(home).glob(f"sessions/**/rollout-*-{thread_id}.jsonl"), None)
        if hit:
            return str(hit)
    return None


def _find_claude(config_dir: str | None, session_id: str) -> str | None:
    dirs = [config_dir] if config_dir else [c.path for c in list_config_dirs(ordered=False)]
    for cd in dirs:
        hit = next(Path(cd, "projects").glob(f"*/{session_id}.jsonl"), None)
        if hit:
            return str(hit)
    return None


_WARNED_PROVIDERS: set[str] = set()


def _rows_for(provider: str, path: str) -> list | None:
    """Linhas de custo de um transcript, com os subagentes do Claude (`<sessão>/subagents/*.jsonl`).
    `None` = o transcript não pôde ser lido agora (índice ocupado, arquivo sumido ou provider sem leitor)."""
    p = Path(path)
    if provider == "claude":
        subs = sorted((p.parent / p.stem / "subagents").glob("*.jsonl"))
        parts = [costs_claude_transcript.custos_do_transcript(f) for f in (p, *subs)]
        return None if any(x is None for x in parts) else [r for x in parts for r in x]
    if provider == "codex":
        return costs_sources.custos_do_rollout(p)
    if provider in ("pi", "omp"):
        raiz = costs_sources.raiz_pi() if provider == "pi" else costs_sources.raiz_omp()
        return costs_sources._linhas_arquivo_pi(p, raiz, provider)
    if provider == "kimi":
        return costs_sources._linhas_wire_kimi(p)
    # Provider sem leitor não é "zero gasto": sobe como transcript indisponível.
    if provider not in _WARNED_PROVIDERS:
        _WARNED_PROVIDERS.add(provider)
        _log.warning("orq_timeline: no cost reader for provider %r (%s)", provider, path)
    return None


def _team_paths(d: Path, names: list[str], live) -> dict[str, list[tuple[str, str]]]:
    """Nome do time -> [(provider, caminho do transcript)]: `sessions.jsonl` (a última linha do
    nome vence), `medicao/*.json` e a sessão viva de mesmo nome; caminho repetido entra uma vez."""
    found: dict[str, dict[str, str]] = {n: {} for n in names}

    def add(name: str, provider: str, path: str | None) -> None:
        if name in found and path:
            found[name].setdefault(os.path.realpath(path), provider)

    last: dict[str, dict] = {}
    for row in _read_jsonl(d / "sessions.jsonl")[0]:
        if isinstance(row.get("name"), str):
            last[row["name"]] = row
    for name, row in last.items():
        if row.get("provider") == "claude" and row.get("session_id"):
            add(name, "claude", _find_claude(row.get("config_dir"), row["session_id"]))
        elif row.get("provider") == "codex" and row.get("thread_id"):
            add(name, "codex", _find_rollout(row.get("codex_home"), row["thread_id"]))
    for f in sorted((d / "medicao").glob("*.json")):
        try:
            snap = json.loads(f.read_text(encoding="utf-8"))
            path = snap["source"]["path"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if isinstance(snap.get("session"), str) and isinstance(path, str) and _exists(path):
            add(snap["session"], str(snap.get("provider") or ""), path)
    for s in (live() if live else []):
        add(s.name, s.provider, s.jsonl)     # a sessão viva traz o arquivo atual, também depois de um /clear
    return {n: [(p, path) for path, p in paths.items()] for n, paths in found.items()}


def _medicao_models(d: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for f in sorted((d / "medicao").glob("*.json")):
        try:
            snap = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(snap.get("session"), str) and snap.get("model_observed"):
                out[snap["session"]] = str(snap["model_observed"])
        except (OSError, ValueError, AttributeError):
            continue
    return out


def _compute_consumption(d: Path, names: list[str], aux: dict, live) -> tuple[dict, bool]:
    """(consumo, houve transcript indisponível): quem não pôde ser lido conta em `missing`."""
    since = orq_conductor._when(aux.get("since"))
    paths = _team_paths(d, names, live)
    hints = {**aux["models"], **_medicao_models(d)}
    seen: dict[str, bool] = {}     # caminho -> foi lido (dois nomes no mesmo arquivo somam uma vez)
    groups: dict[tuple[str, str], dict] = {}
    missing_prices: set[str] = set()
    subagents = False
    readable: set[str] = set()
    for name in names:
        for provider, path in paths.get(name, ()):
            if path in seen:
                if seen[path]:
                    readable.add(name)
                continue
            rows = _rows_for(provider, path)
            seen[path] = rows is not None
            if rows is None:
                continue
            readable.add(name)
            for row in rows:
                subagents = subagents or bool(row.subagente)
                # Claude: `ts` é a 1ª resposta do dia (no fuso do balde), então o corte é por dia nesse fuso e inclui o dia inteiro do início.
                if since is not None and (
                        row.ts.astimezone(costs_claude_transcript.LOCAL).date()
                        < since.astimezone(costs_claude_transcript.LOCAL).date()
                        if row.source == "claude" else row.ts < since):
                    continue
                if not row.model and hints.get(name):
                    row = replace(row, model=hints[name])
                cost = costs._custo_da_linha(row)
                model = pricing.canonizar(row.model) or "unknown"
                g = groups.setdefault((row.source, model), {"names": set(), "new": 0, "cache_read": 0, "usd": 0.0})
                g["names"].add(name)
                g["new"] += row.input + row.output + row.cache_write
                g["cache_read"] += row.cache_read
                if cost is None:
                    missing_prices.add(model)
                else:
                    g["usd"] += sum(cost.values())
    by_provider: dict[str, list] = {}
    for (source, model), g in groups.items():
        by_provider.setdefault(source, []).append({"model": model, **g})
    providers = []
    for source, models in by_provider.items():
        models.sort(key=lambda g: (-g["usd"], g["model"]))
        providers.append({
            "provider": source, "sessions": len(set().union(*(g["names"] for g in models))),
            "new": sum(g["new"] for g in models), "cache_read": sum(g["cache_read"] for g in models),
            "usd": round(sum(g["usd"] for g in models), 4),
            "models": [{"model": g["model"], "sessions": len(g["names"]), "new": g["new"],
                        "cache_read": g["cache_read"], "usd": round(g["usd"], 4)} for g in models]})
    providers.sort(key=lambda p: (-p["usd"], p["provider"]))
    return {
        "computed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "since": aux.get("since"),
        "sessions": {"team": len(names), "measured": len(readable),
                     "missing": [n for n in names if n not in readable]},
        "totals": {"new": sum(p["new"] for p in providers), "cache_read": sum(p["cache_read"] for p in providers),
                   "usd": round(sum(p["usd"] for p in providers), 4), "usd_partial": bool(missing_prices)},
        "providers": providers, "missing_prices": sorted(missing_prices), "subagents": subagents,
    }, any(paths.get(n) and n not in readable for n in names)


def _consumption(d: Path, names: list[str], aux: dict, live) -> tuple[dict | None, str | None]:
    """(consumo, erro), refeito depois de `CONSUMPTION_TTL_S` (`_UNAVAILABLE_TTL_S` se algum
    transcript não pôde ser lido). Ninguém espera a soma: o pedido devolve o último valor guardado,
    mesmo vencido, ou `None` (calculando) se ainda não houve nenhum, e o cálculo roda numa thread."""
    key = str(d.resolve())
    with _consumption_guard:
        lock = _consumption_locks.get(key)
        if lock is None:
            while len(_consumption_locks) >= _RUNS_MAX:
                old = next(iter(_consumption_locks))
                _consumption_locks.pop(old)
                _CONSUMPTION.pop(old, None)
            lock = _consumption_locks.setdefault(key, threading.Lock())
        hit = _CONSUMPTION.get(key)
    if hit and time.monotonic() - hit[0] < (_UNAVAILABLE_TTL_S if hit[3] else CONSUMPTION_TTL_S):
        return hit[1], hit[2]
    stale = (hit[1], hit[2]) if hit else (None, None)
    if not lock.acquire(blocking=False):
        return stale

    def run() -> None:
        try:
            fresh = _CONSUMPTION.get(key)     # quem tinha a trava pode ter acabado entre a leitura e o acquire
            if fresh and time.monotonic() - fresh[0] < (_UNAVAILABLE_TTL_S if fresh[3] else CONSUMPTION_TTL_S):
                return
            try:
                value, unavailable = _compute_consumption(d, names, aux, live)
                error = None
            except Exception as e:
                _log.warning("orq_timeline: consumption failed", exc_info=True)
                value, error, unavailable = None, _err(e), False
            _CONSUMPTION[key] = (time.monotonic(), value, error, unavailable)
        finally:
            lock.release()

    # A soma lê transcripts grandes: nunca dentro do pedido. Uma thread por execução (a trava).
    try:
        threading.Thread(target=run, name="orq-consumption", daemon=True).start()
    except Exception as e:
        lock.release()
        _log.warning("orq_timeline: consumption thread did not start", exc_info=True)
        _CONSUMPTION[key] = (time.monotonic(), None, _err(e), True)     # tenta de novo logo
        return None, _err(e)
    return stale
