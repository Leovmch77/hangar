---
name: preparar-plano
description: Prepares a plan for the orquestrar skill in a clean context. Use ONLY when the orquestrar planner dispatches it with the user's three answers (parallel, max simultaneous Tasks, proof mode). Rewrites the orchestration plan draft and stamps it; never touches the user's plan.
tools: Read, Grep, Glob, Bash, Write, Edit
model: inherit
---

# Prepare a plan for orquestrar

You get: the orchestration plan draft the planner wrote (`<user plan dir>/<user plan
stem>.orq.md`), the user's plan path, the repo path, and three answers —
`Paralelo:` (sequencial | até N), `Prova:` (nenhuma | por-task | lote(N) | manual — roteiros
kept; the user tests them all at the end), and, when given, `Correção pelo revisor:` (até N
linhas; default 20) and `Revisão:` (subagente | sessão; default subagente). Missing any of the
first two → reply only `faltam: <which>` and stop. You never ask the user anything: the planner
does.

## Steps

1. Read the draft and the user's plan whole, then the code they name. The user's plan is never
   edited. Keep every decision already in the draft: `Risk` per Task, estimates, owners,
   untouchables, the shared-state header, the "What their plan does NOT decide" section.
2. Check, writing each finding with `file:line`:
   - every symbol, file and command the plan cites exists (`grep`, `git ls-files`);
   - two Tasks touching the same files: `git merge-tree` over their file lists, output pasted;
   - what breaks if the order is followed (a Task using what a later one creates);
   - every Task's `Files` holds each file its steps must change to reach the behavior named: read
     the callers of the functions it changes and the module that owns the state it writes; a
     missing file → add it, with the `file:line` that makes it needed;
   - every behavior a roteiro or a Task expects from reused code (library, store, component) is
     found in that code or its installed source; not found → it moves to "What their plan does
     NOT decide" as an open decision;
   - every Task with proof has a roteiro the plan can support (what to run, what to look at,
     what counts as pass); a Task on a screen cites the `provar-tela` skill in its roteiro;
   - Task with independent responsibilities or distinct dependencies → separate those
     parts; line counts, including tests/translations, impose no split or block.
3. Build the waves: independent Tasks share a wave, never more per wave than `Paralelo:`.
   Suggest `Revisão: subagente` unless the user asked for another model or account to review.
   A Task on a screen → suggest `Prova: manual` unless the user asked for automated proof.
4. Rewrite the draft in place, in this shape and no other, carrying what step 1 kept:

   ```markdown
   # Orchestration plan — <work>
   User's plan: <absolute path>   (it is in charge; this file only orchestrates)

   ## Projeto
   Checagens: `<cmd>` · `<cmd>`          (or —)
   Integração: `<cmd>`                   (or —)
   Aditivos: `<file or glob>` · …        (or —: files where two Tasks insert at declared anchors)
   Prova: <answer>
   Paralelo: <answer>
   Revisão: <answer>
   Correção pelo revisor: até <N> linhas

   ## Tasks
   | # | What it is | Where in their plan | Files | Verification | Wave | Risk | Roteiro |
   |---|---|---|---|---|---|---|---|

   ## What their plan does NOT decide, and I decided here
   ```

   `Checagens:` are the commands the project already uses before a delivery (tests, lint,
   typecheck, build — whatever exists; read `package.json`, `pyproject.toml`, `Makefile`, CI
   files). None found → `—`, and say so in the report. `Risk`: `low | high` when the draft
   selects the executor row by risk, `—` otherwise. Roteiros go to `<user plan dir>/roteiros/`.
5. Run `python3 ~/.claude/skills/orquestrar/scripts/orq.py plan-check <the orchestration plan>
   --repo <repo> --stamp`. Fix every line it prints and run again until `plan-check ok` and the
   `Preparado:` line is written.
6. Reply with a short report, nothing else:
   - `Corrigi:` what you changed or decided, one line each;
   - `Não decidi:` what needs the user, one line each with the options;
   - `Plano:` the path, and the `Preparado:` line.
