import json
import shutil
from datetime import timedelta
from pathlib import Path

import pytest

from app import orq_timeline as ot
from app import pqueue
from app.adapters.orq import adapter

FIX = Path(__file__).parent / "fixtures" / "orq"
PARECER = "/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/pareceres/task-4-r1-revisor.md"


@pytest.fixture
def real(tmp_path):
    d = tmp_path / "2026-09-29-cad3e6fe"          # o nome da pasta dá o nome da linha do tempo
    shutil.copytree(FIX / "2026-09-29-cad3e6fe", d)
    cfg = json.loads((d / "orq.json").read_text())
    (d / "orq.json").write_text(json.dumps({**cfg, "plan": str(d / "plan.orq.md")}))
    return d


@pytest.fixture
def synth(tmp_path):
    d = tmp_path / "synthetic"
    shutil.copytree(FIX / "synthetic", d)
    return d


def lines(d):
    return [json.loads(l) for l in ot.timeline_path(d).read_text().splitlines() if l.strip()]


def entries(d):
    run = ot.run_files(d)
    return [ot.entry(o, run) for o in lines(d)]


def test_real_fixture_has_the_cut_run(real):
    assert len(lines(real)) == 13


def test_opened_line(real):
    e = entries(real)[0]
    assert e["kind"] == "advance" and e["task"] == 1
    assert e["line"] == {"code": "opened", "sessions": [
        {"name": "w-t1", "provider": "claude", "model": "opus[1m]"},
        {"name": "w-review1", "provider": "claude", "model": "opus[1m]"}]}
    assert e["origin"] is None and e["decided_by"] is None


def test_integrated_line_with_and_without_merge(real):
    assert entries(real)[2]["line"] == {"code": "integrated", "merge": True}
    obj = {**lines(real)[2], "text": "T1 fechada → integração verde"}
    assert ot.entry(obj, None)["line"] == {"code": "integrated", "merge": False}


def test_vigia_alarm(real):
    e = entries(real)[1]
    assert e["kind"] == "woke" and e["origin"] == "notify" and e["alarm"] is True
    assert e["sender"] == "vigia" and e["task"] is None
    assert e["body"].startswith("ARMED over: w-arbiter")
    assert e["decided_by"] == {"source": "alarm", "rule": None, "jev": None, "regex": None, "regex_agreed": None}


def test_decision_without_parecer(real):
    e = entries(real)[7]
    assert e["mark"] == "decisao" and e["task"] == 4
    assert e["question"] == "Autoriza detalhe recebido como dado já seguro, ou define redator mínimo/pendência?"
    assert e["parecer"] is None
    assert e["body"].startswith("`StateEvent.problema_detalhe` é documentado como detalhe cru do processo (`core/types.ts:214`)")
    assert "PendingPlan e AssistantBubble podem avançar enquanto isso." in e["body"]
    assert e["decided_by"]["source"] == "rule" and e["decided_by"]["rule"] == "mark"


def test_decision_with_parecer(real):
    e = entries(real)[9]
    assert e["parecer"] == PARECER
    assert e["question"] == "Incluir `MessageList.tsx:104` em T4 (passar `ev.text` cru) ou deixar para T11?"
    assert "(NOTED 1)" not in e["body"] and "Parecer:" not in e["body"]


def test_rejected_round(real):
    e = entries(real)[10]
    assert e["rejected_round"] == 1 and e["task"] == 4
    assert e["question"] is None      # o `??` de `proposed ?? assistantText` não é pergunta
    assert e["parecer"] == PARECER
    assert "`planDisplayText(text)`" in e["body"] and "`executor.md`" in e["body"]


def test_dropped_by_jev(synth):
    e = entries(synth)[0]
    assert e["kind"] == "dropped" and e["sender"] == "w-t4" and e["origin"] == "notify"
    assert e["body"] == "Rodada 2 entregue ao revisor, sigo aguardando o veredito."
    d = e["decided_by"]
    assert d["source"] == "jev" and d["jev"]["p"] == 0.97
    assert d["jev"]["probs"] == {"nothing": 0.97, "act": 0.03}
    assert d["regex"] == {"verdict": "drop", "category": "entrega"} and d["regex_agreed"] is True


def test_dropped_where_regex_disagrees(synth):
    d = entries(synth)[1]["decided_by"]
    assert d["source"] == "jev" and d["regex"]["verdict"] == "wake" and d["regex_agreed"] is False


def test_would_drop_by_regex_without_jev(synth):
    e = entries(synth)[2]
    d = e["decided_by"]
    assert e["kind"] == "would_drop" and d["source"] == "regex"
    assert d["regex"] == {"verdict": "drop", "category": "janela"}
    assert d["jev"] is None and d["regex_agreed"] is None
    assert e["sender"] is None and e["origin"] == "notify"


def test_woke_with_jev_act(synth):
    e = entries(synth)[3]
    d = e["decided_by"]
    assert d["source"] == "jev" and d["jev"]["choice"] == "act" and d["jev"]["probs"]["act"] == 0.94
    assert e["task"] == 5 and e["question"] == "preciso da tela do celular, posso usar?"
    assert d["regex_agreed"] is True


def test_jev_error_falls_back_to_regex(synth):
    d = entries(synth)[4]["decided_by"]
    assert d["source"] == "regex" and d["jev"]["error"].startswith("URLError")
    assert d["regex_agreed"] is None


def test_old_record_without_probs_or_sender(synth):
    e = entries(synth)[5]
    d = e["decided_by"]
    assert e["origin"] == "notify" and e["sender"] is None and d["source"] == "jev"
    assert d["jev"]["probs"] == {} and d["jev"]["held"] == ["problem"]


def test_notify_that_failed(synth):
    e = entries(synth)[6]
    assert e["kind"] == "failed" and e["origin"] == "notify"
    assert e["error"] == "hangar-send w-arbiter failed (rc=1): boom"
    assert e["mark"] == "decisao" and e["task"] == 5 and e["decided_by"] is None


def test_orchestrator_failure(synth):
    e = entries(synth)[7]
    assert e["origin"] == "orchestrator" and e["task"] == 3
    assert e["body"] == "falhou ao integrar a T3: merge abortado" and e["decided_by"] is None


def test_orchestrator_wake(synth):
    e = entries(synth)[8]
    assert e["origin"] == "orchestrator"
    assert e["decided_by"]["source"] == "rule" and e["decided_by"]["rule"] == "orchestrator"


def test_notice_has_no_line(synth):
    e = entries(synth)[9]
    assert e["kind"] == "notice" and e["task"] == 5 and e["line"] is None


def test_delivered_and_red_back(synth):
    es = entries(synth)
    assert es[10]["line"] == {"code": "delivered", "round": 1, "commit": "7858997"}
    assert es[11]["line"] == {"code": "red_back", "executor": "w-t3"}


def test_red_retry_line():
    o = {"ts": "2026-09-29T22:00:00-03:00", "kind": "advance", "task": 3,
         "text": "T3: integração vermelha, rodando de novo uma vez"}
    assert ot.entry(o, None)["line"] == {"code": "red_retry"}


def test_jev_record_outside_the_window_is_not_matched(synth):
    obj = lines(synth)[0]
    run = ot.run_files(synth)
    rows = [json.loads(l) for l in (synth / "jev-shadow.jsonl").read_text().splitlines()]
    when = ot.orq_conductor._when(rows[0]["ts"]) - timedelta(seconds=60)
    rows[0]["ts"] = when.isoformat()
    (synth / "jev-shadow.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    e = ot.entry(obj, run)
    assert e["decided_by"]["jev"] is None and e["decided_by"]["source"] == "jev"


def test_entry_without_run_never_raises(synth):
    for o in lines(synth):
        e = ot.entry(o, None)
        if e["decided_by"] and e["decided_by"]["source"] != "rule":
            assert e["decided_by"]["jev"] is None and e["decided_by"]["regex"] is None


def test_empty_text_is_none():
    assert ot.entry({"kind": "woke", "text": "  "}, None) is None
    assert ot.entry({"kind": "woke"}, None) is None


def test_unknown_kind_is_a_notice():
    assert ot.entry({"kind": "??", "text": "algo"}, None)["kind"] == "notice"


def test_jev_index_is_read_once_until_the_file_changes(synth, monkeypatch):
    big = synth / "jev-shadow.jsonl"
    extra = [json.dumps({"ts": "2026-09-29T20:00:00-03:00", "text": f"linha {i}", "mode": "on"}) for i in range(2000)]
    big.write_text(big.read_text() + "\n".join(extra) + "\n")
    calls = []
    real_lines = ot._lines
    monkeypatch.setattr(ot, "_lines", lambda p: calls.append(p) or real_lines(p))
    run = ot.run_files(synth)
    obj = lines(synth)[0]
    ot.entry(obj, run)
    ot.entry(obj, run)
    assert len(calls) == 1


def test_bad_jev_lines_are_skipped(synth):
    f = synth / "jev-shadow.jsonl"
    f.write_text("não é json\n[1]\n" + '{"ts": "x", "text": "a"}\n' + f.read_text())
    assert entries(synth)[0]["decided_by"]["jev"]["p"] == 0.97


def test_parse_obj_keeps_text_and_adds_orq(synth):
    obj = lines(synth)[3]
    [ev] = adapter.parse_obj(obj, synth)
    assert ev.kind == "notice" and ev.text == obj["text"] and ev.orq["kind"] == "woke"
    [plain] = adapter.parse_obj(obj)
    assert plain.id == ev.id and plain.orq["decided_by"]["jev"] is None


def test_history_carries_orq(synth):
    tl = ot.timeline_path(synth)
    evs = pqueue.merged_history("g1-orq", str(tl), "orq")
    assert len(evs) == 12 and all(e.orq for e in evs)
    assert evs[3].orq["decided_by"]["jev"]["choice"] == "act"


def test_tailer_parser_uses_the_run_dir(synth):
    parse = adapter.line_parser(synth)
    [ev] = parse(json.dumps(lines(synth)[3], ensure_ascii=False))
    assert ev.orq["decided_by"]["jev"]["choice"] == "act"
