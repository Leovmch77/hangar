---
id: 2026-10-17-sessao-nova-herda-o-agente
titulo: A sessão criada por outra sessão nasce com o mesmo agente dela
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send ~/.claude/CLAUDE.md
destrutivo: false
---

O trecho "Sessões-irmãs" do seu `~/.claude/CLAUDE.md` passa a dizer que a sessão aberta por outra
(`hangar-send --new` ou `new_session`) sem escolher o agente nasce com o agente de quem a abriu, em vez
do último que o app lembrou. A resposta da criação diz de onde o agente veio.
