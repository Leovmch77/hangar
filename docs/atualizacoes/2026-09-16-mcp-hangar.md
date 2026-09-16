---
id: 2026-09-16-mcp-hangar
titulo: MCP do Hangar registrado no Claude Code e no Codex
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-mcp-headers ~/.claude.json
destrutivo: false
---

As sessões passam a ter o `hangar-send` e o `hangar-preview` como tools do MCP `hangar`
(listar sessões, recado, grupo, pareamento, sessão nova e navegador embutido sem passar pelo
Bash). A atualização registra o servidor no Claude Code
de cada conta e no Codex; sessão já aberta só o vê depois de reconectar (`/mcp`) ou reabrir.
