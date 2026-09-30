import json
import os
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


def test_entry_failure_still_yields_a_plain_notice(synth, monkeypatch):
    obj = lines(synth)[3]
    monkeypatch.setattr(ot, "entry", lambda *a, **k: 1 / 0)
    [ev] = adapter.parse_obj(obj, synth)
    assert ev.kind == "notice" and ev.text == obj["text"] and ev.orq is None and ev.id.startswith("orq:")


def test_run_files_reuses_one_and_caps_the_cache(tmp_path):
    a = ot.run_files(tmp_path)
    assert ot.run_files(tmp_path) is a
    for i in range(ot._RUNS_MAX + 4):
        d = tmp_path / f"r{i}"
        d.mkdir()
        ot.run_files(d)
    assert len(ot._RUNS) <= ot._RUNS_MAX


def test_tasks_da_execucao_real(real):
    t = ot.panel(real)["tasks"]
    assert (t["integrated"], t["total"], t["total_known"]) == (4, 44, True)
    by = {r["n"]: r for r in t["rows"]}
    assert [by[n]["state"] for n in (1, 2, 3, 4)] == ["integrated"] * 4
    assert (by[5]["state"], by[5]["round"]) == ("in_review", 1)
    assert by[6]["state"] == "queued" and by[6]["title"] == "Silêncio SSE e recusa HTTP separados"


def _cut(d, n):
    ev = (d / "eventos.jsonl").read_text().splitlines()
    (d / "eventos.jsonl").write_text("\n".join(ev[:n]) + "\n")


def test_estados_intermediarios(real):
    _cut(real, 20)                                   # até o veredito que reprova a T4 R1 (22:12:21)
    by = {r["n"]: r for r in ot.panel(real)["tasks"]["rows"]}
    assert (by[4]["state"], by[4]["round"]) == ("rejected", 1)
    assert by[2]["state"] == "integrated" and by[5]["state"] == "queued"
    _cut(real, 18)                                   # veredito aprova T2 R2, antes da integração
    assert {r["n"]: r for r in ot.panel(real)["tasks"]["rows"]}[2]["state"] == "approved"


def test_time_da_execucao_real(real):
    team = ot.panel(real)["team"]
    assert team[0] == {"name": "w-arbiter", "role": "arbiter", "task": None, "last": None, "current": True}
    names = [m["name"] for m in team]
    assert len(names) == 11 and names[1:3] == ["hangar-mobile-t5", "hangar-mobile-review5"]
    t5 = team[1]
    assert (t5["role"], t5["task"], t5["last"]["code"], t5["last"]["round"]) == ("executor", 5, "delivered", 1)
    rev4 = next(m for m in team if m["name"] == "w-review4")
    assert (rev4["last"]["code"], rev4["last"]["round"]) == ("approved", 2)


def test_time_depois_de_trocas(real):
    with (real / "eventos.jsonl").open("a") as f:
        f.write(json.dumps({"ts": "2026-09-29T22:25:59-03:00", "tipo": "sessao_trocada", "de": "hangar-mobile-t5",
                            "para": "hangar-mobile-t5b", "papel": "executor", "task": 5, "motivo": "x"}) + "\n")
        f.write(json.dumps({"ts": "2026-09-29T22:25:59-03:00", "tipo": "sessao_trocada", "de": "w-arbiter",
                            "para": "w-arbiter-2", "papel": "arbitro", "motivo": "y"}) + "\n")
    team = ot.panel(real)["team"]
    assert team[0]["name"] == "w-arbiter-2" and team[0]["current"] is True
    assert team[1] == {**team[1], "name": "w-arbiter", "role": "arbiter", "current": False}
    t5b = next(m for m in team if m["name"] == "hangar-mobile-t5b")
    assert (t5b["role"], t5b["task"], t5b["last"]["code"]) == ("executor", 5, "swapped_in")
    assert next(m for m in team if m["name"] == "hangar-mobile-t5")["current"] is False


def test_revisor_subagente_ou_frase_fica_de_fora(real):
    with (real / "eventos.jsonl").open("a") as f:
        f.write(json.dumps({"ts": "2026-09-29T22:25:59-03:00", "tipo": "task_inicio", "task": 6, "titulo": "t",
                            "executor": "x6", "par": "usuario aprova a folha"}) + "\n")
        f.write(json.dumps({"ts": "2026-09-29T22:25:59-03:00", "tipo": "task_inicio", "task": 7, "titulo": "t",
                            "executor": "x7", "par": "subagente"}) + "\n")
    names = [m["name"] for m in ot.panel(real)["team"]]
    assert "x6" in names and "x7" in names and "usuario aprova a folha" not in names and "subagente" not in names


def test_decisoes_abertas_e_fechadas(real):
    assert ot.panel(real)["decisions"] == []          # a T4 entregou a R2 depois das três
    _cut(real, 20)
    d = ot.panel(real)["decisions"]
    assert [x["ts"] for x in d] == ["2026-09-29T22:12:48-03:00", "2026-09-29T22:12:22-03:00"]
    assert d[1]["question"] == "Incluir `MessageList.tsx:104` em T4 (passar `ev.text` cru) ou deixar para T11?"
    assert d[0]["question"].startswith("receita exige")   # sem "?": a primeira frase, até 160 caracteres
    assert d[0]["parecer"].endswith("pareceres/task-4-r1-revisor.md")
    assert len(d[0]["question"]) <= 160 and all(x["event_id"].startswith("orq:") for x in d)


def test_automacao_da_execucao_real(real):
    a = ot.panel(real)["automation"]
    assert a["mode"] == {"jev": "on", "regex": "shadow"}
    assert a["woke"] == {"total": 4, "decisions": 3, "alarms": 1, "messages": 0}
    assert a["alone"] == {"total": 9, "opened": 5, "integrated": 4, "dropped": 0}
    assert a["dropped_by_jev"] == 0
    assert a["advanced"] == {"would_drop": 0, "disagree": 0, "judged": 0, "min_confidence": None, "by_rule": 4}


def test_modo_sem_chave_jev_e_sombra(real):
    cfg = json.loads((real / "orq.json").read_text())
    cfg.pop("jev")
    (real / "orq.json").write_text(json.dumps(cfg))
    assert ot.panel(real)["automation"]["mode"]["jev"] == "shadow"   # o mesmo padrão do orq.py


def test_automacao_sintetica(synth):
    a = ot.panel(synth)["automation"]
    assert a["alone"]["dropped"] == 2 and a["dropped_by_jev"] == 2
    assert a["advanced"]["would_drop"] == 1
    assert (a["advanced"]["disagree"], a["advanced"]["judged"]) == (1, 4)
    assert a["advanced"]["min_confidence"]["p"] == 0.62


def test_integracao_da_execucao_real(real):
    i = ot.panel(real)["integration"]
    assert i["branch"] == "mobile-deliveries-orq"
    assert i["last"] == {"task": 4, "commit": "538ac4d", "ts": "2026-09-29T22:19:00-03:00"}
    assert i["outcome"] == "green" and i["delivery_checks"] == {"ok": 5, "total": 5, "failing": []}


def test_integracao_vermelha_e_falha_do_advance(real):
    with (real / "eventos.jsonl").open("a") as f:
        f.write(json.dumps({"ts": "2026-09-29T22:25:59-03:00", "tipo": "advance_falhou", "passo": "integrate",
                            "task": 4, "motivo": "boom"}) + "\n")
    with (real / "closed.jsonl").open("a") as f:
        f.write(json.dumps({"ts": "2026-09-29T22:25:58-03:00", "task": 4, "hash": "a" * 40}) + "\n")
    p = ot.panel(real)
    assert p["integration"]["outcome"] == "failed"
    assert {r["n"]: r for r in p["tasks"]["rows"]}[4]["state"] == "integration_red"


def test_arquivos_faltando_e_ilegiveis(tmp_path, real):
    only = tmp_path / "so-timeline"
    only.mkdir()
    shutil.copy(real / "timeline-2026-09-29-cad3e6fe.jsonl", only / "timeline-so-timeline.jsonl")
    p = ot.panel(only)
    assert p["tasks"]["rows"] == [] and p["team"] == [] and p["integration"]["last"] is None
    assert [e["file"] for e in p["errors"]] == ["orq.json"] and p["empty"] is False


@pytest.mark.skipif(os.geteuid() == 0, reason="root lê arquivo sem permissão")
def test_arquivo_ilegivel_vira_erro(real):
    (real / "eventos.jsonl").chmod(0)
    try:
        assert any(e["file"] == "eventos.jsonl" for e in ot.panel(real)["errors"])
    finally:
        (real / "eventos.jsonl").chmod(0o644)


def test_plano_ilegivel(real):
    (real / "plan.orq.md").unlink()
    p = ot.panel(real)
    assert p["tasks"]["total_known"] is False and p["tasks"]["total"] == 5
    assert [e["file"] for e in p["errors"]] == ["plan"]


def test_execucao_recem_criada_e_vazia(tmp_path):
    d = tmp_path / "nova"
    d.mkdir()
    (d / "orq.json").write_text('{"arbiter": "arb", "auto": true, "jev": "on", "regex": "shadow"}')
    assert ot.panel(d)["empty"] is True


def test_linha_do_tempo_grande_usa_o_cache(real, monkeypatch):
    tl = ot.timeline_path(real)
    tl.write_text(tl.read_text() * 400)              # ~5.000 linhas
    first = ot.panel(real)
    calls = {"n": 0}
    real_entry = ot.entry
    monkeypatch.setattr(ot, "entry", lambda *a, **k: (calls.__setitem__("n", calls["n"] + 1), real_entry(*a, **k))[1])
    assert ot.panel(real) == first and calls["n"] == 0
