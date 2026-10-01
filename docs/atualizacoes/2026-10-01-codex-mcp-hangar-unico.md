---
id: 2026-10-01-codex-mcp-hangar-unico
titulo: O Codex e o ChatGPT voltam a abrir quando o config.toml ficou com o MCP hangar duplicado
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

Se o app desktop do Codex reescreveu o `config.toml`, o Hangar registrava o MCP `hangar` de novo
e o arquivo ficava inválido: o ChatGPT e o Codex paravam de abrir com "não foi possível carregar
as configurações". Agora o registro reconhece o bloco em qualquer formato e conserta o arquivo
duplicado sozinho.
