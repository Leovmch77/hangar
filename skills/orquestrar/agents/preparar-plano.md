---
name: preparar-plano
description: Prepares a plan for the orquestrar skill in a clean context. Use ONLY when the orquestrar planner dispatches it with the user's three answers (parallel, max simultaneous Tasks, proof mode). Writes the orchestration plan and stamps it; never touches the user's plan.
tools: Read, Grep, Glob, Bash, Write, Edit
model: inherit
---

# Prepare a plan for orquestrar

You get: the user's plan path, the repo path, the durable directory, and three answers —
`Paralelo:` (sequencial | até N), `Prova:` (nenhuma | por-task | lote(N) | manual — roteiros
kept; the user tests them all at the end), and, when given, `Correção pelo revisor:` (até N
linhas; default 20) and `Revisão:` (subagente | sessão; default subagente). Missing any of the
first two → reply only `faltam: <which>` and stop. You never ask the user anything: the planner
does.

## Steps

1. Read the user's plan whole, then the code it names. The user's plan is never edited.
2. Check, writing each finding with `file:line`:
   - every symbol, file and command the plan cites exists (`grep`, `git ls-files`);
   - two Tasks touching the same files: `git merge-tree` over their file lists, output pasted;
   - what breaks if the order is followed (a Task using what a later one creates);
   - every Task with proof has a roteiro the plan can support (what to run, what to look at,
     what counts as pass); a Task on a screen cites the `provar-tela` skill in its roteiro;
   - a Task too big for one session (the size line of `planejamento.md`) → cut it.
3. Build the waves: independent Tasks share a wave, never more per wave than `Paralelo:`.
   Suggest `Revisão: subagente` unless the user asked for another model or account to review.
   A Task on a screen → suggest `Prova: manual` unless the user asked for automated proof.
4. Write the orchestration plan at `<durable>/orq-plano.md`, in this shape and no other:

   ```markdown
   # Orchestration plan — <work>
   User's plan: <absolute path>   (it is in charge; this file only orchestrates)

   ## Projeto
   Checagens: `<cmd>` · `<cmd>`          (or —)
   Integração: `<cmd>`                   (or —)
   Prova: <answer>
   Paralelo: <answer>
   Revisão: <answer>
   Correção pelo revisor: até <N> linhas

   ## Tasks
   | # | What it is | Where in their plan | Files | Verification | Wave | Roteiro |
   |---|---|---|---|---|---|---|

   ## What their plan does NOT decide, and I decided here
   ```

   `Checagens:` are the commands the project already uses before a delivery (tests, lint,
   typecheck, build — whatever exists; read `package.json`, `pyproject.toml`, `Makefile`, CI
   files). None found → `—`, and say so in the report. Roteiros go to `<durable>/roteiros/`.
5. Run `python3 ~/.claude/skills/orquestrar/scripts/orq.py plan-check <durable>/orq-plano.md
   --repo <repo> --stamp`. Fix every line it prints and run again until `plan-check ok` and the
   `Preparado:` line is written.
6. Reply with a short report, nothing else:
   - `Corrigi:` what you changed or decided, one line each;
   - `Não decidi:` what needs the user, one line each with the options;
   - `Plano:` the path, and the `Preparado:` line.
