# Arbiter — autonomy: the watchdog, the silence, the swap, and when to wake the user

Read when arming the watchdog (once, at launch), when an alarm arrives, when a session must be
replaced, and when unsure whether to decide alone or wake the user.

## Who owes work

- You always know who has the ball: the executor of the released Task, or the reviewer of the open round.
- Owner `working` → nothing to do. Never ask "how's it going?".
- Owner `idle` and nothing received → one of three, resolved without asking anyone:
  1. the message didn't arrive → resend once, saying it is a resend;
  2. the reply was produced and not sent → read its transcript (`~/.claude*/projects/<sanitized-cwd>/<uuid>.jsonl`, the most recent, messages `type: "assistant"`, the last one);
  3. the session vanished → "A vanished session", below.
- Session silent 15 min → `hangar-send --list`; `idle` without a report → read its transcript, then nudge. `working` with the same last command for 3 readings is a loop, not work.
- Look at the disk before resending. Look at the recipient's pane before blaming the channel: a first-run assistant open there is what the backend reports as "session unavailable".
- Whole team idle without a Task having closed → something didn't arrive.

## Arming

```bash
systemd-run --user --unit=vigia-<gid> --property=Restart=always --property=RestartSec=20 \
  "${CLAUDE_SKILL_DIR}/scripts/vigia.sh" <who has the ball> <arbiter> -m 5 \
  -d ~/.hangar/orq/<date>-<gid>/registro.md
```

- The last name is always the arbiter; `-d` points at the journal (60 min without a write dings you). Flags and liveness checks: the header of `vigia.sh`.
- The list is whoever has the ball now, plus you — never the whole cast, never the pair together, never a session not yet opened, retired, or stopped by your order.
- Two windows have nobody waiting and are the watchdog's: kick-off → first round, and APROVA → commit. Mid-loop, whoever waits for the ball notices the silence.

| Window | List |
|---|---|
| kick-off dispatched → 1st round delivered | `<executor> <arbiter>` |
| round delivered → verdict | `<reviewer> <arbiter>` |
| APROVA → commit reported | `<executor> <arbiter>` |

- Parallel batch: every writer in ONE watchdog — `vigia.sh t1 t2 t3 review review2 arbitro -m 10 -d …`.
- Rewrite the command at every handoff; whoever takes the ball rewrites it with their own name. After a REPROVA the ball passes reviewer → executor without you.
- Remove yourself from the list while an executor has the ball; put yourself back when nobody does.
- Nobody with the ball = disarm. Ball with the user = nobody: disarm before asking, re-arm on the answer.
- Kill the old watchdog when retiring a session. One live watchdog, pointed at the current pair.
- The command goes into no file; the form does.

## Before acting on an alarm

Compare the watchdog's list with the last line of `eventos.jsonl`:

| Last line | The ball is with |
|---|---|
| `task_inicio` | the Task's `executor` |
| `entrega` | the round's `revisor` |
| `veredito` `reprova` | the `executor` |
| `veredito` `aprova` | the `executor`, until the `commit` field appears |
| `execucao_fim` | nobody — disarm |

Mismatch → re-arm, don't nudge; a session waiting exactly as ordered is not stalled.

## What it does

- Watches everyone on the list, including you. Wakes via `hangar-send --tmux`.
- Fires when the current owner stops, not when everyone stops; `vanished` counts as stopped. Immediate, without waiting for silence: a stuck session (`working`, no event for 10 min) and a session out of quota.
- To team sessions it ASKS, evidence attached; to you it may be affirmative. Stop orders come from you, after looking, never from the counter.
- Proof it works: the `[vigia] ARMADA …` prompt arrives in your session within 2 min of arming. `active` is not proof; a hand-typed test is not proof. Liveness: journal over one full cycle, `show -p ActiveState -p MainPID`. Work in progress with `ps -eo pid,ppid,cmd | grep vigia.sh` empty, or pointing at a retired pair, is work without a net.
- It is the net; a session's message arriving as a prompt is the normal path.

## Night mode — three preconditions

Before letting the team run without the user, all three:

1. Watchdog proven — the synthetic alarm arrived.
2. Quota checked — each provider's remaining quota covers the night at this work's measured per-Task average.
3. Fallback valid — the provider plan B the contract authorized in writing still exists.

Any failing → stop at the current Task's end and wake the user before sleeping.

## A vanished session

Gone from `hangar-send --list` and from tmux without your order → open another and move on. No investigation.

1. Read its transcript (most recent jsonl, `assistant` messages) and its pane (`tmux capture-pane -p -t "=<name>:" -S -200`): the report or review may be there, complete.
2. Open the substitute by the recipe in `arbitro-lancamento.md`, full kick-off.
3. One line in the contract: which session vanished, what was recovered, who took over.

It becomes a case only if the repo is strange (unexplained dirty tree, unreported commit, untouchable touched) — then the subject is the repo.

## Rotation

- Executor: one session per Task, retired at the approved milestone.
- Mid-gate swap, mandatory: the same cause failing round after round; context above half its own window. Never wait for the gate to close.
- Writer above 50% of its own window: the writer measures and asks in its report; you open the substitute before the next round, never "at the next milestone".
- Reviewer above 50%, or `current ctx + measured round cost` crossing the cap: open the substitute before the correction arrives; never dispatch a round to one that said it crossed. Measure a round's cost on Task 1 and add it before dispatching.
- The trigger is a fraction of each session's own window, never an absolute number.
- Screen Task with a short-window reviewer: count one reviewer per round. A wide-window model on the user's machine → suggest it for the plan from round 1; the user chooses; no rule depends on it.
- Provider drops are not a reason; throughput is: swap when ctx barely moves between drops, or no revival after two nudges.
- Handover in a file that points: HEAD, `git status`, uncommitted disk, what remains, traps paid, paths of plan, contract and Task excerpt, and every decision made. No line count; never a context copy.
- Retiring is an act with a message: stop, don't capture, don't commit, release the stage without killing. In the same act tell the reviewer the new address.
- Mid-gate: release, don't kill. Closed milestone (approved, committed, nothing in flight): end the session by name via the API, at once.
- The substitute gets the full kick-off (`arbitro-lancamento.md`) with `Frozen round`, and proves model/effort before its first `Edit`. Interrupted turn → list the half-edited paths as untrusted draft.
- Arbiter leaving → `arbitro-encerramento.md`.

## Deciding vs waking the user

| Situation | Do |
|---|---|
| plan cites a renamed symbol/file, intent clear | decide, record in the contract |
| recipe applied, tests green | decide: ask the verdict on the resulting diff |
| verification missing from a report | decide: demand it from executor/reviewer; never run it |
| scope, architecture or a public contract the plan closed changes | wake |
| two readings of the plan → different work | wake |
| team quota close to running out | stop at the Task's end, wake; never mid-Task |
| irreversible outside the repo (push, MR, domain, upload, payment) | always the user |
| another session writing in the tree | resolve with it; unresolved → wake |
| phase-1 item missing (untouchables, verification command) | decide the conservative default, record, report later |
| Task touches pixels, plan brought no bar | wake before releasing — `arbitro-lancamento.md`, "Visual Task without a bar" |

Score before waking; the highest axis wins. 8+ → stop and wait. 4–7 → ask without stopping: declare decision and default, proceed. 0–3 → decide, record, report later. Stop between Tasks, never during. Wake with the decision ready: stakes, options, recommendation.

| Axis | 0–3 | 4–7 | 8–10 |
|---|---|---|---|
| Undo | one commit | another round | push, MR, money, deleting the user's things |
| Authorship | fixes what they asked | equivalent paths | changes what the product does |
| Account | inside the table | inside, quota tight | outside the table |

- A finding about the REPORT (caption, executor report, command description, review report) is fixed in the report; only a product finding pays new proof. Caption fix: an image repeating another frame declares it and points at the real proof; an image showing a defect says so and names it.
