---
id: 2026-09-29-orq-remetente-e-ids
titulo: hangar-send --whoami e o orquestrador passam a guardar quem mandou cada recado e os ids das sessões do time
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

O orquestrador sem modelo passa a registrar quem mandou cada recado ao árbitro, a entrega de
cada rodada e a probabilidade que o Jev deu, para o painel da orquestração mostrar.
