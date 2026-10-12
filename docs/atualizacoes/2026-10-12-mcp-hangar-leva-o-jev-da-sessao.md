---
id: 2026-10-12-mcp-hangar-leva-o-jev-da-sessao
titulo: As ferramentas do navegador ganham o objetivo do Jev nas sessões abertas com ele
comando_posix: python3 scripts/registrar-mcp.py
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: scripts/registrar-mcp.py
destrutivo: false
---

Sessão aberta com o Jev agora pode pedir ao navegador embutido um objetivo inteiro ("preenche o
cadastro e salva") pelas ferramentas do MCP `hangar`, sem passar pelo terminal. Vale para as
sessões abertas depois da atualização.
