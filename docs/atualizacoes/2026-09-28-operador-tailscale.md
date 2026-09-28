---
id: 2026-09-28-operador-tailscale
titulo: Compartilhar sessão pede o operador do Tailscale, uma vez
destrutivo: false
---

Para compartilhar uma sessão, o Hangar precisa ligar o Funnel do Tailscale por conta própria, e o
Tailscale só deixa isso para o operador da máquina. Se você ainda não fez, rode uma vez no
terminal: `sudo tailscale set --operator=$USER` (o diálogo de compartilhar também mostra o
comando quando falta). A atualização não roda isso sozinha porque pede a sua senha; instalações
novas já fazem.
