---
id: 2026-09-28-link-hangar-abre-o-app-nativo
titulo: Links hangar:// passam a abrir o app nativo
comando_posix: ./scripts/install-native.sh --forcar
comando_windows: powershell -ExecutionPolicy Bypass -File scripts/install-native.ps1 -Forcar
prova: ~/.hangar/native/release.json
destrutivo: false
---

Clicar num link de convite `hangar://convite/...` agora abre o app nativo já com o convite colado, sem
entrar sozinho: a entrada só acontece no seu clique. Se o app já estiver aberto, é ele que vem para a frente.
