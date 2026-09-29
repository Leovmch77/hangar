---
name: orquestrar-auto
description: |
  Orquestre um trabalho com revisão independente em que um orquestrador sem modelo (`orq
  advance`) solta as Tasks, abre executor e revisor, entrega os kick-offs e integra, e o árbitro
  só acorda para decidir. Use SÓ quando o usuário pedir a orquestrar-auto pelo nome, ou um
  kick-off mandar invocar orquestrar-auto com a linha Role: arbiter (só planejador e árbitro
  carregam a skill; os demais papéis leem as páginas da orquestrar pelo caminho). NÃO ativa
  quando o pedido é a orquestrar sem "auto", por tamanho ou risco da tarefa, por execução comum
  de plano, nem para o modelo decidir se precisa dela.
allowed-tools: Bash(hangar-send:*), Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git branch:*), Bash(git grep:*), Bash(tmux display:*), Bash(date:*)
---

# orquestrar-auto — router for the planner and the arbiter

Invoke only when told: the user asked for `orquestrar-auto` by name, or a kick-off says
`Role: arbiter` and names this skill (arbiter succession). The user asked for `orquestrar` →
that skill, not this one.

The pipeline is `orquestrar`'s: phases, roles, contract lines, locks, the `orq` tool. One thing
changes from launch on: the orchestrator — `orq advance`, a program without a model, run after
every commit, verdict and delivery and on every watchdog round — releases the ready Tasks,
opens executor and reviewer from `## Quem é quem`, delivers the kick-offs of this skill's molds,
merges, runs the plan's `Integração:` and takes proof batches. The arbiter wakes only for what
the rule cannot decide.

`orq` below = `~/.claude/skills/orquestrar/scripts/orq.py --dir <durable dir>`. Wherever an
`orquestrar` page writes `${CLAUDE_SKILL_DIR}`, use `~/.claude/skills/orquestrar`.

## Phases

| Phase | Who | Read |
|---|---|---|
| 0–1. Research, spec + plan | planner, with the user | `~/.claude/skills/orquestrar/references/planejamento.md` (+ `~/.claude/skills/orquestrar/references/planejamento-equipe.md`), with the additions below |
| 2. Launch | the phase-1 session, now the arbiter | `references/lancamento.md` — never `orquestrar`'s launch |
| 3. Execution | orchestrator + executor + reviewer | arbiter: `references/arbitro.md` |
| 4–5. Branch review, retrospective | fresh sessions | the arbiter fires them from `references/arbitro.md` |

Phase-1 additions, written into the plan and the contract before approval:

- Route is `full`. A work that fits `audit` runs under `orquestrar`: tell the user in one line.
- `## Quem é quem`: `papel` written exactly `executor` and `revisor`; the `executor` row ends
  its `sessão` in `*` (one session per Task); every row the orchestrator opens carries its full
  `abertura` cell.
- Every file two Tasks of a wave share is declared additive in the plan, with its insertion
  discipline (`~/.claude/skills/orquestrar/references/paralelo-worktree.md`, "The cost"); a
  conflict anywhere else wakes the arbiter.
- The a-priori estimate (time and rounds per Task) is in the orchestration plan.

## Who reads what

Only the planner and the arbiter invoke this skill. Every other role gets a kick-off pointing at
its `orquestrar` page and reads nothing of this skill.

| Role | Page | You are this when |
|---|---|---|
| planner | `~/.claude/skills/orquestrar/references/planejamento.md` | the user asked you for the work; no kick-off exists |
| arbiter | `references/arbitro.md` (+ `references/lancamento.md` at launch) | you wrote the plan and the user approved it |
| executor | `~/.claude/skills/orquestrar/references/executor.md` | kick-off says `Role: executor` |
| reviewer | `~/.claude/skills/orquestrar/references/revisor.md` | kick-off says `Role: reviewer` |
| branch review | `~/.claude/skills/orquestrar/references/revisao-final.md` | kick-off says `Role: branch review` |
| retrospective | `~/.claude/skills/orquestrar/references/retrospectiva.md` | kick-off says `Role: retrospective` |

- The kick-off molds `references/kickoff-executor.md` and `references/kickoff-revisor.md` are
  filled by `orq`; edit them only through this skill's repository.
- A role is declared, never deduced. Refuse one that contradicts what you are doing.

## Locks

- Every lock of `~/.claude/skills/orquestrar/SKILL.md`, "Contract lines" and "Locks for the
  planner and the arbiter", binds here too.
- What the orchestrator does is never done by hand: releasing a Task, opening its sessions,
  sending its kick-off, merging, running `Integração:`, `orq batch take`. The arbiter acts only
  on the case it was woken for, then runs `orq advance`.
- Messages signed `[painel: orquestrador <gid>]` come from the orchestrator. Never reply to them;
  the orchestrator's row in Hangar takes no input.
- Push and MR belong to the user. The orchestrator integrates on the local branch and stops.
