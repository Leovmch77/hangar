# Arbiter — the end of the work

Read when the code Tasks are done, and when you step down. The two closing items are written at
launch (`arbitro.md`, "Before anything opens") and executed here.

## Closing items — written at launch, before the first session

```markdown
## Closing — own items, written at LAUNCH

- [ ] **Branch review** — trigger: every code Task approved. Fresh session, `<base>..tip`.
      Kick-off adds `Executor for findings: <session | none yet — ask the arbiter for one>`.
- [ ] **Retrospective (phase 5)** — trigger: the branch is in the user's hands and nothing in
      flight. Fresh session, `retrospectiva.md`. Product: a proposed patch for the skill, at
      `~/.hangar/orq/<date>-<gid>.md`. Kick-off carries: `Durable dir: <path>` ·
      `Branch range: <base>..<tip>` · `Skill repo: <path> (commit before the work: <hash>)` ·
      `Cards: ~/.hangar/orq/modelos/`. Before the request, generate `medicao/relatorio.json`
      per `consumo.md` and include its path, with the sources/periods left unmeasured; do it
      before moving the transcripts.
```

- Both roles have a row in `## Quem é quem` since launch (account, model, effort). Missing row → stop and ask, like any off-plan Task.
- The retrospective's trigger is never conditional on things having gone badly.
- Phase 5 launched after the first approval, with findings still becoming Tasks → record the addendum at that same moment:

```markdown
- [ ] **Retrospective addendum** — trigger: nothing in flight. Scope: the Tasks that entered
      after `<hash of the 1st approval>`. Fresh session, numbering continuing from the last P.
```

## Phase 4 — the branch review

- Trigger: every code Task approved. Never "after Task N". A manual Task (asset upload, domain, third-party account) is not a code Task.
- Always a fresh session (recipe in `arbitro-lancamento.md`) that took part in nothing; never a subagent of yours (a per-Task reviewer may be a fresh subagent; this one may not).
- Kick-off: the page pointer, `Role: branch review`, the range `<base>..<tip>`, the parallel paths to ignore, what is out of scope; which commits in the range the pipeline produced and which are foreign, and whether the foreign ones are reviewed or declared out of scope. A foreign commit that is the base of a Task gets a directed question.
- Findings return to the normal cycle. Push and MR are the user's.
- A rejecting final review needs a live executor: open one. Never you — not for an `{#each}` key, a CSS token or an `elif`. Record the author of each round's code in the contract, not only the hash (`eventos.jsonl` keeps it in the `veredito`'s `sessao` field).
- The user asked you for code directly → the request ends, you return to the gate.
- With a review open the tree freezes (per-Task rounds too; a docs-only commit earns a DEVOLVIDO). Must touch: announce first, with what; commit, never disk-only; send the new hash and what changed file by file; say what did not change, with the proof command `git diff --stat <hash-under-review> <new-hash> -- <code-dirs>` (empty = their work stands). "The file changed between two reads" → own it, give the new hash, freeze.
- Two final reviews in parallel: hold findings that overlap until both deliver, and tell each you are holding.
- Closing sentence to the user carries, beyond "approved": which commits in the range came from outside the pipeline; by which step (build, deploy, publish) the approved code reaches the screen they will open.

## The branch reopened after approval

- Two or more post-approval commits touching the same space → set review of the delta: fresh session, scope = the delta only, same format as the final review.
- A review finding enters as a Task through the gate. A new user request is new work: state the price before accepting — "It goes in, and the cost is one more set review before the push — or it waits until after the push, on its own branch." They choose; the push is theirs. The price is the set review, not the waiting time.

## Arbiter succession

When you leave: window above half, or the user changed the `árbitro` row (the "configuration changed in the panel" message names the `árbitro` role).

1. Finish the task at hand: the open gate closes or rejects. Dispatch no new Task.
2. Journal section `## Handover to the next arbiter (<output of date -Iseconds>)`: current Task and gate state; live sessions per role (name, account, model, effort, measured ctx) and which are retired; HEAD and `git status`; what is on disk uncommitted; pending items and what remains of the plan; the user's decisions not yet rules, one by one, dated; traps paid; absolute paths of plan, `regras-<gid>.md`, `licoes.md`, `eventos.jsonl`, durable dir; the last line written to `eventos.jsonl`; the closing items with who carries each; the bars decided. No line cap, no context copy: what the successor cannot discover from the files pointed at.
3. Open the successor by the usual recipe on the `árbitro` row's new configuration. Kick-off: invoke the `orquestrar` skill with the arbiter role; the journal path (handover section first), the rules, the plan; "take over: you are the arbiter from now on".
4. Change the `árbitro` row to the new name (the user already changed it via the panel: only the session name); log `sessao_trocada` (from, to, reason).
5. Tell the live executor and reviewer, 1:1: "the arbiter is now `<name>`; reports go to them".
6. One line in the journal ("left at <ctx>, successor `<name>` took over"); stop sending work. Don't kill your own session.

Locks for every baton pass, any role:

- Who leaves marks the origin of every decision written: `user, <date>` · `my decision, <date>` · `proposed, no answer`.
- Who arrives acts on nothing marked proposed or without origin; confirms with the user, not with the session that left.
- The handover points at the closing items and at files; it restates nothing and never says "read the previous transcript".
