---
id: 2026-09-17-hangar-send-identidade
titulo: hangar-send marca a própria sessão e recusa recado para si mesma
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

`hangar-send --list` e a tool `sessoes` do MCP passam a indicar qual linha é a sessão que
perguntou, e um recado endereçado à própria sessão é recusado em vez de voltar para ela.
