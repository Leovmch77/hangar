---
id: 2026-09-29-lancador-electron-renomeado
titulo: No menu de apps, a janela Electron passa a se chamar "Hangar (Electron)"
comando_posix: f="${XDG_DATA_HOME:-$HOME/.local/share}/applications/hangar.desktop"; [ ! -f "$f" ] || sed -i 's/^Name=Hangar$/Name=Hangar (Electron)/' "$f"; mkdir -p ~/.hangar/native && touch ~/.hangar/native/lancador-electron-renomeado
prova: ~/.hangar/native/lancador-electron-renomeado
destrutivo: false
---

Com o app nativo instalado, o menu de apps mostrava dois itens chamados "Hangar". Agora "Hangar" é
o app nativo e a janela Electron aparece como "Hangar (Electron)".
