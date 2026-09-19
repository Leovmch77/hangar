---
id: 2026-09-19-hook-barrado-aparece
titulo: Mensagem barrada por hook aparece no chat, e hook do Hangar que falha avisa
destrutivo: false
---

Quando um hook do Claude Code barra o envio, a mensagem passa a aparecer na conversa marcada como
"não chegou", com o erro que o hook escreveu — antes ela sumia, e sem terminal o erro não aparecia
em lugar nenhum. Os hooks do próprio Hangar deixam de falhar calados no início da sessão e no
envio de mensagem: a sessão recebe um aviso e conta para você. Não há nada a rodar: o comando
novo dos hooks é gravado quando o backend reinicia, o que a atualização já faz.
