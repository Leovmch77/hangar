---
id: 2026-09-17-mcp-tools-em-ingles
titulo: Tools do MCP do Hangar com nome em inglês, e sessão nova na conta certa
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send ~/.claude/CLAUDE.md
destrutivo: false
---

As dez tools do MCP `hangar` passam a se chamar `who_am_i`, `sessions`, `send`, `group`,
`pair`, `unpair`, `new_session`, `browser_open`, `browser` e `browser_batch`. Os nomes antigos
em português continuam funcionando, então sessão que já está aberta não quebra — ela só vê os
nomes novos depois de reconectar (`/mcp`) ou reabrir. Esta atualização reescreve o bloco
"Sessões-irmãs" do seu `~/.claude/CLAUDE.md` com os nomes de hoje.

Junto vai um conserto: criar sessão pela tool passava a usar a conta padrão da máquina em vez
da conta de quem pediu, mesmo dizendo que herdava. Agora ela herda de verdade, recusa quando
não consegue confirmar a conta, e devolve na resposta qual foi usada.
