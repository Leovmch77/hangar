"""Synthetic LIVE backend for landing-page recordings: fixture.py + scripted scenes that change over time.
GET /control/setup?scene=X[&lang=en]  resets sessions for scene X.   GET /control/go  starts its timeline.
"""
import pathlib, threading, time
from urllib.parse import parse_qs, urlparse

HERE = pathlib.Path(__file__).resolve().parent
SRC = (HERE / "fixture.py").read_text(encoding="utf-8")
FX = {"__name__": "landing_fx", "__file__": str(HERE / "fixture.py")}
exec(compile(SRC[:SRC.rindex("\nserver = BASE[")], "fixture.py", "exec"), FX)
BASE, SESSIONS = FX["BASE"], FX["SESSIONS"]
LOCK, bump, info, state, msg, call, result = (BASE[k] for k in ("LOCK", "bump", "info", "state", "msg", "call", "result"))
import copy
ORQ_NAMES = ("orq-checkout", "checkout-arbiter", "exec-t3", "rev-t2", "exec-t2")
ORQ_SNAP = {n: copy.deepcopy(SESSIONS[n]) for n in ORQ_NAMES}
PANEL_SNAP = copy.deepcopy(FX["PANEL"])
LIVE = {}
EPOCH = {"n": 0}
SCRIPT = []


def live(name):
    return LIVE.setdefault(name, {"preview": "", "thinking": "", "tool": "", "label": None})


SL = {"claude": "🤖 Opus5.5·1M (high✦) │ 📁 {repo} [{branch}*] │ 💬 9k/1.2k {ctx}k/1M │ 💵 $0.74 │ ⏱ 6m",
      "codex": "🤖 gpt-6 (high) │ 📁 {repo} [{branch}] │ 💬 ctx {ctx}k/400k", "kimi": "🤖 K3 (high✦) │ 📁 {repo} [{branch}] │ 💬 ctx {ctx}k/1M",
      "pi": "🤖 deepseek-v4 │ 📁 {repo} [{branch}] │ 💬 ctx {ctx}k/128k"}
STATS = {"turns": 2, "steps": 11, "in_tok": 148000, "out_tok": 5200, "llm_ms": 31200, "tool_ms": 8100, "tok_s": 71, "cache_pct": 92, "ttft_ms": 1500}


def add(name, prov, st, cwd, events, when, model=None, **extra):
    data = info(name, prov, state=st, **extra)
    data["cwd"] = cwd
    data["last_activity"] = time.time() - when
    SESSIONS[name] = {"info": data, "stats": STATS if when <= 1 else None,
                      "events": list(events), "modes": [],
                      "sl": SL.get(prov, "").format(repo=cwd.rsplit("/", 1)[-1], branch=extra.get("branch", "main"), ctx=148 if when <= 1 else 96),
                      "model": model or {"claude": "Opus 5.5", "codex": "gpt-6", "pi": "deepseek-v4", "kimi": "K3"}.get(prov)}
    SESSIONS[name]["state"] = state(st, status_line=SESSIONS[name]["sl"], **({"label": extra["label"]} if "label" in extra else {}))


def st(name, value, label=None, **extra):
    s = SESSIONS[name]
    s["info"]["state"] = value
    s["info"]["label"] = label
    s["state"] = state(value, label=label, status_line=s.get("sl"), **extra)
    for k, v in extra.items():
        s["info"][k] = v
    if value != "awaiting_input":
        s["info"].pop("question", None); s["info"].pop("options", None)
    s["info"]["last_activity"] = time.time()
    live(name)["label"] = label


def ev(name, *events):
    SESSIONS[name]["events"].extend(events)


N = {"n": 0}
def lid(p):
    N["n"] += 1
    return f"live-{p}-{N['n']}"


def tool(name, tname, inp):
    tid = lid("t")
    ev(name, call(tid, tid, tname, inp))
    return tid


def done(name, tid, text):
    ev(name, result(lid("r"), tid, text))


def stream(name, text, secs):
    steps = max(1, int(secs / 0.06))
    out = []
    for i in range(1, steps + 1):
        out.append((i * secs / steps, lambda i=i: live(name).update(preview=text[: int(len(text) * i / steps)])))
    return out


def commit(name, text):
    live(name)["preview"] = ""
    ev(name, msg("assistant_msg", lid("a"), text))
    SESSIONS[name]["info"]["last_reply"] = text.split("\n")[0][:80]


# ---------- scenes ----------
W = "/home/dev/projects"


def base_side(skip=()):
    rows = [
        ("docs-i18n", "pi", "working", f"{W}/acme-docs", "Translating 31/42 pages", 60),
        ("flaky-tests", "kimi", "working", f"{W}/acme-api", "Running the suite 3×", 90),
        ("mobile-release", "claude", "idle", f"{W}/acme-mobile", None, 3600),
    ]
    for name, prov, s, cwd, label, when in rows:
        if name in skip: continue
        extra = {"label": label} if label else {"last_reply": "Release notes for 2.4.0 are ready."}
        add(name, prov, s, cwd, [msg("assistant_msg", f"{name}-0", "Working on it.")], when, branch="main", **extra)


def pages(start):
    out = []
    for k in range(12):
        out.append((1.3 * k, lambda k=k: (st("docs-i18n", "working", f"Translating {min(42, start + k)}/42 pages"))))
    return out


def scene_agents():
    SESSIONS.clear()
    T = "api-webhooks"
    add(T, "claude", "working", f"{W}/acme-api",
        [msg("user_msg", "u1", "Verify Stripe webhook signatures and reject replays older than 5 minutes. Add tests.")], 1,
        branch="feat/webhooks", git_added=0, git_removed=0, label="Thinking…")
    add("checkout-review", "codex", "working", f"{W}/acme-web",
        [msg("assistant_msg", "cr0", "Reviewing the checkout diff.")], 20, branch="feat/checkout", label="Reviewing diff…")
    base_side()
    ANSWER = ("Webhooks are now **verified before any handler runs**.\n\n"
              "- `verifySignature()` checks the `Stripe-Signature` HMAC with a constant-time compare\n"
              "- events older than **5 min** are rejected as replays (`409`)\n"
              "- the event id is stored, so the same event is processed once\n\n"
              "```ts\nif (!verifySignature(raw, header, secret)) return res.status(400).end();\n"
              "if (isReplay(event, 300)) return res.status(409).end();\n```\n\n"
              "All **9 webhook tests pass**.")
    S = [(0.3, lambda: live(T).update(thinking="Find where webhooks are routed, then verify before parsing the body.")),
         (1.8, lambda: (live(T).update(thinking=""), st(T, "working", "Searching…"))),
         (1.9, lambda: SCR.__setitem__("g", tool(T, "Grep", {"pattern": "webhook", "path": "src"}))),
         (2.6, lambda: done(T, SCR["g"], "src/routes/webhooks.ts:12\nsrc/server.ts:48")),
         (3.0, lambda: SCR.__setitem__("r", tool(T, "Read", {"file_path": f"{W}/acme-api/src/routes/webhooks.ts"}))),
         (3.6, lambda: done(T, SCR["r"], "\n".join(f"line {i}" for i in range(64)))),
         (4.0, lambda: (st(T, "working", "Editing…"), SCR.__setitem__("e", tool(T, "Edit", {"file_path": f"{W}/acme-api/src/routes/webhooks.ts",
              "old_string": "const event = JSON.parse(raw);", "new_string": "if (!verifySignature(raw, header, secret)) return res.status(400).end();\nconst event = JSON.parse(raw);\nif (isReplay(event, 300)) return res.status(409).end();"})))),
         (4.8, lambda: (done(T, SCR["e"], "The file has been updated."), SESSIONS[T]["info"].update(git_added=38, git_removed=4, git_dirty=2))),
         (5.3, lambda: (st(T, "working", "Running tests…"), SCR.__setitem__("b", tool(T, "Bash", {"command": "pnpm test webhooks", "description": "Run webhook tests"})))),
         (6.0, lambda: (st("flaky-tests", "idle"), SESSIONS["flaky-tests"]["info"].update(last_reply="Timeout test is stable after 3 runs."))),
         (7.6, lambda: done(T, SCR["b"], " ✓ webhooks.test.ts (9 tests) 412ms\n Test Files  1 passed\n Tests  9 passed")),
         (8.0, lambda: st(T, "working", "Writing…")),
         (8.6, lambda: st("checkout-review", "awaiting_input", question="Apply the fix for the rounding bug?", options=["Yes, apply", "No, just report"])),
         ]
    S += [(8.1 + t, f) for t, f in stream(T, ANSWER, 3.6)]
    S += [(12.0, lambda: (commit(T, ANSWER), st(T, "idle")))]
    S += pages(31)
    return T, S


def scene_ask():
    SESSIONS.clear()
    T = "billing-totals"
    ev0 = [msg("user_msg", "u1", "Invoice totals are off by a cent on some carts. Find out why and fix it."),
           call("t1", "t1", "Grep", {"pattern": "round", "path": "src/billing"}), result("t1r", "t1", "src/billing/money.ts:41"),
           call("t2", "t2", "Read", {"file_path": f"{W}/acme-api/src/billing/money.ts"}), result("t2r", "t2", "\n".join(f"line {i}" for i in range(80))),
           msg("assistant_msg", "a1", "Found it: `money.ts:41` rounds **each line item** before summing, so a 3-item cart can drift by one cent.")]
    add(T, "claude", "working", f"{W}/acme-api", ev0, 1, branch="fix/rounding", label="Thinking…")
    add("checkout-review", "codex", "working", f"{W}/acme-web", [msg("assistant_msg", "cr0", "Reviewing.")], 30, branch="feat/checkout", label="Reviewing diff…")
    base_side()
    ANSWER = ("Fixed. Line items keep full precision and the total is **rounded once**.\n\n"
              "| Cart | Before | After |\n|---|---|---|\n| 3 × $3.335 | $10.02 | $10.01 |\n| 7 × $0.145 | $1.05 | $1.02 |\n\n"
              "Added a property test over 10k random carts — **12 tests pass**.")
    Q = "Round per line item or once on the total?"
    OPTS = ["Once on the total (recommended)", "Per line item, like today", "Ask finance first"]
    S = [(1.0, lambda: st(T, "awaiting_input", question=Q, options=OPTS)),
         (6.5, lambda: (ev(T, msg("user_msg", lid("u"), OPTS[0])), st(T, "working", "Editing…"))),
         (7.2, lambda: SCR.__setitem__("e", tool(T, "Edit", {"file_path": f"{W}/acme-api/src/billing/money.ts",
              "old_string": "sum + round(line.total)", "new_string": "sum + line.total"}))),
         (7.8, lambda: done(T, SCR["e"], "The file has been updated.")),
         (8.2, lambda: (st(T, "working", "Running tests…"), SCR.__setitem__("b", tool(T, "Bash", {"command": "pnpm test billing", "description": "Run billing tests"})))),
         (10.0, lambda: done(T, SCR["b"], " Tests  12 passed")),
         ]
    S += [(10.3 + t, f) for t, f in stream(T, ANSWER, 2.8)]
    S += [(13.4, lambda: (commit(T, ANSWER), st(T, "idle")))]
    S += pages(33)
    return T, S


def scene_pair():
    SESSIONS.clear()
    T = "checkout-redesign"
    G = dict(pair_peers=["checkout-review"], pair_gid="g-checkout", pair_task="Checkout redesign")
    ev0 = [msg("user_msg", "u1", "Redesign the checkout summary card and get it reviewed before pushing."),
           call("t1", "t1", "Edit", {"file_path": f"{W}/acme-web/src/CheckoutSummary.tsx", "old_string": "<Total />", "new_string": "<LineItems />\n<Total />"}),
           result("t1r", "t1", "The file has been updated."),
           msg("assistant_msg", "a1", "Summary card is split into line items and totals. Sent the diff to **checkout-review** for a second look.")]
    add(T, "claude", "idle", f"{W}/acme-web", ev0, 1, branch="feat/checkout", git_added=112, git_removed=40, git_dirty=5, **G)
    add("checkout-review", "codex", "working", f"{W}/acme-web", [msg("assistant_msg", "cr0", "Reviewing.")], 5, branch="feat/checkout",
        label="Reviewing diff…", pair_peers=[T], pair_gid="g-checkout", pair_task="Checkout redesign")
    base_side(skip=("mobile-release",))
    PEER = ("[de: checkout-review] Blocking: `money.ts:41` rounds each line item before summing, so a 3-item cart is off by one cent. "
            "Minor: the discount row renders when the discount is 0.")
    ANSWER = "Both fixed: the total is rounded once and the discount row hides at `0`. Sent the new commit back to **checkout-review**."
    S = [(1.2, lambda: (st("checkout-review", "idle"), SESSIONS["checkout-review"]["info"].update(last_reply="Two findings, one blocking."))),
         (1.6, lambda: (ev(T, msg("user_msg", lid("p"), PEER)), st(T, "working", "Thinking…"))),
         (2.2, lambda: live(T).update(thinking="Fix the rounding in money.ts first, then the discount row.")),
         (3.6, lambda: (live(T).update(thinking=""), st(T, "working", "Editing…"), SCR.__setitem__("e", tool(T, "Edit", {"file_path": f"{W}/acme-web/src/money.ts",
              "old_string": "sum + round(item.total)", "new_string": "sum + item.total"})))),
         (4.3, lambda: done(T, SCR["e"], "The file has been updated.")),
         (4.7, lambda: SCR.__setitem__("e2", tool(T, "Edit", {"file_path": f"{W}/acme-web/src/CheckoutSummary.tsx",
              "old_string": "<DiscountRow value={d} />", "new_string": "{d > 0 && <DiscountRow value={d} />}"}))),
         (5.3, lambda: done(T, SCR["e2"], "The file has been updated.")),
         (5.7, lambda: (st(T, "working", "Running tests…"), SCR.__setitem__("b", tool(T, "Bash", {"command": "pnpm test checkout", "description": "Run checkout tests"})))),
         (7.4, lambda: done(T, SCR["b"], " Tests  18 passed")),
         (7.8, lambda: SCR.__setitem__("s", tool(T, "Bash", {"command": 'hangar-send checkout-review "fixed in 3e1a9c0, tests green"', "description": "Tell the reviewer"}))),
         (8.4, lambda: done(T, SCR["s"], "delivered")),
         (8.8, lambda: st("checkout-review", "working", "Re-reviewing 3e1a9c0…")),
         ]
    S += [(8.9 + t, f) for t, f in stream(T, ANSWER, 2.0)]
    S += [(11.2, lambda: (commit(T, ANSWER), st(T, "idle")))]
    S += pages(35)
    return T, S


def scene_orq():
    # reuse fixture.py's orq sessions (built at import); rebuild from source by re-exec
    SESSIONS.clear()
    for n in ORQ_NAMES: SESSIONS[n] = copy.deepcopy(ORQ_SNAP[n])
    FX["PANEL"].clear(); FX["PANEL"].update(copy.deepcopy(PANEL_SNAP))
    base_side(skip=("mobile-release",))
    SESSIONS["checkout-arbiter"]["state"] = state("working"); SESSIONS["checkout-arbiter"]["info"]["state"] = "working"
    SESSIONS["checkout-arbiter"]["info"]["question"] = None
    T = "orq-checkout"
    ov, iso, P = FX["ov"], FX["iso"], FX["PANEL"]
    rows = P["tasks"]["rows"]
    now = 10700

    def notice(eid, text, **o):
        e = ov(lid(eid), now + N["n"] * 30, text, **o)
        ev(T, e)

    def task(n, s, rnd=None):
        rows[n - 1]["state"] = s
        if rnd: rows[n - 1]["round"] = rnd
        P["tasks"]["integrated"] = sum(1 for r in rows if r["state"] == "integrated")
    S = [(1.0, lambda: (notice("o", "rev", kind="dropped", task=2, sender="rev-t2",
                               body="Round 2 approved. Rounding now happens once on the total; tests cover 3-item carts.",
                               decided_by={"source": "jev", "jev": {"mode": "on", "choice": "nothing", "p": 0.93, "probs": {"nothing": 0.93}}}),
                        task(2, "approved"))),
         (3.0, lambda: (notice("o", "T2 integrated", kind="advance", task=2, line={"code": "integrated", "merge": True}), task(2, "integrated"),
                        st("rev-t2", "idle"), st("exec-t2", "idle"))),
         (4.6, lambda: (notice("o", "T4 opened", kind="advance", task=4, line={"code": "opened", "sessions": [
             {"name": "exec-t4", "provider": "kimi", "model": "k3"}, {"name": "rev-t4", "provider": "codex", "model": "gpt-6"}]}), task(4, "executing", 1),
             add("exec-t4", "kimi", "working", f"{W}/acme-web", [msg("assistant_msg", "x4", "Starting T4.")], 0, label="Reading plan…",
                 pair_gid="g-orq", pair_task="Checkout redesign (orchestrated)"),
             add("rev-t4", "codex", "idle", f"{W}/acme-web", [msg("assistant_msg", "r4", "Waiting for T4.")], 0,
                 pair_gid="g-orq", pair_task="Checkout redesign (orchestrated)"))),
         (7.0, lambda: (notice("o", "T3 delivered", kind="advance", task=3, line={"code": "delivered", "round": 1, "commit": "c7e21b4"}), task(3, "in_review"),
                        st("exec-t3", "idle"), st("rev-t2", "working", "Reviewing T3…"))),
         (9.5, lambda: st("exec-t4", "working", "Editing Breakpoints.css…")),
         ]
    S += pages(37)
    return T, S


def scene_group():
    SESSIONS.clear()
    for name, prov, st_, cwd, events, extra, sextra in FX["ROWS"]:
        data = info(name, prov, state=st_, **{k: v for k, v in extra.items() if k != "last_activity"})
        data["cwd"] = cwd; data["last_activity"] = extra.get("last_activity", time.time())
        SESSIONS[name] = {"info": data, "state": state(st_, **sextra), "events": [dict(e) for e in events], "stats": None, "modes": [],
                          "model": {"claude": "Opus 5.5", "codex": "gpt-6", "pi": "kimi-k3", "kimi": "K3"}[prov]}
    ev0 = SESSIONS["checkout-review"]["events"][0]
    ev0["text"] = ev0["text"].replace("[from: checkout-redesign]", "[de: checkout-redesign]")
    return "checkout-review", []


SCR = {}
SCENES = {"group": scene_group, "agents": scene_agents, "ask": scene_ask, "pair": scene_pair, "orq": scene_orq}
CUR = {"script": []}


def setup(name):
    with LOCK:
        LIVE.clear(); SCR.clear()
        target, script = SCENES[name]()
        CUR["script"] = sorted(script, key=lambda x: x[0])
        CUR["target"] = target
        EPOCH["n"] += 1
        bump()
    return target


def go():
    def run():
        t0 = time.time()
        for at, fn in CUR["script"]:
            d = t0 + at - time.time()
            if d > 0: time.sleep(d)
            with LOCK:
                fn(); bump()
    threading.Thread(target=run, daemon=True).start()


class L(FX["H"]):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/control/setup":
            self.send_json({"target": setup(parse_qs(url.query)["scene"][0])}); return
        if url.path == "/control/go":
            go(); self.send_json({"ok": True}); return
        super().do_GET()

    def stream_session(self, name):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        sent, version, epoch = set(), -1, EPOCH["n"]
        shown = {"thinking": None, "tool": None, "preview": None}
        try:
            while True:
                frames = []
                with LOCK:
                    s = SESSIONS.get(name)
                    if EPOCH["n"] != epoch:
                        epoch = EPOCH["n"]
                        frames.append(("reset", {}, None))
                        sent = {e["id"] for e in (s or {"events": []})["events"]}
                        version = -1
                    if s is not None:
                        lv = live(name)
                        if BASE["VERSION"]["n"] != version:
                            version = BASE["VERSION"]["n"]
                            frames.append(("state", {"session": name, **s["state"], "label": lv["label"]}, None))
                        for event in s["events"]:
                            if event["id"].startswith("live-") and event["id"] not in sent:
                                sent.add(event["id"])
                                frames.append(("message", event, f"fixture:{event['id']}"))
                        for slot, kind in (("thinking", "pensamento"), ("tool", "ferramenta")):
                            if shown[slot] != lv[slot]:
                                shown[slot] = lv[slot]
                                frames.append((kind, {"text": lv[slot]}, None))
                        if shown["preview"] != lv["preview"]:
                            shown["preview"] = lv["preview"]
                            frames.append(("preview", {"text": lv["preview"], "md": True, "full": True, "vivo": True}, None))
                for kind, body, eid in frames or [("ping", {}, None)]:
                    self.frame(kind, body, eid)
                time.sleep(0.06)
        except (BrokenPipeError, ConnectionResetError):
            pass


server = BASE["ThreadingHTTPServer"](("127.0.0.1", 47123), L)
print("Fixture URL: http://127.0.0.1:47123", flush=True)
server.serve_forever()
