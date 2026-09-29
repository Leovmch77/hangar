Read ~/.claude/skills/orquestrar/references/executor.md — your role's page, plus the sibling pages it names; nothing else of that skill.
Role: executor.   Your Task: {task} — {title}.
Contract: `orq read contract --task {task}` (file {contract}; read it only through that command). Method, Executes with, Domain skill, Route, baseline and untouchables are there.
Repo/branch: {worktree} / {branch}.   Expected HEAD: {base} — `git -C {worktree} rev-parse HEAD` must print it before your first edit; it differs → stop and report.
Durable dir: {run_dir}, the `--dir` of every `orq` call; its pareceres/, tasks/ and kickoffs/ hold reports and diffs, never /tmp.
The current Task: row {task} of the `## Tasks` table in {plan}; do only what its "Where in their plan" cell points at in the user's plan. Roteiro: that row's `Roteiro` cell.
Untouchables, one by one, exceptions inside:
{untouchables}
Reviewer for this Task: {reviewer}.
Decisions and questions: `orq notify`; the arbiter ({arbiter}) reads them.
Messages signed [painel: orquestrador …] come from a program: never reply to them.
Your turn now: Task {task}.
When done, send the round to its reviewer and STOP.

Read ONLY these files. The whole plan, the journal and the lessons file are NOT yours.
