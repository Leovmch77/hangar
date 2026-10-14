---
id: 2026-10-12-navegador-nas-instrucoes
titulo: Os agentes sabem usar o navegador embutido e mostrar desenhos dentro da conversa
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send ~/.claude/CLAUDE.md
destrutivo: false
---

O trecho "Sessões-irmãs" do seu `~/.claude/CLAUDE.md` passa a dizer quando o agente mostra um
desenho ou comparação dentro da conversa (em vez de mandar uma imagem), como ele troca de página e
pede o seu login no navegador embutido, e que ele espera quando você pausa o navegador.
