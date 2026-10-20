---
id: 2026-10-20-grupo-entre-maquinas-hangar-send
titulo: As sessões sabem que o grupo junta várias máquinas e leem o contrato de qualquer uma
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.local/bin/hangar-send
destrutivo: false
---

Parear com uma sessão de outra máquina passa a formar um grupo que junta as duas, e o aviso de
grupo chega a todas. As instruções que as sessões leem dizem isso, e o contrato do grupo pode ser
lido e gravado de qualquer máquina com `hangar-send --contrato` ou pela ferramenta `contract`.
Recado de uma pessoa de fora que chega por outra máquina do grupo é respondido uma vez só, por
aviso de grupo.
