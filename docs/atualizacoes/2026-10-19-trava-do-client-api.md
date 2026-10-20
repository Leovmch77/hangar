---
id: 2026-10-19-trava-do-client-api
titulo: O commit que muda a API do app nativo sem subir o CLIENT_API é recusado
comando_posix: ./scripts/install-hooks.sh
prova: scripts/check-client-api.sh scripts/hooks/pre-commit
destrutivo: false
---

Quem commita no Hangar passa a ter o commit recusado quando mexe na API que o app nativo usa sem
subir o `CLIENT_API`; o CI confere o mesmo no push e no PR. Para quem só usa, nada muda.
