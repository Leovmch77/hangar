---
id: 2026-10-19-protocolo-do-grupo-pelo-servidor
titulo: O protocolo do grupo volta depois de /clear pelo hangar-server, sem Python
destrutivo: false
---

Depois de /clear, compactação ou retomada, a sessão num grupo recebe de novo as regras do grupo
pelo próprio `hangar-server`, mesmo com o servidor parado. Num grupo com sessão de outra pessoa, ela
passa a receber as regras do grupo e o aviso sobre a pessoa de fora, em vez de só o aviso. Não há
nada a rodar: o hook novo é gravado quando o backend reinicia, o que a atualização já faz.
