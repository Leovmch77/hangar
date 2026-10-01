"""Synthetic backend for landing-page screenshots. Reuses task14 fixture handler; replaces sessions."""
import pathlib, time
TOOLS = pathlib.Path(__file__).resolve().parents[3] / "desktop-native" / "tools"
import sys; sys.path.insert(0, str(TOOLS))
SRC = (TOOLS / "task14_sidebar_fixture.py").read_text(encoding="utf-8")
NS = {"__name__": "task14_base", "__file__": str(TOOLS / "task14_sidebar_fixture.py")}
exec(compile(SRC[:SRC.index("\nserver = BASE[")], "task14_sidebar_fixture.py", "exec"), NS)
BASE = NS["BASE"]; SESSIONS = BASE["SESSIONS"]; info = BASE["info"]; state = BASE["state"]; msg = BASE["msg"]
call, result = BASE["call"], BASE["result"]
NOW = time.time()

CHAT = [
    msg("user_msg", "u1", "Add rate limiting to the public API — 100 req/min per key, and return a proper 429 with Retry-After."),
    msg("thinking", "th1", "I should find where requests are authenticated, then add a sliding-window limiter keyed by API key."),
    call("g1", "g1", "Grep", {"pattern": "fn authenticate", "path": "src"}), result("g1r", "g1", "src/middleware/auth.rs:24"),
    call("r1", "r1", "Read", {"file_path": "/home/dev/projects/acme-api/src/middleware/auth.rs"}), result("r1r", "r1", "\n".join(f"line {i}" for i in range(96))),
    call("e1", "e1", "Edit", {"file_path": "/home/dev/projects/acme-api/src/middleware/auth.rs",
        "old_string": "let key = authenticate(&req)?;\nnext.run(req).await",
        "new_string": "let key = authenticate(&req)?;\nif let Err(wait) = limiter.check(&key) {\n    return Ok(too_many_requests(wait));\n}\nnext.run(req).await"}),
    result("e1r", "e1", "The file has been updated."),
    call("b1", "b1", "Bash", {"command": "cargo test rate_limit", "description": "Run rate limit tests"}),
    result("b1r", "b1", "running 6 tests\ntest rate_limit::allows_burst ... ok\ntest rate_limit::returns_429 ... ok\ntest result: ok. 6 passed; 0 failed"),
    msg("assistant_msg", "a1",
        "Rate limiting is in. Every request is now checked against a **sliding window of 60 s per API key**.\n\n"
        "```rust\nif let Err(wait) = limiter.check(&key) {\n    return Ok(too_many_requests(wait)); // 429 + Retry-After\n}\n```\n\n"
        "| Scenario | Result |\n|---|---|\n| 100 req in 60 s | 200 OK |\n| 101st request | 429, `Retry-After: 12` |\n| New window | counter resets |\n\n"
        "All **6 tests pass**. Next step: expose the limit in the `X-RateLimit-Remaining` header?"),
]

ROWS = [
    # name, provider, state, cwd, events, extra-info, extra-state
    ("api-rate-limit", "claude", "idle", "/home/dev/projects/acme-api", CHAT,
     dict(branch="feat/rate-limit", git_added=48, git_removed=6, git_dirty=3, last_reply="Rate limiting is in.", last_activity=NOW - 40),
     dict(status_line="🤖 Opus5.5·1M (high✦) │ 📁 acme-api [feat/rate-limit*] │ 💬 9k/1.2k 184k/1M │ 💵 $0.92 │ ⏱ 14m")),
    ("checkout-redesign", "claude", "working", "/home/dev/projects/acme-web",
     [msg("user_msg", "c1", "Redesign the checkout summary card."), msg("assistant_msg", "c2", "Splitting the card into line items and totals.")],
     dict(branch="feat/checkout", git_added=112, git_removed=40, git_dirty=5, pair_peers=["checkout-review"], pair_gid="g-checkout",
          pair_task="Checkout redesign", label="Editing CheckoutSummary.tsx", last_activity=NOW - 5),
     dict(label="Editing CheckoutSummary.tsx")),
    ("checkout-review", "codex", "awaiting_input", "/home/dev/projects/acme-web",
     [msg("user_msg", "r0", "[from: checkout-redesign] Summary card is done. Can you review the diff before I push?"),
      call("rv1", "rv1", "Bash", {"command": "git diff main --stat", "description": "Diff summary"}),
      result("rv1r", "rv1", " src/CheckoutSummary.tsx | 112 ++++++----\n src/money.ts | 18 +-\n 2 files changed"),
      msg("assistant_msg", "r1", "Reviewed the diff. **Two findings, one blocking:**\n\n1. **Blocking** — `money.ts:41` rounds each line item before summing, so a 3-item cart can be off by one cent.\n2. Minor — the discount row still renders when the discount is `0`.\n\nI can apply the fix for #1 and send the patch back to `checkout-redesign`.")],
     dict(branch="feat/checkout", pair_peers=["checkout-redesign"], pair_gid="g-checkout", pair_task="Checkout redesign",
          question="Apply the fix for the rounding bug?", options=["Yes, apply", "No, just report"], last_activity=NOW - 20),
     dict(question="Apply the fix for the rounding bug?", options=["Yes, apply", "No, just report"])),
    ("flaky-tests", "kimi", "working", "/home/dev/projects/acme-api",
     [msg("assistant_msg", "k1", "Iteration 3: the timeout test is stable now.")],
     dict(branch="main", loop_status="running", loop_iter=3, loop_max=10, label="Running tests", last_activity=NOW - 8),
     dict(label="Running tests", status_line="🤖 K3 (high✦) │ 📁 acme-api [main] │ 💬 ctx 120k/1M", loop_status="running", loop_iter=3, loop_max=10)),
    ("docs-i18n", "pi", "idle", "/home/dev/projects/acme-docs",
     [msg("assistant_msg", "p1", "Translated 42 pages to Portuguese and Spanish.")],
     dict(branch="main", last_reply="Translated 42 pages.", last_activity=NOW - 900), {}),
    ("mobile-release", "claude", "idle", "/home/dev/projects/acme-mobile",
     [msg("assistant_msg", "m1", "Release notes for 2.4.0 are ready.")],
     dict(branch="release/2.4", last_reply="Release notes for 2.4.0 are ready.", last_activity=NOW - 3600), {}),
]

SESSIONS.clear()
for name, prov, st, cwd, events, extra, sextra in ROWS:
    data = info(name, prov, state=st, **{k: v for k, v in extra.items() if k != "last_activity"})
    data["cwd"] = cwd
    data["last_activity"] = extra.get("last_activity", NOW)
    SESSIONS[name] = {"info": data, "state": state(st, **sextra), "events": [dict(e) for e in events], "stats": None, "modes": [],
                      "model": {"claude": "Opus 5.5", "codex": "gpt-6", "pi": "kimi-k3", "kimi": "K3"}[prov]}
BASE["bump"]()

BASE["R4"]["behind"] = 0
SESSIONS["api-rate-limit"]["stats"] = {"turns": 3, "steps": 14, "in_tok": 184000, "out_tok": 6200, "llm_ms": 38200, "tool_ms": 9100, "tok_s": 64, "cache_pct": 91, "ttft_ms": 1800}
from urllib.parse import unquote, urlparse
SHORTCUTS = {"items": [
    {"id": "tests", "type": "shell", "label": "Run tests", "command": "cargo test"},
    {"id": "dev", "type": "shell", "label": "Dev server", "command": "npm run dev"},
    {"id": "lint", "type": "shell", "label": "Lint", "command": "cargo clippy"},
]}

import datetime, math, random
from urllib.parse import parse_qs
MODELS = [("anthropic", "claude", "claude-opus-5-5", 15, 75), ("anthropic", "claude", "claude-sonnet-5-5", 3, 15),
          ("openai", "codex", "gpt-6", 5, 20), ("moonshot", "kimi", "kimi-k3", 0.6, 2.5), ("openrouter", "pi", "deepseek-v4", 0.3, 1.2)]
PROJECTS = ["acme-api", "acme-web", "acme-mobile", "acme-docs"]
def report(period):
    days = {"1d": 1, "7d": 7, "30d": 30, "90d": 90, "all": 75}.get(period, 30)
    rnd = random.Random(7)
    today = datetime.date(2026, 9, 30)
    combos = []
    for d in range(days):
        day = (today - datetime.timedelta(days=d)).isoformat()
        wk = 0.35 if (today - datetime.timedelta(days=d)).weekday() >= 5 else 1.0
        for prov, src, model, pin, pout in MODELS:
            for proj in PROJECTS:
                if rnd.random() < 0.45: continue
                scale = {"claude": 1.0, "codex": 0.55, "kimi": 0.7, "pi": 0.4}[src] * wk * (0.5 + rnd.random())
                inp = int(60000 * scale); out = int(9000 * scale); cr = int(900000 * scale); cw = int(80000 * scale)
                ci, co, ccr, ccw = inp * pin / 1e6, out * pout / 1e6, cr * pin * 0.1 / 1e6, cw * pin * 1.25 / 1e6
                combos.append({"dia": day, "provider": prov, "source": src, "project": proj, "model": model, "subagente": False,
                    "sessions": 1 + int(rnd.random() * 3), "input": inp, "output": out, "cache_write": cw, "cache_read": cr,
                    "cost": ci + co + ccr + ccw, "cost_input": ci, "cost_output": co, "cost_cache_write": ccw, "cost_cache_read": ccr,
                    "cache_write_1h": 0, "regravado": 0, "custo_regravado": 0})
    F = ("sessions", "input", "output", "cache_write", "cache_read", "cost", "cost_input", "cost_output", "cost_cache_write", "cost_cache_read", "cache_write_1h", "regravado", "custo_regravado")
    def agg(field):
        out = {}
        for c in combos:
            b = out.setdefault(c[field], {"key": c[field], **{f: 0 for f in F}})
            for f in F: b[f] += c[f]
        return sorted(out.values(), key=lambda b: -b["cost"])
    tot = {"key": "totals", **{f: sum(c[f] for c in combos) for f in F}}
    return {"applied": {"period": period}, "totals": tot, "by_day": sorted(agg("dia"), key=lambda b: b["key"]),
            "by_provider": agg("provider"), "by_source": agg("source"), "by_project": agg("project"), "by_model": agg("model"),
            "rates": [{"model": m, "input": a, "output": b, "cache_read": a * 0.1, "cache_write": a * 1.25, "origin": "table", "cache_estimado": False} for _, _, m, a, b in MODELS],
            "sem_tarifa": [], "custo_sem_cache": tot["cost"] * 3.1, "equivalente_cobrado": 0, "usd_brl": 5.4, "combos": combos, "sessoes": []}

import base64, hashlib, struct, select, json as _json
E = "\x1b["
G, R, Y, B, C, M, D, W, X = E+"32m", E+"31m", E+"33m", E+"34m", E+"36m", E+"35m", E+"2m", E+"1m", E+"0m"
def P(path, branch): return f"{G}dev@workstation{X} {B}{path}{X} {M}({branch}){X} $ "
TERM_TEXT = (
    P("~/projects/acme-api", "feat/rate-limit") + "cargo test rate_limit\r\n"
    f"{G}{W}   Compiling{X} acme-api v0.4.2 (/home/dev/projects/acme-api)\r\n"
    f"{G}{W}    Finished{X} `test` profile [unoptimized + debuginfo] target(s) in 3.84s\r\n"
    f"{G}{W}     Running{X} unittests src/lib.rs (target/debug/deps/acme_api-3f9c1e)\r\n\r\n"
    "running 6 tests\r\n"
    + "".join(f"test rate_limit::{t} ... {G}ok{X}\r\n" for t in
              ["allows_burst_under_limit", "returns_429_when_exceeded", "sets_retry_after_header", "window_slides_per_key",
               "keys_are_isolated", "resets_after_window"]) +
    f"\r\ntest result: {G}ok{X}. 6 passed; 0 failed; 0 ignored; 0 measured; 38 filtered out; finished in 0.21s\r\n\r\n"
    + P("~/projects/acme-api", "feat/rate-limit") + "git log --oneline -4\r\n"
    f"{Y}9c41e7a{X} {C}(HEAD -> feat/rate-limit){X} feat(api): sliding-window rate limit per API key\r\n"
    f"{Y}2b8d0f3{X} test(api): cover 429 + Retry-After\r\n"
    f"{Y}71aa5c2{X} {C}(origin/main, main){X} chore: bump axum to 0.9\r\n"
    f"{Y}e03f9d1{X} fix(auth): constant-time key comparison\r\n\r\n"
    + P("~/projects/acme-api", "feat/rate-limit") + "curl -si localhost:8080/v1/orders | head -3\r\n"
    f"HTTP/1.1 {R}429 Too Many Requests{X}\r\nretry-after: 12\r\nx-ratelimit-remaining: 0\r\n\r\n"
    + P("~/projects/acme-api", "feat/rate-limit")
).encode()
def ws_frame(opcode, data):
    n = len(data)
    head = bytes([0x80 | opcode, n]) if n < 126 else (bytes([0x80 | opcode, 126]) + struct.pack("!H", n) if n < 65536 else bytes([0x80 | opcode, 127]) + struct.pack("!Q", n))
    return head + data

T0 = NOW - 3 * 3600
def iso(sec): return datetime.datetime.fromtimestamp(T0 + sec).astimezone().isoformat()
def ov(eid, sec, text, **o): return {"kind": "notice", "id": eid, "text": text, "ts": T0 + sec, "orq": {"body": o.pop("body", ""), **o}}
ORQ_EVENTS = [
    ov("o1", 60, "T1 opened", kind="advance", task=1, line={"code": "opened", "sessions": [
        {"name": "exec-t1", "provider": "claude", "model": "opus"}, {"name": "rev-t1", "provider": "codex", "model": "gpt-6"}]}),
    ov("o2", 1500, "T1 delivered", kind="advance", task=1, line={"code": "delivered", "round": 1, "commit": "4f2a9c1"}),
    ov("o3", 2100, "rev", kind="dropped", task=1, sender="rev-t1",
       body="Round 1 approved. Money helpers are covered by tests; no blocking findings.",
       decided_by={"source": "jev", "jev": {"mode": "on", "choice": "nothing", "p": 0.94, "probs": {"nothing": 0.94}}}),
    ov("o4", 2200, "T1 integrated", kind="advance", task=1, line={"code": "integrated", "merge": True}),
    ov("o5", 2300, "T2 opened", kind="advance", task=2, line={"code": "opened", "sessions": [
        {"name": "exec-t2", "provider": "kimi", "model": "k3"}, {"name": "rev-t2", "provider": "codex", "model": "gpt-6"}]}),
    ov("o6", 5400, "rev", kind="woke", task=2, sender="rev-t2", rejected_round=1,
       body="Rejected round 1: `CheckoutSummary` rounds each line item before summing — a 3-item cart is off by one cent.",
       decided_by={"source": "rule", "rule": "mark"}),
    ov("o7", 7800, "T2 delivered", kind="advance", task=2, line={"code": "delivered", "round": 2, "commit": "a81d0e7"}),
    ov("o8", 8400, "exec", kind="woke", task=3, sender="exec-t3", mark="decisao",
       body="The plan says to keep the old coupon field, but the API removed it last week.",
       question="Drop the legacy coupon field from the summary card, or keep it hidden behind a flag?",
       decided_by={"source": "jev", "jev": {"mode": "on", "choice": "decision", "p": 0.91, "probs": {"decision": 0.91}}}),
]
PANEL = {"run": "2026-09-30-checkout", "gid": "g-orq",
    "metadata": {"title": "Checkout redesign", "plan": "docs/plans/checkout-redesign.md", "repo": "acme-web", "total_tasks": 5},
    "errors": [], "empty": False, "timing": {"started_at": iso(0), "finished_at": None, "elapsed_seconds": 3 * 3600},
    "tasks": {"integrated": 1, "total": 5, "total_known": True, "rows": [
        {"n": 1, "title": "Money helpers with exact rounding", "state": "integrated", "round": 1, "timing": {"started_at": iso(60), "finished_at": iso(2200), "elapsed_seconds": 2140}},
        {"n": 2, "title": "Summary card layout", "state": "in_review", "round": 2, "timing": {"started_at": iso(2300), "finished_at": None, "elapsed_seconds": 8400}},
        {"n": 3, "title": "Coupon and discount rows", "state": "executing", "round": 1, "timing": {"started_at": iso(8000), "finished_at": None, "elapsed_seconds": 2800}},
        {"n": 4, "title": "Mobile breakpoint", "state": "queued", "round": None, "timing": {}},
        {"n": 5, "title": "Visual regression snapshots", "state": "queued", "round": None, "timing": {}}]},
    "team": [
        {"name": "checkout-arbiter", "role": "arbiter", "task": None, "current": True, "last": None},
        {"name": "exec-t3", "role": "executor", "task": 3, "current": True, "last": {"code": "started", "round": 1, "ts": iso(8000)}},
        {"name": "rev-t2", "role": "reviewer", "task": 2, "current": True, "last": None},
        {"name": "exec-t2", "role": "executor", "task": 2, "current": True, "last": {"code": "delivered", "round": 2, "ts": iso(7800)}}],
    "decisions": [{"task": 3, "ts": iso(8400), "question": "Drop the legacy coupon field from the summary card, or keep it hidden behind a flag?", "parecer": None, "event_id": "o8"}],
    "automation": {"mode": {"jev": "on", "regex": "on"}, "woke": {"total": 9, "decisions": 1, "alarms": 0, "messages": 8},
                   "alone": {"total": 14, "opened": 3, "integrated": 1, "dropped": 10}, "dropped_by_jev": 10,
                   "advanced": {"would_drop": 0, "disagree": 0, "judged": 19, "min_confidence": None, "by_rule": 4}},
    "consumption": {"computed_at": iso(10700), "since": iso(0), "until": iso(10700), "sessions": {"team": 6, "measured": 6, "missing": []},
        "totals": {"new": 2310000, "cache_read": 18400000, "usd": 14.62, "usd_partial": False},
        "providers": [
            {"provider": "claude", "sessions": 2, "new": 1200000, "cache_read": 11000000, "usd": 10.9, "models": [{"model": "opus", "sessions": 2, "new": 1200000, "cache_read": 11000000, "usd": 10.9}]},
            {"provider": "codex", "sessions": 2, "new": 610000, "cache_read": 5200000, "usd": 2.95, "models": [{"model": "gpt-6", "sessions": 2, "new": 610000, "cache_read": 5200000, "usd": 2.95}]},
            {"provider": "kimi", "sessions": 2, "new": 500000, "cache_read": 2200000, "usd": 0.77, "models": [{"model": "k3", "sessions": 2, "new": 500000, "cache_read": 2200000, "usd": 0.77}]}],
        "missing_prices": [], "subagents": True},
    "integration": {"branch": "orq/checkout-redesign", "last": {"task": 1, "commit": "4f2a9c1", "ts": iso(2200)}, "outcome": "green", "red_log": None,
                    "delivery_checks": {"ok": 2, "total": 2, "failing": []}}}
def add(name, prov, st, extra, events=(), sextra=None):
    data = info(name, prov, state=st, **extra); data["cwd"] = "/home/dev/projects/acme-web"; data["last_activity"] = NOW - 30
    SESSIONS[name] = {"info": data, "state": state(st, **(sextra or {})), "events": list(events), "stats": None, "modes": [], "model": None}
G = dict(pair_gid="g-orq", pair_task="Checkout redesign (orchestrated)")
add("orq-checkout", "orq", "working", dict(orq_arbiter="checkout-arbiter", plan_task=3, plan_task_total=5, **G), ORQ_EVENTS)
add("checkout-arbiter", "claude", "awaiting_input", dict(question="Drop the legacy coupon field?", **G), [msg("assistant_msg", "ar1", "Waiting for your call on T3.")])
add("exec-t3", "claude", "working", dict(label="Editing CouponRow.tsx", **G), [msg("assistant_msg", "e31", "Working on coupon rows.")], {"label": "Editing CouponRow.tsx"})
add("rev-t2", "codex", "working", dict(label="Reviewing round 2", **G), [msg("assistant_msg", "r21", "Reviewing.")], {"label": "Reviewing round 2"})
add("exec-t2", "kimi", "idle", dict(**G), [msg("assistant_msg", "e21", "Round 2 delivered.")])
for n in ("checkout-redesign", "checkout-review"): SESSIONS.pop(n, None)
BASE["bump"]()
class H(NS["Handler"]):
    def do_GET(self):
        parts = [unquote(x) for x in urlparse(self.path).path.strip("/").split("/")]
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "project-shortcuts":
            if not self.authorized(): return
            self.send_json(SHORTCUTS); return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "plan-preview":
            if not self.authorized(): return
            self.send_json(None); return
        if len(parts) == 5 and parts[:2] == ["api", "sessions"] and parts[3:] == ["git", "files"]:
            if not self.authorized(): return
            self.send_json({"files": [
                {"path": "src/middleware/auth.rs", "code": " M", "staged": False, "added": 14, "removed": 2},
                {"path": "src/limiter.rs", "code": "A ", "staged": False, "added": 30, "removed": 0},
                {"path": "tests/rate_limit.rs", "code": "A ", "staged": False, "added": 4, "removed": 4}], "sequencer": None}); return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "term":
            key = self.headers.get("Sec-WebSocket-Key", "")
            acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101); self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", acc); self.end_headers(); self.close_connection = True
            time.sleep(0.6)
            self.connection.sendall(ws_frame(2, TERM_TEXT))
            while True:
                r, _, _ = select.select([self.connection], [], [], 1.0)
                if r:
                    d = self.connection.recv(65536)
                    if not d: return
            return
        if len(parts) == 5 and parts[:2] == ["api", "sessions"] and parts[3:] == ["orq", "panel"]:
            if not self.authorized(): return
            self.send_json(PANEL); return
        if parts[:2] == ["api", "costs"] or parts[:2] == ["api", "uso"]:
            if not self.authorized(): return
            q = parse_qs(urlparse(self.path).query)
            self.send_json(report(q.get("period", ["30d"])[0])); return
        super().do_GET()
server = BASE["ThreadingHTTPServer"](("127.0.0.1", 47123), H)
print(f"Fixture URL: http://127.0.0.1:{server.server_port}", flush=True)
server.serve_forever()
