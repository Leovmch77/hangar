---
id: 2026-09-14-headless-cli-preview
titulo: Codex sem terminal no CLI e navegador embutido em sessões sem terminal
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send ~/.local/bin/hangar-preview ~/.claude/skills/hangar-preview/SKILL.md
destrutivo: true
---

O `hangar-send` passa a criar sessões Codex sem terminal, e o `hangar-preview` identifica
automaticamente sessões Claude e Codex sem depender do tmux. A atualização reinstala os CLIs,
a skill do navegador e o bloco de instruções das sessões.
