---
id: 2026-10-01-par-externo-hangar-send
titulo: O hangar-send aceita convite de par externo e manda recado a sessão de outra pessoa
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

As sessões passam a poder parear com a sessão de outra pessoa por um link de convite, que só vale
quando você mesmo o cola na conversa. O pareamento externo aparece no `hangar-send --list`.
