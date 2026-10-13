---
id: 2026-10-11-pergunta-respondida-no-terminal-fecha
titulo: Pergunta respondida ou recusada no terminal deixa de ficar aberta para o Hangar
destrutivo: false
---

Uma pergunta do Claude respondida ou recusada direto no terminal ficava registrada como aberta até
a sessão fechar, e a lista de sessões seguia conferindo-a. Agora o registro some quando a pergunta
termina. Não há nada a rodar: os hooks novos são gravados quando o backend reinicia, o que a
atualização já faz. Sessões já abertas passam a usá-los quando forem reabertas.
