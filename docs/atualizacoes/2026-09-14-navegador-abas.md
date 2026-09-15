---
id: 2026-09-14-navegador-abas
titulo: Navegador embutido com abas — atualiza o hangar-preview e o bloco do CLAUDE.md
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-preview
destrutivo: false
---

O navegador embutido de cada sessão passa a ter abas. O painel ganha a faixa com `+` e `×`, e as
sessões aprendem os comandos `tab` e `--aba` do `hangar-preview`.
