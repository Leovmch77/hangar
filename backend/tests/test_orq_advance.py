"""orq advance (skills/orquestrar/scripts/orq.py): the orchestrator's pass, on a real git repo
with a fake hangar-send."""
import fcntl
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

import pytest

ORQ = Path(__file__).resolve().parents[2] / "skills" / "orquestrar" / "scripts" / "orq.py"

# One line per hangar-send call: "$*" (target and text, or --new and its flags).
FAKE = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n'

ROWS = ("| 1 | first | §1 | `a.txt` · `messages/pt.json` | `true` | 1 | low | — |\n"
        "| 2 | second | §2 | `a.txt` · `messages/pt.json` | `true` | 1 | high | — |\n")

PLAN = """# Orchestration plan — t

## Projeto
Checagens: —
Integração: {integ}
Prova: {prova}
Paralelo: {par}
Revisão: {revisao}
Correção pelo revisor: até 0 linhas
Aditivos: `messages/*.json`

## Tasks
| # | What it is | Where in their plan | Files | Verification | Wave | Risk | Roteiro |
|---|---|---|---|---|---|---|---|
{rows}"""


def run(e, *args, check=True):
    r = subprocess.run([sys.executable, str(ORQ), *args], env=e, capture_output=True, text=True)
    if check:
        assert r.returncode == 0, r.stdout + r.stderr
    return r


def git_in(r):
    def g(*a):
        return subprocess.run(["git", "-C", str(r), *a], check=True, capture_output=True,
                              text=True).stdout.strip()
    return g


def start(tmp_path, integ="`test -f a.txt`", par="até 2", rows=ROWS, revisao="sessão",
          prova="por-task", contract=""):
    """Repo on `main`, an auto run in <date>-g1 with the stamped plan, execucao_inicio recorded."""
    r = tmp_path / "repo"
    r.mkdir()
    g = git_in(r)
    g("init", "-q", "-b", "main")
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    (r / "a.txt").write_text("1\n2\n3\n")
    (r / "messages").mkdir()
    (r / "messages" / "pt.json").write_text('{\n  "a": "A",\n  "z": "Z"\n}\n')
    g("add", "a.txt", "messages/pt.json")
    g("commit", "-qm", "base")
    d = tmp_path / "2026-09-28-g1"
    d.mkdir()
    log = tmp_path / "sent.log"
    fake = tmp_path / "fake-send"
    fake.write_text(FAKE)
    fake.chmod(0o755)
    # CLAUDE_CONFIG_DIR isolated: jev_config() would otherwise read the real runtime-config.json.
    e = {**os.environ, "ORQ_DIR": str(d), "ORQ_SEND": str(fake), "FAKE_LOG": str(log),
         "ORQ_JEV": "off", "HOME": str(tmp_path), "CLAUDE_CONFIG_DIR": str(tmp_path / "cfg"),
         "TYPESAFE_API_KEY": "", "ORQ_JEV_URL": "", "JEV_ENDPOINT": "", "JEV_MODEL": ""}
    (tmp_path / "r1.md").write_text("roteiro\n")
    plan = tmp_path / "plan.orq.md"
    plan.write_text(PLAN.format(integ=integ, par=par, revisao=revisao, prova=prova, rows=rows))
    run(e, "plan-check", str(plan), "--repo", str(r), "--stamp")
    c = tmp_path / "regras.md"
    c.write_text(contract)
    run(e, "init", "--arbiter", "arb", "--repo", str(r), "--contract", str(c), "--plan", str(plan),
        "--auto")
    run(e, "event", "execucao_inicio", "--plano", str(plan), "--branch", "main", "--gid", "g1")
    return d, r, g, e, log


def started(e, tasks=(1, 2)):
    """The Tasks already opened (by hand here), so advance only integrates."""
    for n in tasks:
        run(e, "event", "task_inicio", "--task", str(n), "--titulo", f"t{n}", "--executor", f"ex{n}",
            "--par", f"rev{n}")


def close(d, task, h):
    """What `orq commit` writes once the commit is checked."""
    ts = datetime.now().astimezone().isoformat(timespec="seconds")
    with (d / "closed.jsonl").open("a") as f:
        f.write(json.dumps({"ts": ts, "task": task, "hash": h}) + "\n")


def branch_commit(g, r, name, path, content):
    """A worktree Task's commit: its own branch off main, main checked out again."""
    g("checkout", "-q", "-b", name, "main")
    (r / path).write_text(content)
    g("add", path)
    g("commit", "-qm", name)
    h = g("rev-parse", "HEAD")
    g("checkout", "-q", "main")
    return h


def events(d):
    return [json.loads(l) for l in (d / "eventos.jsonl").read_text().splitlines() if l.strip()]


def timeline_lines(d):
    p = d / f"timeline-{d.name}.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def sent(log):
    return log.read_text().splitlines() if log.exists() else []


def orq_mod():
    spec = importlib.util.spec_from_file_location("orq_advance_mod", ORQ)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.fixture
def jev():
    """Fake Jev: answers what the test put in `resp`, keeps the request body."""
    ctl = {"resp": {}, "body": None}

    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            ctl["body"] = json.loads(self.rfile.read(int(self.headers["content-length"])))
            out = json.dumps({"answers": ctl["resp"]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    ctl["url"] = f"http://127.0.0.1:{srv.server_port}/v1/systemone"
    yield ctl
    srv.shutdown()


def test_advance_does_nothing_in_a_run_without_auto(tmp_path):
    d, r, g, e, log = start(tmp_path)
    cfg = json.loads((d / "orq.json").read_text())
    cfg.pop("auto")
    (d / "orq.json").write_text(json.dumps(cfg))
    started(e)
    close(d, 1, g("rev-parse", "HEAD"))
    assert run(e, "advance").stdout == ""
    assert not any(x["tipo"] == "integrada" for x in events(d))
    assert not (d / "advance.lock").exists() and not (d / "advance.again").exists()


def test_worktree_task_is_merged_no_ff_then_integrated_once(tmp_path):
    d, r, g, e, log = start(tmp_path, integ="`test -f b.txt`")
    started(e)
    h = branch_commit(g, r, "main-t1", "b.txt", "b\n")
    close(d, 1, h)
    out = run(e, "advance").stdout.splitlines()
    head = g("rev-parse", "HEAD")
    assert out[0] == f"integrated T1 {head[:12]}"
    # A --no-ff merge of exactly the verified commit; the check ran on the merged tree.
    assert g("rev-list", "--parents", "-n1", "HEAD").split()[2] == h
    integ = [x for x in events(d) if x["tipo"] == "integrada"]
    assert [(x["task"], x["commit"]) for x in integ] == [(1, head)]
    assert any(x["kind"] == "advance" and x["task"] == 1 and "merge" in x["text"]
               for x in timeline_lines(d))
    run(e, "advance")
    assert g("rev-parse", "HEAD") == head
    assert len([x for x in events(d) if x["tipo"] == "integrada"]) == 1


def test_commit_already_on_the_main_line_is_not_merged(tmp_path):
    # Sequential allows one Task per wave.
    d, r, g, e, log = start(tmp_path, par="sequencial", rows=ROWS.replace("| 1 | high |", "| 2 | high |"))
    started(e)
    (r / "a.txt").write_text("x\n")
    g("commit", "-qam", "t1")
    h = g("rev-parse", "HEAD")
    close(d, 1, h)
    run(e, "advance")
    assert g("rev-parse", "HEAD") == h
    assert [(x["task"], x["commit"]) for x in events(d) if x["tipo"] == "integrada"] == [(1, h)]


def test_red_integration_without_jev_goes_back_to_the_executor_and_never_retries(tmp_path):
    counter = tmp_path / "ran"
    d, r, g, e, log = start(tmp_path, integ=f"`echo x >> {counter}; exit 1`")
    started(e)
    close(d, 1, branch_commit(g, r, "main-t1", "b.txt", "b\n"))
    assert "red T1: back to its executor" in run(e, "advance").stdout
    assert counter.read_text() == "x\n"
    tipos = [x["tipo"] for x in events(d)]
    assert tipos[-2:] == ["integracao_vermelha", "task_inicio"]
    assert "ex1" in run(e, "ball").stdout.split()   # the Task is open again, the ball with its executor
    assert any(m.startswith("ex1 [painel: orquestrador g1] [decisao] Integration red after Task 1")
               for m in sent(log))
    before = sent(log)
    run(e, "advance")   # the main line waits for the fix: no rerun, nobody woken again
    assert counter.read_text() == "x\n" and sent(log) == before


@pytest.mark.parametrize("mode,green", [("on", True), ("shadow", False)])
def test_red_integration_jev_retry_applies_only_when_on(tmp_path, jev, mode, green):
    flaky = tmp_path / "flaky"
    d, r, g, e, log = start(tmp_path, integ=f"`mkdir {flaky} 2>/dev/null && exit 1 || true`")
    cfg = json.loads((d / "orq.json").read_text())
    cfg["jev"] = mode
    (d / "orq.json").write_text(json.dumps(cfg))
    jev["resp"] = {"red": {"choice": "retry", "probabilities": {"retry": 0.95}}}
    e = {**e, "TYPESAFE_API_KEY": "k", "ORQ_JEV_URL": jev["url"]}
    started(e)
    close(d, 1, branch_commit(g, r, "main-t1", "b.txt", "b\n"))
    run(e, "advance")
    assert set(jev["body"]["questions"]["red"]["criteria"]) >= {"back", "retry", "wake"}
    tipos = [x["tipo"] for x in events(d)]
    assert ("integrada" in tipos) is green
    assert ("integracao_vermelha" in tipos) is not green
    if mode == "shadow":
        assert any(x["kind"] == "notice" and "rodar de novo" in x["text"] for x in timeline_lines(d))


def test_positional_conflict_in_an_additive_file_is_resolved_by_union(tmp_path):
    d, r, g, e, log = start(tmp_path)
    started(e)
    h1 = branch_commit(g, r, "main-t1", "messages/pt.json", '{\n  "a": "A",\n  "b": "B",\n  "z": "Z"\n}\n')
    h2 = branch_commit(g, r, "main-t2", "messages/pt.json", '{\n  "a": "A",\n  "c": "C",\n  "z": "Z"\n}\n')
    close(d, 1, h1)
    close(d, 2, h2)
    out = run(e, "advance").stdout
    assert "integrated T1" in out and "integrated T2" in out
    assert json.loads((r / "messages" / "pt.json").read_text()) == {"a": "A", "b": "B", "c": "C", "z": "Z"}
    assert g("status", "--porcelain") == ""


def test_other_conflict_aborts_the_merge_and_wakes_the_arbiter_once(tmp_path):
    d, r, g, e, log = start(tmp_path)
    started(e)
    close(d, 1, branch_commit(g, r, "main-t1", "a.txt", "one\n2\n3\n"))
    close(d, 2, branch_commit(g, r, "main-t2", "a.txt", "two\n2\n3\n"))
    run(e, "advance")
    head = g("rev-parse", "HEAD")
    assert not (r / ".git" / "MERGE_HEAD").exists()
    assert (r / "a.txt").read_text() == "one\n2\n3\n"
    woke = [m for m in sent(log) if "conflicted" in m]
    assert woke == ["arb [painel: orquestrador g1] [decisao] T2 conflicted with T1 in a.txt. "
                    "Merge aborted: the main line is as before."]
    assert [x["motivo"] for x in events(d) if x["tipo"] == "conflito"] == ["a.txt with T1"]
    run(e, "advance")
    assert g("rev-parse", "HEAD") == head
    assert [m for m in sent(log) if "conflicted" in m] == woke


def test_a_failed_step_wakes_the_arbiter_once_and_is_not_retried(tmp_path):
    d, r, g, e, log = start(tmp_path)
    started(e)
    close(d, 1, "deadbeef" * 5)   # not a commit: git merge refuses without a conflict
    assert run(e, "advance").stdout.startswith("failed integrate T1: git merge")
    run(e, "advance")
    fails = [x for x in events(d) if x["tipo"] == "advance_falhou"]
    assert [(x["passo"], x["task"]) for x in fails] == [("integrate", 1)]
    assert len([m for m in sent(log) if "orq advance failed at integrate T1" in m]) == 1
    assert [x["kind"] for x in timeline_lines(d) if x["task"] == 1] == ["failed"]


def test_a_held_lock_leaves_a_mark_and_does_nothing(tmp_path):
    d, r, g, e, log = start(tmp_path)
    started(e)
    close(d, 1, g("rev-parse", "HEAD"))
    with (d / "advance.lock").open("w") as f:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert run(e, "advance").stdout == ""
    assert not any(x["tipo"] == "integrada" for x in events(d))
    assert (d / "advance.again").exists()   # the holder would have run once more for it
    assert "integrated T1" in run(e, "advance").stdout


def test_union_proof_refuses_a_changed_value_and_a_lost_line():
    m = orq_mod()
    assert m._prove_additive("m.json", b'{"a": "1"}', b'{"a": "2"}', b'{"a": "1", "a": "2"}')
    assert m._prove_additive("m.txt", b"x\ny\n", b"x\nz\n", b"x\ny\n")
    assert m._prove_additive("m.json", b'{"a": "1"}', b'{"b": "2"}', b'{"a": "1", "b": "2"}') is None


def hook(g, r, name):
    """A repo hook that refuses; the path is explicit so a global core.hooksPath cannot hide it."""
    hooks = r / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    (hooks / name).write_text("#!/bin/sh\nexit 1\n")
    (hooks / name).chmod(0o755)
    g("config", "core.hooksPath", str(hooks))


def test_a_merge_refused_by_a_hook_is_aborted(tmp_path):
    d, r, g, e, log = start(tmp_path, integ="`test -f b.txt`")
    started(e)
    close(d, 1, branch_commit(g, r, "main-t1", "b.txt", "b\n"))
    before = g("rev-parse", "HEAD")
    hook(g, r, "commit-msg")
    assert run(e, "advance").stdout.startswith("failed integrate T1")
    assert not (r / ".git" / "MERGE_HEAD").exists()
    assert g("status", "--porcelain") == "" and g("rev-parse", "HEAD") == before


def test_a_union_commit_refused_by_pre_commit_is_aborted(tmp_path):
    d, r, g, e, log = start(tmp_path)
    started(e)
    h1 = branch_commit(g, r, "main-t1", "messages/pt.json", '{\n  "a": "A",\n  "b": "B",\n  "z": "Z"\n}\n')
    h2 = branch_commit(g, r, "main-t2", "messages/pt.json", '{\n  "a": "A",\n  "c": "C",\n  "z": "Z"\n}\n')
    close(d, 1, h1)
    close(d, 2, h2)
    hook(g, r, "pre-commit")   # git merge runs no pre-commit: only the union's commit meets it
    out = run(e, "advance").stdout
    assert "integrated T1" in out and "failed integrate T2" in out
    assert not (r / ".git" / "MERGE_HEAD").exists()
    assert g("status", "--porcelain") == ""


@pytest.mark.parametrize("staged", [False, True])
def test_a_dirty_main_line_waits_without_event_or_wake(tmp_path, staged):
    counter = tmp_path / "ran"
    d, r, g, e, log = start(tmp_path, integ=f"`echo x >> {counter}`")
    started(e)
    close(d, 1, branch_commit(g, r, "main-t1", "b.txt", "b\n"))
    before, n_events = g("rev-parse", "HEAD"), len(events(d))
    (r / "messages" / "pt.json").write_text("{}\n")   # a file the Task never touched
    if staged:
        g("add", "messages/pt.json")
    run(e, "advance")
    run(e, "advance")
    assert g("rev-parse", "HEAD") == before and not counter.exists()
    assert len(events(d)) == n_events and sent(log) == []
    waits = [x for x in timeline_lines(d) if x["kind"] == "notice"]
    assert len(waits) == 1 and "árvore limpa" in waits[0]["text"]   # once per dirty episode
    g("checkout", "HEAD", "--", "messages/pt.json")
    assert "integrated T1" in run(e, "advance").stdout


def test_a_modify_delete_conflict_in_an_additive_file_is_not_a_union(tmp_path):
    d, r, g, e, log = start(tmp_path)
    started(e)
    h1 = branch_commit(g, r, "main-t1", "messages/pt.json", '{\n  "a": "A",\n  "b": "B",\n  "z": "Z"\n}\n')
    g("checkout", "-q", "-b", "main-t2", "main")
    g("rm", "-q", "messages/pt.json")
    g("commit", "-qm", "t2")
    h2 = g("rev-parse", "HEAD")
    g("checkout", "-q", "main")
    close(d, 1, h1)
    close(d, 2, h2)
    run(e, "advance")
    assert [x["task"] for x in events(d) if x["tipo"] == "conflito"] == [2]
    assert (r / "messages" / "pt.json").exists() and g("status", "--porcelain") == ""


def test_a_conflict_whose_wake_fails_is_not_a_failed_step(tmp_path):
    d, r, g, e, log = start(tmp_path)
    started(e)
    close(d, 1, branch_commit(g, r, "main-t1", "a.txt", "one\n2\n3\n"))
    close(d, 2, branch_commit(g, r, "main-t2", "a.txt", "two\n2\n3\n"))
    e = {**e, "FAKE_LOG": str(tmp_path / "missing" / "sent.log")}   # the fake send exits non-zero
    run(e, "advance")
    tipos = [x["tipo"] for x in events(d)]
    assert "conflito" in tipos and "advance_falhou" not in tipos
