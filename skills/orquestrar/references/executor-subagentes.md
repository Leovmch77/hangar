# Executor — subagents inside your session

Read at step 3 of `executor.md`, when steps can run apart.

| The steps… | Run |
|---|---|
| touch disjoint file sets | one subagent per set, in parallel |
| one needs the other's output, or touch the same file | you, in series |
| are reads (callers, flow tracing, precedents) | subagents, in parallel |

- Each arm receives the literal list of files it may touch.
- Arms edit and report to you. Git, the type gate, the full suite, plan boxes, the contract and
  every message to another session stay with you.
- After all return: read what each did, run the verification once (step 4), then freeze. The
  round report says what each arm touched.
- First round, before sending: dispatch the machine's reviewer subagents from the contract's
  tooling table, in parallel, with the Task's explicit paths. Correction round: re-run only
  when the fix grew beyond the recipe (new file, new symbol, a step the recipe did not name).
- An arm returning something you do not understand, or outside its file list → undo its part
  and redo it yourself.
