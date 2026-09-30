# Planner — the team, the plan skeleton, the contract and the launch

Sibling of `planejamento.md`: "The team" is read at its step 3 ("Team first"), "The plan
skeleton" at steps 4 and 5, "Phase 2" and the contract skeleton at step 7. The
decomposition and the exit gate stay in `planejamento.md`.

`orq` below = `~/.claude/skills/orquestrar/scripts/orq.py --dir <durable dir>`.

## The team: configuration belongs to this work

1. Read the allowed-account policy; it limits options and does not select the team.
2. Read `GET /api/sessions/<work-session>/orq`. The UI and LLM use this same record.
   Without a group, `arquivo` is this work's draft; with a group, it is its contract.
3. Team already configured: preserve accounts, models, efforts, roles, order/rotation, window
   and flags; propose no replacement and repeat no choices. Ask only for a missing required
   field. Empty/- optional fields retain the provider's default; do not fill them yourself.
4. No team: configure the user's explicit choices through the UI or POST /orq.
   Load no default team, previous contracts or models from examples.
5. New names use this work's `session_prefix`. Preserve names explicitly selected for it
   and existing session links; do not close a session because the table changed.
6. Each role has its session as configured. The arbiter row defines who launches;
   if it is a new session, open it and transfer the approved plan and this record's reference.
   One writer per tree; fresh, independent final review.
7. At launch, link the SAME record to the real gid through POST /orq/grupo {gid, mtime}.
   The contract adds its other sections without rewriting the team table. Keep no other
   editable configuration in the plan, request or global file.

Done when the current work's record contains the explicit choices required by its roles.

## `## Quem é quem`

This work's own table, later linked to `regras-<gid>.md`; raw values
(`-` = selected optional default). Format example, without selecting roles/models:

```markdown
## Quem é quem

| papel | sessão | provider | conta | modelo | esforço |
|---|---|---|---|---|---|
| árbitro | <work>-arbitro | <selected> | <selected> | <selected> | <selected-or-default> |
| executor | <work>-t* | <selected> | <selected> | <selected> | <selected-or-default> |
| revisor | <work>-review* | <selected> | <selected> | <selected> | <selected-or-default> |
```

- `provider`: `claude` | `codex` | `pi` | `kimi`. `conta`: config-dir name on Claude (`padrao`,
  `200-01`); provider in `~/.kimi-code/config.toml` on Kimi; catalog provider on Pi;
  `openai-codex` (default account) or the account name (`~/.codex-<name>`) on Codex. `sessão`
  ending in `*` = one session per Task.
- Optional `abertura` column, last: the `hangar-send --new` flags the role opens with
  (`--headless`, `--permissao <mode>`, `--engine <engine>`, `--subagente <model>`, `--jev`);
  `-` = defaults. The panel writes it; copy it as is.
- Optional `janela` column, before `abertura`: the % of the session's own context window at
  which the arbiter decides the role's handover (`60%`); `-` = 50%. A reference, never an order
  to stop. The panel writes it; the watchdog reads it.
- Optional `verificador` row (`<work>-verif-*`, own account/model/effort): delivers proofs; the
  reviewer still decides. Without it the reviewer runs the tests. It enters a running contract
  only with the user's authorization.
- Optional `vez` column (`| papel | vez | sessão | …`), one row per value; a role uses one
  selector: rotation (`vez` = 1, 2, 3; Task N → row `(N-1) % total`) or risk (`vez` = `low`/`high`;
  Task N → the row its `Risk` column names). Rule in `arbitro-lancamento.md`.
- No review round goes to the arbiter, the last one included: the reviewer row judges every
  round, and the arbiter wakes for decisions and the next Task.
- All pipeline roles in the table, phases 4 and 5 included. Final review with its trigger: "fires
  when every code Task is approved", never "after Task N".
- The table is machine-read: cells carry raw values, explanations go outside the table.
- Below the table, one literal open command per role. Research, review, final review and
  verification commands carry `--read-only` (`protecao.md`); declare where writing tests run and
  where reports go; record the measurement command and its owner (`consumo.md`).
- More than one repository: header `Repo: <one> (+ <other> from T13 on)`; each row is born in its
  Task's repo; one writer per tree. Interfaces agreed before the sessions open:

```markdown
## Interfaces combinadas
- <route, payload, event or type agreed between the repos>
```

- Subagents read, sessions write: editing outside the cwd requires a real session in that repo. A
  session on another server (`servidor::sessao`) joins no group: 1:1 messages, and the agreement
  written into the local contract by hand.

## The plan skeleton

The orchestration plan (`planejamento.md`, steps 4 and 5), `<user plan dir>/<user plan
stem>.orq.md`: a second short file pointing at the user's plan, adding only what the gate needs.
`preparar-plano` rewrites the planner's draft into this shape; roteiros go to
`<user plan dir>/roteiros/`.

```markdown
# Orchestration plan — <work>
User's plan: <absolute path>   (it is in charge; this file only orchestrates)

## Projeto
Checagens: `<cmd>` · `<cmd>`          (or —)
Integração: `<cmd>`                   (or —)
Prova: nenhuma | por-task | lote(N) | manual
Paralelo: sequencial | até N
Revisão: subagente | sessão
Correção pelo revisor: até <N> linhas

## Tasks
| # | What it is | Where in their plan | Files | Verification | Wave | Risk | Roteiro |
|---|---|---|---|---|---|---|---|
| 1 | create the schema | section "Database", 2nd paragraph | `<paths>` | `<test command>` | 1 | — | — |

## What their plan does NOT decide, and I decided here
- Untouchables: <paths>.
```

`orq plan-check <plan> --repo <repo> --stamp` writes the `Preparado:` line under the title;
editing the plan afterwards voids it. `Risk`: `low | high` when the executor row is selected by
risk, `—` otherwise.

## Phase 2 — Launch (the user's single "go ahead")

- On `full`: the session selected as arbiter reads `arbitro.md` and runs the launch in
  `arbitro-lancamento.md` ("Launch"): pre-flight, branch question, baseline, sessions, contract,
  kick-offs.
- On `audit`: open no session. Run the pre-flight, the branch question and the baseline of
  `arbitro-lancamento.md`; write the contract (skeleton below; three-row table, `Route: audit`);
  the journal goes through `orq log`; write Task 1 yourself. Open phase 4's session when the
  last Task is committed, phase 5's after the branch is in the user's hands.

### The contract skeleton

Copy into `regras-<gid>.md` and fill; a field that doesn't apply gets `n/a` and stays in place.
Common part ≤ 8k characters; each Task's specifics in a `## Task N` section at the end, read by
executor and reviewer through `orq read contract --task N`. History (who took over from whom,
when, why) goes to the journal through `orq event sessao_trocada`, never here.

````markdown
<first lines: `arbitro.md`, "The four files">
> Lessons: <path to licoes.md>. User's plan: <path>.
> Orchestration plan: <path | this very file>. Starting HEAD: <hash>.

## Quem é quem
<the team table, "`## Quem é quem`" above>
A group notice contradicting that table: the table wins.

## What the plan owns (point, don't copy)
Task order, steps, verification per Task, untouchables, roteiros: <plan, section>.
Baseline: <command> → <result>, <date>.

## Review tooling (per Task type)
| Task type | Subagents/skills to dispatch | Don't use (reason in one line) |
|---|---|---|

## What the review must cover
<full flow, sibling callers, concurrency, final state>

## Quota and fallback
<remaining quota per account, with reading time; where to migrate when it runs out>

## Progress
| Task | Hash | Verdict | Who fixed |
|---|---|---|---|

## Supervening decisions
<date> — <decision, whose, reason in one line>

## Task N — <title>
<that Task's specifics: its worktree, its roteiro path, untouchable exceptions, recipe path>
````
