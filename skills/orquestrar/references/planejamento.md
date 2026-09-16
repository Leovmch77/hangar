# Role: planner (phases 0, 1 and 2)

Drive the research, write the spec and the plan **with the user**, launch the team. Plan approved →
you become the arbiter: read `arbitro.md` and write no more code. Route `audit` → you are also the
writer (below).

## Method, domain skill and route come from the contract

Four lines in `regras-<gid>.md`, written at launch, repeated in every kick-off, never changed midway:

```markdown
Method: <name | none>            # what plans and executes — the user names it
Executes with: <command | none>  # the method's executing half; the executor's kick-off starts with it
Domain skill: <name | none>      # the step-by-step of this kind of work
Route: <audit | full>            # decided in phase 1, escalates only
```

- Ask the user which method, at the start. Never deduce; no default. `none` = the plan is the
  user's, from another ticket, or there is no written plan.
- A method has two halves. Planning half: spec and plan in phase 1; what it does not produce, you
  produce by hand. Executing half: what the executor invokes per Task; its command goes in
  `Executes with:` (`none` when there is none).
- Check both halves installed and tested in the account that executes, every time:
  `checar-skills.sh <names from the contract>`.
- Plan and execution come from the same method. Switching → `replanejar.md`, never a patch.
- Method ≠ engine (the model provider); a session has both, decided separately.
- Domain skill: the plan instantiates it, never repeats it. Each Task cites the skill step it
  executes, in the skill's order; the executor re-reads the skill first. `Domain skill:` is
  mandatory even as `none`.
- Two checks before Task 1 (gate item 13): no Task does what a skill step already does internally
  (that Task does not exist — demand the step's evidence inside the Task that contains it); no skill
  step without a Task citing it. Add the set-level verification the skill lacks.
- Never alter the domain skill to fit the work; adjust plan and contract. Waiving a skill step is
  the user's decision.
- Route `full` (default): the whole pipeline. Route `audit`: you write the code in this session
  after the "go ahead", one Task = one commit, no arbiter, executor or per-Task reviewer; a fresh
  read-only session reviews the whole diff (`revisao-final.md`), then the retrospective. Team
  table: `escritor` (this session), `revisão final`, `retrospectiva`.
- Propose `audit` only when all hold, and say which: every Task bounded and fully specified; small
  blast radius (no public contract, shared state, destination or credential change); few enough
  Tasks for one writer in one context. One fails → `full`. The user decides; no answer → `full`.
- The route only escalates: `audit` → `full` through `replanejar.md`, reason in the journal. No
  `solo`.
- Writer discipline on `audit`: stage by explicit path, no `--amend`/rebase/squash, one Task = one
  commit, verification pasted in the journal, no push, no MR.

## Two words: Task and step

- **Task**: the unit — name, files, verification, what blocks it. The gate opens and closes it; it
  becomes one commit. The method may call it a ticket or an item.
- **step**: the smallest checkable thing inside a Task (criterion, checkbox, numbered item).
- Method with no bottom layer → you write the steps in the orchestration plan.
- The only format dependency: the app's progress bar matches the literal `### Task N:` and
  `- [ ] **Step N: …**` format. The bar is optional; without the format the work runs the same.

## The orchestration plan

- Never rewrite, convert or copy the user's plan. It stays theirs, in their file, and stays the source.
- Write a second short file pointing at it, adding only what the gate needs:

```markdown
# Orchestration plan — <work>
User's plan: <absolute path>   (it is in charge; this file only orchestrates)

## Tasks
| # | What it is | Where in their plan | Files | Verification | Proof |
|---|---|---|---|---|---|
| 1 | create the schema | section "Database", 2nd paragraph | `<paths>` | `<test command>` | green suite + the table exists |

## What their plan does NOT decide, and I decided here
- Order: 1 before 2.
- Untouchables: <paths>.
- Bar for Task 2: <screen, width>.
```

- "Where in their plan" points at a section, paragraph, line or domain-skill step. Empty cell → the
  item goes in the bottom list; show that list to the user before launching.
- No plan at all → the orchestration plan is the plan, in the chosen method or by hand.
- Want the bar → write the steps in the literal format in the orchestration plan, never by
  reformatting the user's. A recipe shared by several Tasks → repeat the steps inside each Task.
  Before approving, open the plan in the app and compare the count with the steps written.

## Phase 0 — Research (only when the plan cannot be written without it)

- Read-only session or subagent, closed question, output in a file the plan cites. Protect it per
  `protecao.md`; a subagent inherits the protection or has a proven native restriction.
- "It doesn't exist" answers one query: write the phrase searched. Absence that supports a decision
  → redo the search by a second path. Zero rows from a DB or service is not proof of absence.
- Before declaring that something depends on the user's decision, re-read their material.

## Phase 1 — Spec and plan

### Team first, then the plan

- Ask about the team right after the spec closes, before Task 1.
- Read each chosen model's card in `~/.hangar/orq/modelos/`. No card → write the plan
  conservatively, do one sweep (vendor guide + community) into a `## What they say` section marked
  hypothesis, and create the card in the retrospective.
- MEASURED capability → protocol in the Tasks. HYPOTHESIS → one debut test in the first kick-off,
  then correct the card. Nothing untested becomes a kick-off rule.
- A step or recipe creating screen state fed by a request declares the three outcomes (success,
  failure, pending) and the WHEN of each call (mount × interaction).
- A recipe declared to close after another Task names WHO closes it: a planner session, never the
  arbiter (`replanejar.md`, the miniature).

### What the plan carries

- Task order; serial by default. Parallel batch only through `paralelo-worktree.md`, decided here
  with the user and the reason; audit the trigger yourself (gate items 3 and 4).
- A-priori estimate, one line per Task: expected clock and rounds. Actuals live only in
  `eventos.jsonl`; no second table. More than one authorized executor → consumption per model in
  quota and context (context per Task, sessions per Task, account/window per model, when the heavy
  model enters); the cards are the source.
- External precondition with an OWNER in every step that waits for something; the owner is the
  executor, as an explicit prior step.
- `Risk: low | high` per Task when the executor row is selected by risk. `low` = bounded, fully
  specified, small blast radius; `high` = judgment-heavy, wide blast radius, context-heavy, or
  touching a public contract, shared state, destination or credential. Proposed with the team,
  decided by the user; it only ever rises.
- Untouchables: paths with parallel changes in the tree, one by one.
- Verification per Task: exact command and what counts as passing. Orchestration Task (tmux, CLI,
  process, account, network) → smoke step against the real source, literal command.
- Bar per visual Task; what the review must cover; open decisions (goal: an empty list).
- Quota and fallback: each team account's remaining quota, pasted with the reading time, and the
  fallback authorized in writing. No money cap exists in this skill. The walls the arbiter reads:
  quota; context (half the window → rotate, `arbitro.md`); clock and rounds (2× the estimate → the
  arbiter asks).
- The team: engine and account per role.

### Shared state

- Two Tasks mounting hosts of the same store, singleton or registry are not independent, whatever
  the files.
- Found → write the ownership contract before the first of the two: who writes, who clears, what
  happens on unmount and on resize.
- An ownership rule that creates copies declares how many (Tasks touching the pattern) and either
  the unification Task at the batch's end or "the N copies stay, the set review checks all N".
- Inside one commit, two computations that must agree become one, derived in one place.
- Estimate a screen Task by the state it touches, not by the pixel. Code blockers reject rounds;
  mock divergences are notes.

### Review rigor before Task 1

- Write what the review must break: full flow in the UI or the real command, sibling callers of
  the changed symbol, concurrency (delayed response, double click, target switch mid-flight,
  unmount), final state on disk/storage/URL, which review skills per Task type.
- Visual Task → the list of states needing screenshots (both widths, overlay, fullscreen, whatever
  it affects).
- How many screenshots and who captures is the executor's call at execution time; the plan imposes
  no number and states what capture costs. A large sweep may go to a disposable capture session
  with the state list in its kick-off; the choice goes in the executor's report.
- A demand for new proof enters only with its owner in the same sentence.

### The bar

- One line per pixel-touching Task. Three tests, all mandatory: named (a specific screen), findable
  (absolute screenshot path, or an app screen that can be opened), comparable (same state, same
  width). A Task that draws nothing needs no bar.
- Propose; don't ask "what's the bar?". Two or three candidates already passed through the three
  tests, one sentence each on why it is hard, plus "no bar":

```
Task 3 touches the Settings sheet. Bar — pick one:
a) `EnginesSheet.svelte`, desktop, centered modal, 1440px — same `wide`/`centered` pair.
b) `Git.svelte`, same width — same glass material, with tabs.
c) A screenshot from another product — send me the path.
d) No bar for this Task.
```

- "No bar" chosen → `Bar: none — user's decision, <date>`; that Task's visual gate is the
  `executor-visual.md` protocol without the blind comparison.
- Weak candidates → say so and propose others.

### The team: you propose, the user chooses

- Model, engine, harness and account are the user's. `~/.hangar/orquestracao-contas.md` says what
  MAY be used, never what WILL; read it before assembling a team and copy into the contract only
  what this work uses. Missing or stale → take the inventory, ask, write the answer there with the
  date.
- Ask once, proceed on any answer:

> "Route `<audit | full>` (because <reason>). Do you want to pick the team (account and model per
> role), or do we go with the default?"

- Wants to pick → inventory, two or three combinations, they decide. No, or no answer → the
  default on the account in use: executor Opus effort `medium`; reviewer, arbiter, final review and
  retrospective Opus effort `high`; rows marked `default` with the date.
- Leaving the account in use, or entering a per-token account, requires the user's word.
- Inventory before proposing:

```bash
claude-engine                                        # engines
pi --list-models | awk 'NR>1{print $1}' | sort -u    # Pi providers — from the USER's shell (`fish -l -c`)
ls -d ~/.claude ~/.claude-*                          # Claude accounts
```

- Harness ≠ engine: list `--provider pi` and own CLIs too. Same-named models → full `provider/id`.
- No default cast; a model in an example is an example. Per Task: mechanical volume, subtle
  reasoning or visual judgment → who writes (possibly one writer per Task); where its error shows →
  what the reviewer must be able to do; visual Task with an executor that cannot see images →
  `executor-visual.md` vision protocol in the contract; account and quota → engines and fallback.
- One role, one session; no session holds two roles. Phase switch (planner → arbiter) and
  succession are not stacking. Final review in a fresh session. One writer per tree.
- Team table in `regras-<gid>.md`, `## Quem é quem`, raw values only (`-` = empty). Start from
  `<pair_dir>/regras-padrao.md` when it exists, adjusting only session names:

```markdown
## Quem é quem

| papel | sessão | provider | conta | modelo | esforço |
|---|---|---|---|---|---|
| árbitro | <work>-arbitro | claude | padrao | opus[1m] | high |
| executor | <work>-t* | claude | 200-01 | opus[1m] | medium |
| revisor | <work>-review | pi | clinepass | cline-pass/glm-5.2 | high |
| revisão final | <work>-final | claude | claude-200-3 | opus[1m] | high |
| retrospectiva | <work>-retro | claude | claude-200-3 | opus[1m] | high |
```

- `provider`: `claude` | `codex` | `pi` | `kimi`. `conta`: config-dir name on Claude (`padrao`,
  `200-01`); provider in `~/.kimi-code/config.toml` on Kimi; catalog provider on Pi;
  `openai-codex` on Codex. `sessão` ending in `*` = one session per Task.
- Optional `verificador` row (`<work>-verif-*`, own account/model/effort): delivers proofs; the
  reviewer still decides. Without it the reviewer runs the tests. Never add it to a running
  contract without authorization.
- Optional `vez` column (`| papel | vez | sessão | …`), one row per value; a role uses one
  selector: rotation (`vez` = 1, 2, 3; Task N → row `(N-1) % total`) or risk (`vez` = `low`/`high`;
  Task N → the row its `Risk:` line names). Rule in `arbitro-lancamento.md`.
- All pipeline roles in the table, phases 4 and 5 included. Final review with its trigger: "fires
  when every code Task is approved", never "after Task N".
- The table is machine-read: prose in a cell hides the role. Explanations go outside the table.
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

### Before approving

- Offer the adversarial pass (architecture subagent + explorer): cited files and symbols exist, the
  order holds, what breaks. Don't run it unasked; don't skip it. Pass no `model:` to the subagent.
- Run every verification command now, in the repo; paste the real output ("0 selected" included).
- `grep` every function, attribute and fixture the plan cites.
- Count tests; never estimate "Expected: N PASS".
- Check batch disjointness in the steps' text, not the "Files" block.
- The bar must be possible with the code the plan orders reused.
- A measurement Task sweeps more than one starting state and declares which.
- Cannot run it → mark `<!-- NOT VERIFIED: … -->`; the executor reads that as description.
- A claim about an external lib's behavior carries the mark or the installed source snippet.
- A Task that moves or retires something lists the consumers: two searches (code symbol, on-screen
  name) from the repository root minus untouchables minus dated history, covering infra, wrappers,
  docs, instruction files and mock helpers that point by string.
- A Task that extracts or moves code lists what the old home did for free: what reset, who owned
  the value after the await, what was dead there and becomes live.
- State shared between Tasks goes in the plan's HEADER, not inside a Task.
- No `___` in the estimates. Flaky provider → ≥2 sessions per Task (the card gives the rate).
- Factual claims in plan, excerpt and kick-off: measured, or written as "I assume", or absent.
- One debut at a time: a new method, a freshly edited skill and a new provider never share a run.

## Phase 1 exit gate

Close each item in writing, in the plan or the contract. AUDIT = check and paste the proof.
PRODUCE = write it in the orchestration plan.

1. AUDIT/PRODUCE — every Task has a name, files and a verification. Bar wanted → `parse_plan`
   output pasted.
2. PRODUCE — a-priori estimate per Task: clock and rounds.
3. AUDIT — non-collision proven: files per Task × `git merge-tree`, output pasted. Decides whether
   a batch exists; waived only when serial was declared upfront. Files from the steps' text, or
   from the repo via subagent.
4. AUDIT — shared state searched; ownership contract with copy count and who checks the N.
5. PRODUCE — bar, or `none — user's decision`, per visual Task.
6. PRODUCE — long screen Task: context-rotation point in the steps ("step N is a safe switching
   milestone").
7. PRODUCE — orchestration Task: smoke step, literal command.
8. PRODUCE — owner for every external precondition, including a stage on another device or
   process: directory the server rises from, port per Task, who holds the device and when it is
   released.
9. PRODUCE — parallel batch with visual proof: exclusive browser per executor, or proof as a
   critical section (`paralelo-worktree.md`).
10. AUDIT — remaining quota per account with reading time; fallback in writing.
11. AUDIT — method's executing half installed and tested, or `none` with the orchestration plan
    written.
12. AUDIT — adversarial pass offered, baseline green, every cited piece of code ran.
13. AUDIT — domain skill declared and its two checks done.
14. PRODUCE — `Route:` declared with its reason; `Risk:` on every Task when the executor row is
    selected by risk.

## Phase 2 — Launch (the user's single "go ahead")

- On `full`: you are now the arbiter. Read `arbitro.md` and run the launch of
  `arbitro-lancamento.md` ("Launch"): pre-flight, branch question, baseline, sessions, contract,
  kick-offs.
- On `audit`: open no session. Run the pre-flight, the branch question and the baseline of
  `arbitro-lancamento.md`; write the contract (skeleton below; three-row table, `Route: audit`)
  and the journal; write Task 1 yourself. Open phase 4's session when the last Task is
  committed, phase 5's after the branch is in the user's hands.

### The contract skeleton

Copy and fill; a field that doesn't apply gets `n/a`, never disappears. The rules file carries the
same minus the history (first lines: `arbitro.md`, "The four files").

````markdown
> Arbiter's journal. Group rules: <path to regras-<gid>.md>.
> Lessons: <path to licoes.md>. User's plan: <path>.
> Orchestration plan: <path | this very file>.
> Method: <name | none>. Executes with: <command | none>. Domain skill: <name | none>. Route: <audit | full>.
> Branch: <branch>. Starting HEAD: <hash>.

## Quem é quem
In the rules (`regras-<gid>.md`, fixed table `| papel | sessão | provider | conta | modelo | esforço |`).
Here only history: who took over from whom, when, why.
A group notice contradicting that table: the table wins.

## What the plan owns (point, don't copy)
Task order, steps, verification per Task, untouchables, phase-1 bars: <plan, section>.
Baseline: <command> → <result>, <date>.

## Review tooling (per Task type)
| Task type | Subagents/skills to dispatch | Don't use (reason in one line) |
|---|---|---|

## What the review must cover
<full flow, sibling callers, concurrency, final state, visual>

## Quota and fallback
<remaining quota per account, with reading time; where to migrate when it runs out>

## Bars decided AFTER plan approval
Task N — Bar: <screen, state, width> | none — user's decision, <date>

## Progress
| Task | Hash | Verdict | Who fixed |
|---|---|---|---|

## Supervening decisions
<date> — <decision, whose, reason in one line>
````
