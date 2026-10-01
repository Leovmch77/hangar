# Executor — verification that does not lie

Read at step 4 of `executor.md`.

## Run

- The command the plan defined for this Task, cwd-independent (explicit prefix or directory).
- Once per round, after the last edit; never between edits. Red → rerun only what failed.
- The round's verification commands go out together: chained in one Bash, or parallel calls in
  one message; never one command per response.
- `set -o pipefail` or `${PIPESTATUS[0]}`: `command | tail && echo OK` prints OK on failure.
- Before sending (the round is uncommitted, so diff against HEAD, never `<base>..HEAD`):
  `git diff HEAD -- <file>` shows only what the Task asked; check removed lines with
  `git diff HEAD | grep -E '^-.*(role=|aria-|try|catch|await)'`.
- Output goes to a file in the durable directory (`<command> > <durable>/out-task-<N>-r<R>.txt
  2>&1`); read `tail -n 40` and `grep -nE 'FAIL|Error|error\['` of it, never the file whole,
  and paste those lines in the report.
- A retry budget per failure family counts from the base where that family first failed: before
  calling a failure new, check whether its cause is already in that base. Reclassifying a family
  is the arbiter's decision, before any run.

## Proof

Before pasting a proof, say what would make it fail. Then:

- A proof of something served checks what the target loaded, never what your side built.
- "X shows up when it should not" needs a negative assertion on the same real fixture.
- Real world before mock; mock only after the real one failed, saying why.
- A round proved by reading, not by running: each mock, stub and claim about code outside the
  diff cites the file:line, or the installed source, it stands for; nothing to cite → drop the
  stub or the claim.
- A long-lived service serves the code from when it started: check its start time against the
  commit, or bring up your own instance. The user's service keeps running.
- A blocker fix ships with its trap in the same round: the test that fails without the fix
  exists; undo the fix and watch it go red. Same for a finding an automatic reviewer raised.
  A check this work writes down ships the same way: run it once in the state it exists to catch,
  and paste the red.
- Mutation runs in a detached worktree: `git worktree add --detach <tmp>/mut-<x> <object>` →
  apply → run → `git worktree remove --force`. The tree you commit stays intact.

## The proof stage

- Own `HOME`: `HOME=<proof dir> <command> --directory <worktree>/...`.
- The project's installers (`install*.sh`) stay unrun.
- Own instance, torn down at the end; the user's services keep running.
- Kill by exact PID. Used `pkill -f` anyway → say so unprompted.

## Waiting on an external condition (any step)

- Cap: the plan's ceiling for this wait; none written → 10 attempts or 10 minutes. Blew it → stop and report "waiting on <condition>; tried N
  times over T", last return pasted.
- A wait still valid past the cap: report it as above and record it, `orq event espera --task <N>
  --sessao <you> --ate <deadline> --motivo "<condition>"`; keep your own finite check, end the turn. Only your next recorded
  event or the deadline ends it; never record one just to clear it.
- An identical response 3 times in a row → change the check, or stop and report.
- The stage of your proof (server, test account, proof session) is created by you, as an
  explicit step, before checking. Repeated exit 0 is as stalled as repeated error.
- A shared-resource lock (`orq lock take`, `executor.md`) is not an external wait: no cap, run
  it again until it is yours.

## Report line

```
Removed lines: <output of the removed-lines `grep` of "Run", or "none">
Served: <start time of the long-lived service against the round, or your own instance — or "nothing served">
```
