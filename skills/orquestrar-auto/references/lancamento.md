# Arbiter — launch, then hand over to the orchestrator

Read whole once, at the user's "go ahead". Back to `arbitro.md` once the orchestrator has
released the first wave.

`orq` below = `~/.claude/skills/orquestrar/scripts/orq.py --dir <durable dir>`.

## 1. Pre-flight — as in `orquestrar`

Run `~/.claude/skills/orquestrar/references/arbitro-lancamento.md`, "Launch", items 1 to 5
whole: pre-flight (`git status --short`, `git branch --show-current`, `hangar-send --list`,
`$CP_SESSION_NAME`), where the work runs (the user creates or switches the branch, never you),
green baseline on the base with its hash, contract lines and account policy, tooling survey.
Red baseline → the user decides before anything opens.

Then, specific to this skill:

1. `## Quem é quem` has the rows the orchestrator opens, with `papel` written exactly
   `executor` and, on `Revisão: sessão`, exactly `revisor`; each `abertura` cell complete; the
   `executor` row's `sessão` ending in `*`. Missing or wrong → fix the contract with the user;
   the launch waits.
2. The orchestration plan is stamped (`orq plan-check <plan> --repo <repo> --stamp`) and states
   `Paralelo:`, `Integração:`, the additive files and the a-priori estimate.
3. Triage mode, from the user's word only: `--jev on` and `--regex on` when the user turned them
   on; otherwise both stay `shadow` (the timeline records `would_drop` and the arbiter wakes
   anyway).

Done when the baseline is recorded, the table has the rows above, and the triage mode is chosen.

## 2. The group — a gid before `orq init`

Create the orchestration group with you as its only member; open no session for it:

```bash
hangar-send --pair --orq "<work> — each session's role is in the regras-<gid>.md contract"
```

Read the `gid` in your own sidecar. An `--orq` group lives with one member while its auto run
is alive; the sessions the orchestrator opens join it through the watchdog.

Done when your sidecar carries the `gid` and the `orq` mark.

## 3. Contract, init, start event

1. Write `<config>/.hangar-pair/regras-<gid>.md` (skeleton in
   `~/.claude/skills/orquestrar/references/planejamento-equipe.md`; first lines in
   `~/.claude/skills/orquestrar/references/arbitro.md`, "The four files"), adding under them:

   ```markdown
   > Orchestrator: <gid>-orq, a program without a model. It releases Tasks, opens sessions, delivers kick-offs, merges and integrates. Its messages are signed [painel: orquestrador <gid>]; never reply to them.
   ```

2. Closing items in `<durable dir>/fechamento.md`
   (`~/.claude/skills/orquestrar/references/arbitro-encerramento.md`, "Closing items").
3. Init and start:

   ```bash
   orq init --auto --jev <shadow|on> --regex <shadow|on> --arbiter <you> --repo <repo> \
     --contract <regras path> --plan <user plan dir>/<user plan stem>.orq.md --untouchable <glob>…
   orq event execucao_inicio --plano <plan> --branch <branch> --gid <gid>
   orq advance --dir ~/.hangar/orq/<date>-<gid>
   ```

   Run `orq advance` right after, never wait for the watchdog: it releases the first wave. Its
   output lists the actions taken.

   The durable dir is `~/.hangar/orq/<date>-<gid>/`. A later change of triage mode or
   untouchables → `orq init` again with every argument, only that one changed.

Done when `orq.json` in the durable dir carries `"auto": true`, `execucao_inicio` is in the
journal and `orq advance` has run once.

## 4. Arm the watchdog

```bash
systemd-run --user --unit=vigia-<gid> --property=Restart=always --property=RestartSec=20 \
  ~/.claude/skills/orquestrar/scripts/vigia.sh <you> -e ~/.hangar/orq/<date>-<gid> -m 5
```

Its round also runs `orq advance`. Proof: the `[vigia] ARMED …` prompt arrives in your session
within 2 min; `active` is not proof. Never stop it to ask the user something: ask in text with a
default and let the orchestrator go on. It stops for good only after `execucao_fim`.

## 5. Hand over

1. Read the last lines of `<durable dir>/timeline-<date>-<gid>.jsonl`: one `advance` line per
   session opened and kick-off delivered, for every Task of the first wave.
2. `orq ball` names each released Task's executor.
3. `failed` line, or a Task of the wave missing → `arbitro.md`, row `advance_falhou`.
4. Tell the user in one line: work launched, how many Tasks in the first wave, where the
   orchestrator's row is in Hangar.

Done when the first wave's executors hold the ball. From here on, `arbitro.md`.

## Integration held by a conflict

The orchestrator stops integrating a Task whose merge conflicted outside the additive files.
Once you resolved it (`arbitro.md`, conflict row) and the Task's commit is merged on the branch,
unblock it by hand: `orq event integrada --task <N> --commit <HEAD>`, then `orq advance`.
