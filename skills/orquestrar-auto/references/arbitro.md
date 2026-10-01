# Role: arbiter (with the orchestrator)

Read-only in code from the user's "go ahead" to the end. The orchestrator runs the routine; you
are woken for what its rule cannot decide, decide it, and give the run back. Read this page
whole; open an `orquestrar` page only at the row that names it.

`orq` below = `~/.claude/skills/orquestrar/scripts/orq.py --dir <durable dir>`.

## Every wake

Messages prefixed `[painel: orquestrador <gid>]` come from the orchestrator, a program, not a
session: read them, never reply to them with `hangar-send`.

1. Read what woke you, then `orq read journal --last 30` and the last lines of
   `<durable dir>/timeline-<date>-<gid>.jsonl`.
2. Bookkeeping since the last wake, from the journal: each approving report's NOTED lines →
   contract, WASTE lines → `licoes.md` as guidelines, and into the `## Task N` section of every
   Task not yet released that needs them. Closes are the orchestrator's record, not yours.
3. Act on the row below; journal the decision with `orq log --task <N> "…"` before acting.
4. End with `orq advance`. Its output lists what the orchestrator did next.

Done when the case is journaled, `orq advance` ran, and `orq ball` names someone other than
you, or the user holds a decision.

## What wakes you, and what you do

| Wakes you | Do |
|---|---|
| `[painel: orquestrador <gid>]` a step with no rule (`regra sem saída`) | read the named Task's journal; decide as `~/.claude/skills/orquestrar/references/arbitro.md`, step 4 table, the closest row; unforeseen → ask the user, decision ready |
| a session's message the triage kept (Jev asked, the regex did not drop it, or triage is in `shadow`) | `~/.claude/skills/orquestrar/references/arbitro.md`, step 4 table; a `[decisao]` about a Task → answer its executor and its reviewer both. The timeline shows it `would_drop` and it needed you → `orq log "triage: would_drop needed the arbiter — <why>"` |
| merge conflict in a file the plan did not declare additive (`T<a> conflitou com T<b> em <file>`) | `~/.claude/skills/orquestrar/references/paralelo-worktree.md`, "Integration": the losing Task gets a correction round on the merged base, same executor. Its worktree `<repo>-<gid>-t<N>` and branch `<branch>-<gid>-t<N>` already exist: the round's worktree is `<repo>-<gid>-t<N>-r2` on branch `<branch>-<gid>-t<N>-r2`, from the merged tip. Then `orq event task_inicio` again for that Task and the replacement kick-off (below), with the old branch's commit as the approved diff. The round's `orq commit` reopens the integration by itself: never merge nor record `integrada` by hand |
| DEVOLVIDO | `~/.claude/skills/orquestrar/references/arbitro.md`, step 4, first row; wake the user only by `~/.claude/skills/orquestrar/references/arbitro-vigia.md`, "Deciding vs waking the user" |
| a Task past 2× its estimate (time or code rounds) | reassess; decide routine matters or ask in text with a recommendation and a 10 min deadline as arbitro-vigia.md defines. Do not stop for line counts; keep independent Tasks moving |
| red base: the plan's checks red on the branch with no Task to return it to | the user decides: fix first (a fix Task through the gate) or record a known failure the review ignores |
| `advance_falhou` (a `failed` timeline line: session not born, `hangar-send` refused, git failed) | read the output in the event. Session not born → open it by `~/.claude/skills/orquestrar/references/arbitro-lancamento.md`, "Opening a session", then the replacement kick-off. Git or repo state → resolve it in the tree only if it is not code; code → back to the Task's executor. Outside your reach → the user. Never re-run the failed step blindly |
| proof batch taken | `~/.claude/skills/orquestrar/references/prova-lote.md` |
| watchdog alarm | `~/.claude/skills/orquestrar/references/arbitro-vigia.md`, "Before acting on an alarm" and "Idleness"; replacement → "Rotation" there |
| the last wave integrated | "The end", below |
| your own context past your row's `janela` | "Succession", below |
| the user | answer; an order that changes the plan or the contract enters it before you use it |

## Replacement kick-off

The orchestrator fills the molds only for a Task it releases. For a session you open (replacement,
correction round after a conflict, a session the orchestrator failed to open), write the kick-off
of `~/.claude/skills/orquestrar/references/arbitro-lancamento.md`, "Kick-off", with
`Frozen round` when a round is in flight, and `orq event sessao_trocada --de <old> --para <new>
--motivo <reason>` before it for every replacement.

## Spiral with the user unavailable

The tightened criterion (`~/.claude/skills/orquestrar/references/arbitro-lancamento.md`,
"Tightened criterion") goes into the Task's `## Task N` contract section: the reviewer reads it
there.

## The end

`~/.claude/skills/orquestrar/references/arbitro-encerramento.md`, whole: the user's roteiro
(`Prova: manual`), the last proof batch, "Phase 4", the retrospective. Findings return as Tasks:
write each into the orchestration plan, stamp it again (`orq plan-check … --stamp`), then
`orq advance` releases them.

Before removing a worktree, confirm its completed sessions have been closed;
a live process may keep cwd/files in use. Do not disarm the watchdog when entering
the final phases: it closes each completed Task's executor and reviewer after idleness,
with group, identity and subagent protection.

Before `execucao_fim`, each Task worktree of the run (`git worktree list`, `<repo>-<gid>-t*`):
trail check first — `grep -rl "<worktree path>" ~/.local/bin <agent config dirs> <service unit
dir>` — then `git worktree remove <path>`. A hit in the trail → the user, not the remove. The
`<branch>-<gid>-t*` branches stay: deleting a branch is the user's call; list them in the closing
line.

Done when the branch is in the user's hands, the retrospective delivered, no worktree of the run
left, `orq event execucao_fim --resultado <result>` logged, completed sessions' closure
checked and only then the watchdog disarmed.

## Succession

`~/.claude/skills/orquestrar/references/arbitro-encerramento.md`, "Arbiter succession", with one
change: the successor's kick-off says to invoke the `orquestrar-auto` skill with the arbiter
role. After `orq event sessao_trocada`, every notice goes to the successor; its kick-off comes
from you; the watchdog stays untouched and proves its channel to the successor with `ARMED`.

## Locks

- Never do by hand what the orchestrator does (`SKILL.md`, "Locks"). A Task you want held →
  `orq log` the reason and ask the user; never race `orq advance`.
- Operational questions go in text, without blocking AskUserQuestion/request_user_input.
  Give a recommendation and a 10 min deadline; without a reply, apply the authorized recommendation
  within scope. Schedule a wake as arbitro-vigia.md defines; the watchdog/independent Tasks continue.
- The four files, the contract commands and the locks of
  `~/.claude/skills/orquestrar/references/arbitro.md` bind here too.
- Talk little with the user: one line when a wave closes; a decision only they can make,
  decision ready; something broke that you cannot solve.
