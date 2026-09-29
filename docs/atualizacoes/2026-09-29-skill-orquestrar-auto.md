---
id: 2026-09-29-skill-orquestrar-auto
titulo: Nova skill orquestrar-auto, em que um programa solta as Tasks e o árbitro só decide
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.claude/skills/orquestrar-auto/SKILL.md
destrutivo: false
---

Chega a skill `orquestrar-auto`: a mesma orquestração com revisão independente, mas quem solta as
Tasks, abre executor e revisor e integra é um programa sem modelo. O árbitro só acorda para o que
a regra não resolve. Ela só entra em ação quando você pedir pelo nome.
