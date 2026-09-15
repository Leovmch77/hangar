---
id: 2026-09-14-deploy-health-rollback
titulo: Deploy verifica a subida do backend e restaura a versão anterior em caso de falha
destrutivo: false
---

O auto-deploy passa a conferir HTTP 200 e a resposta do Hangar em /api/peers/ping, usando a
porta configurada no backend. Só confirma a atualização após três respostas válidas, com dois
segundos de intervalo e o mesmo PID novo da unit. São até dez tentativas, cada consulta HTTP
limitada a dois segundos.

Uma falha restaura o SHA anterior, o dist preservado e as dependências que o deploy alterou.
O deploy termina com erro mesmo quando a recuperação funciona. Se o rollback também falhar,
interrompe o serviço para evitar o crash-loop, preserva o backup e indica intervenção manual.
Os trechos do journal ficam em arquivo privado no diretório de backup informado pelo script.

O script é executado do checkout: basta receber este commit, sem reinstalar serviços.
A sonda comprova a subida da API; não valida individualmente tmux, provedores ou sessões.
