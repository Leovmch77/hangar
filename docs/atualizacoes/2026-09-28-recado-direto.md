---
id: 2026-09-28-recado-direto
titulo: Recado entre sessões vai direto ao ponto, sem saudação
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

O bloco "Sessões-irmãs" do CLAUDE.md global passa a pedir que o recado para outra sessão leve só
a informação ou o pedido, sem "oi" nem apresentação: cada palavra vira prompt pago do outro lado.
