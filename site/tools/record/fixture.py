"""Synthetic backend for landing-page screenshots. Reuses task14 fixture handler; replaces sessions."""
import copy, pathlib, time
TOOLS = pathlib.Path(__file__).resolve().parents[3] / "desktop-native" / "tools"
import sys; sys.path.insert(0, str(TOOLS))
SRC = (TOOLS / "task14_sidebar_fixture.py").read_text(encoding="utf-8")
NS = {"__name__": "task14_base", "__file__": str(TOOLS / "task14_sidebar_fixture.py")}
exec(compile(SRC[:SRC.index("\nserver = BASE[")], "task14_sidebar_fixture.py", "exec"), NS)
BASE = NS["BASE"]; SESSIONS = BASE["SESSIONS"]; info = BASE["info"]; state = BASE["state"]; msg = BASE["msg"]
call, result = BASE["call"], BASE["result"]
NOW = time.time()

# Texto que aparece na tela, por língua (o live.py escolhe pelo lang do /control/setup). Código, comandos,
# saída de ferramenta, nomes de arquivo e de sessão ficam iguais nas duas.
SCENE_TEXT = {
    "en": {
        "rl_prompt": "Add rate limiting to the public API — 100 req/min per key, and return a proper 429 with Retry-After.",
        "rl_think": "I should find where requests are authenticated, then add a sliding-window limiter keyed by API key.",
        "rl_tests_desc": "Run rate limit tests",
        "rl_answer": ("Rate limiting is in. Every request is now checked against a **sliding window of 60 s per API key**.\n\n"
                      "```rust\nif let Err(wait) = limiter.check(&key) {\n    return Ok(too_many_requests(wait)); // 429 + Retry-After\n}\n```\n\n"
                      "| Scenario | Result |\n|---|---|\n| 100 req in 60 s | 200 OK |\n| 101st request | 429, `Retry-After: 12` |\n| New window | counter resets |\n\n"
                      "All **6 tests pass**. Next step: expose the limit in the `X-RateLimit-Remaining` header?"),
        "rl_reply": "Rate limiting is in.",
        "cr_prompt": "Redesign the checkout summary card.",
        "cr_answer": "Splitting the card into line items and totals.",
        "group": "Checkout redesign",
        "cr_label": "Editing CheckoutSummary.tsx",
        "rv_prompt": "[from: checkout-redesign] Summary card is done. Can you review the diff before I push?",
        "rv_diff_desc": "Diff summary",
        "rv_answer": ("Reviewed the diff. **Two findings, one blocking:**\n\n1. **Blocking** — `money.ts:41` rounds each line item before summing, "
                      "so a 3-item cart can be off by one cent.\n2. Minor — the discount row still renders when the discount is `0`.\n\n"
                      "I can apply the fix for #1 and send the patch back to `checkout-redesign`."),
        "rounding_q": "Apply the fix for the rounding bug?",
        "rounding_opts": ["Yes, apply", "No, just report"],
        "flaky_answer": "Iteration 3: the timeout test is stable now.",
        "running": "Running tests",
        "docs_answer": "Translated 42 pages to Portuguese and Spanish.",
        "docs_reply": "Translated 42 pages.",
        "release": "Release notes for 2.4.0 are ready.",
        "sc_tests": "Run tests", "sc_dev": "Dev server", "sc_lint": "Lint",
        "o3_body": "Round 1 approved. Money helpers are covered by tests; no blocking findings.",
        "o6_body": "Rejected round 1: `CheckoutSummary` rounds each line item before summing — a 3-item cart is off by one cent.",
        "o8_body": "The plan says to keep the old coupon field, but the API removed it last week.",
        "coupon_q": "Drop the legacy coupon field from the summary card, or keep it hidden behind a flag?",
        "tasks": ["Money helpers with exact rounding", "Summary card layout", "Coupon and discount rows", "Mobile breakpoint",
                  "Visual regression snapshots"],
        "orq_group": "Checkout redesign (orchestrated)",
        "arb_q": "Drop the legacy coupon field?",
        "arb_answer": "Waiting for your call on T3.",
        "e3_label": "Editing CouponRow.tsx",
        "e3_answer": "Working on coupon rows.",
        "r2_label": "Reviewing round 2",
        "reviewing": "Reviewing.",
        "e2_answer": "Round 2 delivered.",
    },
    "pt": {
        "rl_prompt": "Coloque limite de requisições na API pública — 100 req/min por chave — e devolva um 429 correto com Retry-After.",
        "rl_think": "Preciso achar onde as requisições são autenticadas e depois pôr um limitador de janela deslizante por chave de API.",
        "rl_tests_desc": "Rodar os testes do limite",
        "rl_answer": ("O limite de requisições está no ar. Cada requisição agora passa por uma **janela deslizante de 60 s por chave de API**.\n\n"
                      "```rust\nif let Err(wait) = limiter.check(&key) {\n    return Ok(too_many_requests(wait)); // 429 + Retry-After\n}\n```\n\n"
                      "| Cenário | Resultado |\n|---|---|\n| 100 req em 60 s | 200 OK |\n| 101ª requisição | 429, `Retry-After: 12` |\n| Janela nova | o contador zera |\n\n"
                      "Os **6 testes passam**. Próximo passo: mostrar o limite no cabeçalho `X-RateLimit-Remaining`?"),
        "rl_reply": "O limite de requisições está no ar.",
        "cr_prompt": "Refaça o card de resumo do checkout.",
        "cr_answer": "Separando o card em itens e totais.",
        "group": "Redesenho do checkout",
        "cr_label": "Editando CheckoutSummary.tsx",
        "rv_prompt": "[de: checkout-redesign] O card de resumo está pronto. Pode revisar o diff antes do push?",
        "rv_diff_desc": "Resumo do diff",
        "rv_answer": ("Revisei o diff. **Dois achados, um bloqueante:**\n\n1. **Bloqueante** — `money.ts:41` arredonda cada item antes de somar, "
                      "então um carrinho com 3 itens pode errar por um centavo.\n2. Menor — a linha de desconto ainda aparece quando o desconto é `0`.\n\n"
                      "Posso aplicar a correção do item 1 e mandar o patch de volta para o `checkout-redesign`."),
        "rounding_q": "Aplico a correção do arredondamento?",
        "rounding_opts": ["Sim, aplicar", "Não, só relatar"],
        "flaky_answer": "Iteração 3: o teste de timeout está estável agora.",
        "running": "Rodando os testes",
        "docs_answer": "Traduzi 42 páginas para português e espanhol.",
        "docs_reply": "42 páginas traduzidas.",
        "release": "As notas da versão 2.4.0 estão prontas.",
        "sc_tests": "Rodar testes", "sc_dev": "Servidor dev", "sc_lint": "Lint",
        "o3_body": "Rodada 1 aprovada. As funções de dinheiro estão cobertas por testes; nenhum achado bloqueante.",
        "o6_body": "Rodada 1 recusada: `CheckoutSummary` arredonda cada item antes de somar — um carrinho com 3 itens erra por um centavo.",
        "o8_body": "O plano manda manter o campo antigo de cupom, mas a API tirou esse campo na semana passada.",
        "coupon_q": "Tiro o campo antigo de cupom do card de resumo ou deixo escondido atrás de uma flag?",
        "tasks": ["Funções de dinheiro com arredondamento exato", "Layout do card de resumo", "Linhas de cupom e desconto",
                  "Breakpoint do celular", "Snapshots de regressão visual"],
        "orq_group": "Redesenho do checkout (orquestrado)",
        "arb_q": "Tiro o campo antigo de cupom?",
        "arb_answer": "Esperando sua decisão na T3.",
        "e3_label": "Editando CouponRow.tsx",
        "e3_answer": "Trabalhando nas linhas de cupom.",
        "r2_label": "Revisando a rodada 2",
        "reviewing": "Revisando.",
        "e2_answer": "Rodada 2 entregue.",
    },
}


def rows(t):
    chat = [
        msg("user_msg", "u1", t["rl_prompt"]),
        msg("thinking", "th1", t["rl_think"]),
        call("g1", "g1", "Grep", {"pattern": "fn authenticate", "path": "src"}), result("g1r", "g1", "src/middleware/auth.rs:24"),
        call("r1", "r1", "Read", {"file_path": "/home/dev/projects/acme-api/src/middleware/auth.rs"}), result("r1r", "r1", "\n".join(f"line {i}" for i in range(96))),
        call("e1", "e1", "Edit", {"file_path": "/home/dev/projects/acme-api/src/middleware/auth.rs",
            "old_string": "let key = authenticate(&req)?;\nnext.run(req).await",
            "new_string": "let key = authenticate(&req)?;\nif let Err(wait) = limiter.check(&key) {\n    return Ok(too_many_requests(wait));\n}\nnext.run(req).await"}),
        result("e1r", "e1", "The file has been updated."),
        call("b1", "b1", "Bash", {"command": "cargo test rate_limit", "description": t["rl_tests_desc"]}),
        result("b1r", "b1", "running 6 tests\ntest rate_limit::allows_burst ... ok\ntest rate_limit::returns_429 ... ok\ntest result: ok. 6 passed; 0 failed"),
        msg("assistant_msg", "a1", t["rl_answer"]),
    ]
    return [
        # name, provider, state, cwd, events, extra-info, extra-state
        ("api-rate-limit", "claude", "idle", "/home/dev/projects/acme-api", chat,
         dict(branch="feat/rate-limit", git_added=48, git_removed=6, git_dirty=3, last_reply=t["rl_reply"], last_activity=NOW - 40),
         dict(status_line="🤖 Opus5.5·1M (high✦) │ 📁 acme-api [feat/rate-limit*] │ 💬 9k/1.2k 184k/1M │ 💵 $0.92 │ ⏱ 14m")),
        ("checkout-redesign", "claude", "working", "/home/dev/projects/acme-web",
         [msg("user_msg", "c1", t["cr_prompt"]), msg("assistant_msg", "c2", t["cr_answer"])],
         dict(branch="feat/checkout", git_added=112, git_removed=40, git_dirty=5, pair_peers=["checkout-review"], pair_gid="g-checkout",
              pair_task=t["group"], label=t["cr_label"], last_activity=NOW - 5),
         dict(label=t["cr_label"])),
        ("checkout-review", "codex", "awaiting_input", "/home/dev/projects/acme-web",
         [msg("user_msg", "r0", t["rv_prompt"]),
          call("rv1", "rv1", "Bash", {"command": "git diff main --stat", "description": t["rv_diff_desc"]}),
          result("rv1r", "rv1", " src/CheckoutSummary.tsx | 112 ++++++----\n src/money.ts | 18 +-\n 2 files changed"),
          msg("assistant_msg", "r1", t["rv_answer"])],
         dict(branch="feat/checkout", pair_peers=["checkout-redesign"], pair_gid="g-checkout", pair_task=t["group"],
              question=t["rounding_q"], options=list(t["rounding_opts"]), last_activity=NOW - 20),
         dict(question=t["rounding_q"], options=list(t["rounding_opts"]))),
        ("flaky-tests", "kimi", "working", "/home/dev/projects/acme-api",
         [msg("assistant_msg", "k1", t["flaky_answer"])],
         dict(branch="main", loop_status="running", loop_iter=3, loop_max=10, label=t["running"], last_activity=NOW - 8),
         dict(label=t["running"], status_line="🤖 K3 (high✦) │ 📁 acme-api [main] │ 💬 ctx 120k/1M", loop_status="running", loop_iter=3, loop_max=10)),
        ("docs-i18n", "pi", "idle", "/home/dev/projects/acme-docs",
         [msg("assistant_msg", "p1", t["docs_answer"])],
         dict(branch="main", last_reply=t["docs_reply"], last_activity=NOW - 900), {}),
        ("mobile-release", "claude", "idle", "/home/dev/projects/acme-mobile",
         [msg("assistant_msg", "m1", t["release"])],
         dict(branch="release/2.4", last_reply=t["release"], last_activity=NOW - 3600), {}),
    ]


ROWS = rows(SCENE_TEXT["en"])

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
def shortcuts(t):
    return {"items": [
        {"id": "tests", "type": "shell", "label": t["sc_tests"], "command": "cargo test"},
        {"id": "dev", "type": "shell", "label": t["sc_dev"], "command": "npm run dev"},
        {"id": "lint", "type": "shell", "label": t["sc_lint"], "command": "cargo clippy"},
    ]}


SHORTCUTS = shortcuts(SCENE_TEXT["en"])

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
def orq_events(t):
    return [
    ov("o1", 60, "T1 opened", kind="advance", task=1, line={"code": "opened", "sessions": [
        {"name": "exec-t1", "provider": "claude", "model": "opus"}, {"name": "rev-t1", "provider": "codex", "model": "gpt-6"}]}),
    ov("o2", 1500, "T1 delivered", kind="advance", task=1, line={"code": "delivered", "round": 1, "commit": "4f2a9c1"}),
    ov("o3", 2100, "rev", kind="dropped", task=1, sender="rev-t1",
       body=t["o3_body"],
       decided_by={"source": "jev", "jev": {"mode": "on", "choice": "nothing", "p": 0.94, "probs": {"nothing": 0.94}}}),
    ov("o4", 2200, "T1 integrated", kind="advance", task=1, line={"code": "integrated", "merge": True}),
    ov("o5", 2300, "T2 opened", kind="advance", task=2, line={"code": "opened", "sessions": [
        {"name": "exec-t2", "provider": "kimi", "model": "k3"}, {"name": "rev-t2", "provider": "codex", "model": "gpt-6"}]}),
    ov("o6", 5400, "rev", kind="woke", task=2, sender="rev-t2", rejected_round=1,
       body=t["o6_body"],
       decided_by={"source": "rule", "rule": "mark"}),
    ov("o7", 7800, "T2 delivered", kind="advance", task=2, line={"code": "delivered", "round": 2, "commit": "a81d0e7"}),
    ov("o8", 8400, "exec", kind="woke", task=3, sender="exec-t3", mark="decisao",
       body=t["o8_body"],
       question=t["coupon_q"],
       decided_by={"source": "jev", "jev": {"mode": "on", "choice": "decision", "p": 0.91, "probs": {"decision": 0.91}}}),
    ]


def panel(t):
    titles = t["tasks"]
    return {"run": "2026-09-30-checkout", "gid": "g-orq",
    "metadata": {"title": t["group"], "plan": "docs/plans/checkout-redesign.md", "repo": "acme-web", "total_tasks": 5},
    "errors": [], "empty": False, "timing": {"started_at": iso(0), "finished_at": None, "elapsed_seconds": 3 * 3600},
    "tasks": {"integrated": 1, "total": 5, "total_known": True, "rows": [
        {"n": 1, "title": titles[0], "state": "integrated", "round": 1, "timing": {"started_at": iso(60), "finished_at": iso(2200), "elapsed_seconds": 2140}},
        {"n": 2, "title": titles[1], "state": "in_review", "round": 2, "timing": {"started_at": iso(2300), "finished_at": None, "elapsed_seconds": 8400}},
        {"n": 3, "title": titles[2], "state": "executing", "round": 1, "timing": {"started_at": iso(8000), "finished_at": None, "elapsed_seconds": 2800}},
        {"n": 4, "title": titles[3], "state": "queued", "round": None, "timing": {}},
        {"n": 5, "title": titles[4], "state": "queued", "round": None, "timing": {}}]},
    "team": [
        {"name": "checkout-arbiter", "role": "arbiter", "task": None, "current": True, "last": None},
        {"name": "exec-t3", "role": "executor", "task": 3, "current": True, "last": {"code": "started", "round": 1, "ts": iso(8000)}},
        {"name": "rev-t2", "role": "reviewer", "task": 2, "current": True, "last": None},
        {"name": "exec-t2", "role": "executor", "task": 2, "current": True, "last": {"code": "delivered", "round": 2, "ts": iso(7800)}}],
    "decisions": [{"task": 3, "ts": iso(8400), "question": t["coupon_q"], "parecer": None, "event_id": "o8"}],
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


PANEL = panel(SCENE_TEXT["en"])
def add(name, prov, st, extra, events=(), sextra=None):
    data = info(name, prov, state=st, **extra); data["cwd"] = "/home/dev/projects/acme-web"; data["last_activity"] = NOW - 30
    SESSIONS[name] = {"info": data, "state": state(st, **(sextra or {})), "events": list(events), "stats": None, "modes": [], "model": None}
def orq_sessions(t):
    G = dict(pair_gid="g-orq", pair_task=t["orq_group"])
    add("orq-checkout", "orq", "working", dict(orq_arbiter="checkout-arbiter", plan_task=3, plan_task_total=5, **G), orq_events(t))
    add("checkout-arbiter", "claude", "awaiting_input", dict(question=t["arb_q"], **G), [msg("assistant_msg", "ar1", t["arb_answer"])])
    add("exec-t3", "claude", "working", dict(label=t["e3_label"], **G), [msg("assistant_msg", "e31", t["e3_answer"])], {"label": t["e3_label"]})
    add("rev-t2", "codex", "working", dict(label=t["r2_label"], **G), [msg("assistant_msg", "r21", t["reviewing"])], {"label": t["r2_label"]})
    add("exec-t2", "kimi", "idle", dict(**G), [msg("assistant_msg", "e21", t["e2_answer"])])


orq_sessions(SCENE_TEXT["en"])
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
            # o live.py altera o PANEL sob o LOCK; serializar fora dele pega o dict no meio da mudança
            with BASE["LOCK"]:
                panel = copy.deepcopy(PANEL)
            self.send_json(panel); return
        if parts[:2] == ["api", "costs"] or parts[:2] == ["api", "uso"]:
            if not self.authorized(): return
            q = parse_qs(urlparse(self.path).query)
            self.send_json(report(q.get("period", ["30d"])[0])); return
        super().do_GET()
server = BASE["ThreadingHTTPServer"](("127.0.0.1", 47123), H)
print(f"Fixture URL: http://127.0.0.1:{server.server_port}", flush=True)
server.serve_forever()
