---
id: 2026-10-01-plugin-juncao-windows
titulo: No Windows, o plugin do Hangar passa a acompanhar o git pull em vez de ficar numa cópia
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.claude/skills/hangar/.claude-plugin/plugin.json
destrutivo: false
---

No Windows a atualização deixava uma cópia do plugin do Hangar na pasta de skills, que envelhecia
a cada atualização. Rodar a atualização de novo troca essa cópia por um link para o plugin do
repositório, que passa a acompanhar cada versão nova. Com o link já no lugar, a atualização o
reconhece e não o recria.
