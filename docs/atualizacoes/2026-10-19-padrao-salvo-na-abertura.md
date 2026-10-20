---
id: 2026-10-19-padrao-salvo-na-abertura
titulo: Sessão aberta por outra sessão nasce no padrão salvo, e o hangar-send ganha --inherit
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

Modelo, esforço e modo de permissão que a sessão nova não pede vêm do padrão salvo no servidor, em
qualquer abertura. As sessões passam a saber disso pelo bloco "Sessões-irmãs" do CLAUDE.md global, e
`hangar-send --new --inherit` faz a filha nascer no modo de quem a abriu.
