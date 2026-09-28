# Paridade do chat nativo com o compositor web

Situação ao fim da Task 5 (barra direita e controles da sessão). **Implementado** = código no cliente Rust; **conferido** = exercitado na janela real com fixture sintética (`parity-task4-report.md` para o compositor, `parity-task5-report.md` para a barra direita e os controles); **pendente** = fora do cliente ou adiado, com o motivo. Não há paridade total: terminal, navegador, árvore/Git completos, voz e administração global são módulos à parte (fim do arquivo).

## Compositor

| Capacidade (web) | Estado | Observação |
|---|---|---|
| Enter envia, Shift+Enter quebra linha | conferido | já existia |
| Rascunho por servidor + sessão + transcript | conferido | troca de sessão preserva; sessão recriada (outro `jsonl`) não herda |
| Anexar pelo seletor do sistema (vários arquivos) | conferido | portal do desktop; lê fora da janela e confere 100 MiB antes de ler |
| Colar imagem / arquivo copiado | conferido (imagem) | `on_paste` do campo; arquivo copiado usa o mesmo caminho do seletor, não exercitado |
| Arrastar e soltar | implementado | `on_drop` de caminhos externos na área do compositor; não exercitado (sem fonte de arrasto automatizável) |
| Miniatura, nome, estado (na vez, enviando, enviado, falhou) e remover | conferido | remover só tira do campo; nunca apaga o que já está no servidor |
| Upload: corpo cru, `Content-Type`, `X-Filename` percent-encoded, Bearer, teto 180 s | conferido | um por vez; o que já subiu não sobe de novo numa nova tentativa |
| Falha de upload preserva texto e anexos; queda vira incerteza sem repetir | conferido | 413 com motivo; queda de conexão = aviso de incerteza, 1 POST por clique |
| Montagem do prompt (`legenda — 📎 imagem: <caminho do servidor>`, quadros e fala de vídeo) | conferido (imagem) | quadros/fala por teste compilado; marcador sempre em português (os parsers só reconhecem essa forma) |
| Resposta atrasada vai para a sessão de origem | conferido | anexos saem só da sessão que enviou; rascunho da sessão aberta intacto |
| Reanexar upload recente (`GET /uploads` + download) | conferido | lista as 20 mais novas com tamanho |
| Prévia/encolhimento de imagem e HEIC antes de subir | pendente | enviado como está; diferença deliberada |
| Progresso em % do upload | pendente | mostra "enviando anexos: n de m" e o estado por anexo |
| Áudio vira transcrição | pendente | recusado com motivo (voz e serviço externo fora desta sequência) |
| Sugestão de comandos ao digitar `/` (setas, Tab completa) | conferido | até 8, prefixo antes de substring |
| Folha de comandos com busca e grupos | conferido | estados carregando, vazio, erro com "tentar novamente" |
| Argumento, destrutivo e Codex preenchem; o resto envia | conferido | preencher sobre rascunho pede confirmação |
| Destrutivo exige confirmação mesmo digitado | conferido | confirmação vale só para o texto que a pessoa viu |
| `/model`, `/effort`, `/btw` (tela que não existe aqui) | conferido | aviso de dependência, nada é enviado |
| Tab aceita a sugestão do terminal com o campo vazio | conferido | evento SSE `suggest` |
| Ctrl+L foca o campo | conferido | a raiz da janela trata o atalho e segura o foco quando nada mais o tem (inclusive depois de fechar o diálogo) |
| Esc | conferido | fecha sugestão/painel/confirmação, também com o foco fora do campo (painéis de controle, comandos, recentes); com a sessão trabalhando pede confirmação para interromper, e só o Claude com terminal avisa que recebe Esc (Codex e sem terminal param pelo backend) |
| Interromper com confirmação | conferido | vale também para sessão sem terminal aguardando |
| Interromper devolve a mensagem digitada agora no terminal que ainda não entrou na conversa (`clear=true` só nesse caso) | conferido | mensagem na fila durável (`delivered:false`) fica com a fila e sai `clear=false`; no web o Esc interrompe direto, aqui confirma (pedido do plano) |
| Orientar turno com texto (`/steer {text}`, Codex e sem terminal) | conferido | botão "Orientar agora" com a sessão trabalhando |
| Promover fila (`/steer` sem corpo) | conferido | Task 3, sem regressão |
| Modelo, esforço, modo e permissão da sessão (fileira abaixo do campo) | conferido | ver "Controles da sessão" |
| Chip de git, anel de contexto, estatísticas do turno | conferido | na barra direita, não no compositor |
| Enviar ao par/grupo, voz, câmera, orquestrar, prévia, shells | pendente | módulos fora desta sequência |

## Controles da sessão

| Capacidade | Estado | Observação |
|---|---|---|
| Quais controles por provider | conferido | Claude: modelo, esforço, modo; Codex: modelo, esforço, modo, permissão; Pi/Kimi: modelo, esforço. Implementados sem exercício: esforço some no Haiku; omp usa as rotas do Pi |
| Catálogo lido no gesto de abrir, das rotas do provider | conferido | `model/options`, `permission-modes`, `models`, `codex-permissions`, `pi/models`, `kimi/models`; nada lido ao montar ou reconectar |
| Leitura que mexe no terminal (ciclo do Claude com terminal, permissão do Codex com terminal) | conferido | só com o botão "Ler do terminal"; ciclo desconhecido deixa os modos indisponíveis sem afirmar motivo |
| Aplicar: pílula "aplicando…", sucesso com o valor que o backend devolveu, falha mantém o valor real com o motivo | conferido | 409 e 503 com motivo; queda = incerteza |
| Resposta que volta com outra sessão aberta | conferido | aviso e rótulo ficam com a sessão de origem; o valor vivo capturado no gesto decide até quando o rótulo aplicado vale |
| Carregando, vazio, erro com "Tentar novamente" | conferido | "Tentar novamente" relê sem fechar o painel |
| No máximo uma linha marcada como atual | conferido | Kimi por nome exato (nome repetido entre providers não marca nenhuma); Claude pela linha de status antes do `active` do picker, com a janela de 1M decidindo entre `opus` e `opus[1m]`; esforço do Claude exato ou abreviado (`med`) |
| Codex: outro modelo leva o esforço padrão dele; mesmo modelo mantém o esforço | conferido | corpo do `POST /model` no log da fixture |
| Mudança de padrão da conta | pendente | fora do escopo por decisão (só `scope: session`) |

## Barra direita

| Capacidade | Estado | Observação |
|---|---|---|
| Estado, detalhe e loop (n/máx, fase) | conferido | stream da sessão; sem conversa, o da lista |
| Modelo, contexto usado/janela, custo, último turno, parada há, tempo de sessão | conferido | parser portado de `core/statusline.ts`; desconhecido aparece como tal, nunca zero |
| Estatísticas do turno (evento `stats`) | conferido | turnos, chamadas, tokens, LLM/ferramentas, tok/s, 1ª resposta, cache |
| Custo do Codex por `GET /cost` | conferido | só com o painel visível e a sessão aberta, a cada 30 s; parar/trocar de sessão cancela; falha mantém o último valor com o motivo |
| Limites (5 h, semana, 30 dias) e limite atingido com horário de volta | conferido | medidores com cor por faixa |
| Aviso de contexto (60% / 85%) com Compactar | conferido | Claude e Codex; Compactar preenche `/compact` e protege rascunho |
| Aviso de contexto para Pi/Kimi | pendente | o web mostra para qualquer provider com contexto medido; aqui a métrica aparece sem o aviso |
| Aviso de recarregar (Claude sem terminal) | conferido | só com a sessão parada, confirmação explícita; aviso some quando o backend limpa |
| Projeto: repo, branch, sujo, +/− | conferido | Codex e sem terminal leem a branch da lista |
| Arquivos alterados e diff | conferido | `git/files` e `git/diff` (leitura); carregando, vazio, erro; sem nenhuma operação Git |
| Atalhos da config (`send_text`, `shell`, anexos) | conferido | direto, preencher com proteção, shell só após confirmar e só pela rota existente; internos de terminal/navegador/modo/rodar não aparecem |
| Fila da sessão | conferido | contagem no rodapé do painel |
| Recolher e redimensionar | conferido | 240–480 px; some sozinho se a conversa ficaria abaixo de 540 px |
| Fileira de abas (Contexto, Arquivos, Atividade, Git) no desenho da `.abas` do web | conferido | régua de ponta a ponta, sublinhado na escolhida, texto de 12 px; rótulo da primeira na margem de 16 px das seções; as quatro inteiras a 300 px, reticências a 240 px. Diferenças: o recolher mora na mesma fileira (o web o põe no cabeçalho com nome e estado, que aqui ficam no cabeçalho da conversa) e Git é aba, não o botão que abre a coluna do web |

## Ciclo e planos

| Capacidade | Estado | Observação |
|---|---|---|
| Codex antes da conversa (`tracked=false`): pergunta da lista respondida por `/select` | conferido | confere que a pergunta não mudou antes de enviar; falha com motivo; a conversa abre sozinha quando o transcript aparece |
| Implementar plano do Claude sem terminal parado em modo plano | conferido | troca para o modo anterior, envia o pedido; envio recusado volta ao plano; troca recusada e incerteza têm aviso próprio |
| Âncora do plano sem terminal pelo `anchor_id` da descoberta | pendente | usa a última resposta do turno; o pedido enviado é o mesmo, só a âncora pode diferir num turno com várias respostas |
| Plano do Claude com terminal (`/plan-preview`) | conferido | descoberta ao abrir e ao fim do turno; conteúdo só no gesto "Ler plano" |

## Módulos à parte (dependências, sem simulação)

Terminal embutido, navegador, árvore de arquivos e Git completos (stage, commit, troca de branch), voz, gestão global de sessões/contas/modelos, Board/Canvas e os atalhos internos que dependem deles. Windows/macOS e desempenho seguem sem alegação.

## Conversa

| Capacidade | Estado | Observação |
|---|---|---|
| Mensagem com marcadores mostra só a legenda e os anexos | conferido | imagem inline pelos bytes do cofre; arquivo como nome + ações |
| Imagem colada no terminal (`image_count`) | conferido | `/transcript-image`; sem duplicar quando o caminho também foi escrito |
| Caminhos citados pelo assistente (absoluto, `~/`, relativo com pasta) | conferido | `/file?path=`; recusa do backend aparece com o motivo dele |
| Abrir | conferido | cópia privada (pasta 700, nome saneado com a extensão preservada) entregue ao programa padrão; só tipos passivos, conferidos no nome gravado |
| Salvar | conferido | diálogo do sistema; HTML/SVG/desconhecidos só salvam, nunca abrem |
| Token fora de URL | conferido | leitura sempre com Bearer no cabeçalho |
| Visualizador de imagem em tela cheia, vídeo e PDF embutidos | pendente | abrem no programa do sistema |
| Perguntas, opções, planos, fila | conferido | Task 3; checagem de não regressão na fixture dela |

## Configurações

| Capacidade | Estado | Observação |
|---|---|---|
| Aparência em cartões por seção, com atalhos fixos para cada seção | pendente no web | nasceu no nativo (`settings/appearance_page.rs`); o web segue com a lista de linhas |
| Fundo, Leitura, Chamadas de ferramenta e Navegação recolhida escolhidos por miniatura | pendente no web | no web são botões de texto |
| Ajuste dependente recuado sob o de cima (Força, Papel de parede, Solidez da folha, Contraste, O que entra no pensamento, Densidade) | pendente no web | no web cada um é uma linha solta |
| Prévia ao lado que segue a seção mexida (chamadas no estilo escolhido, tarefas, tabela, leitura, navegação) | pendente no web | só com a janela larga (1400px); estreita ou ao vivo, a prévia de conversa fica no corpo como antes |
| Contas e modelos com resumo no topo (em uso, semana esgotada, login que vence primeiro, redefinições do Codex) e atalhos por seção com a contagem | pendente no web | nasceu no nativo (`accounts.rs`); o web segue com os títulos e as listas soltas |
| Contas em cartões por seção, assinaturas separadas por provider e uma coluna por janela de cota, com a barra crescendo ao abrir | pendente no web | só com a janela larga (1320px); estreita, a linha empilha as barras como antes |
| Plano da assinatura numa ficha ao lado do nome, também nas contas Claude | pendente no web | no web o plano aparece só no subtítulo do Codex |
| "Atualizar" ao lado do "Reiniciar" na tela de servidores, com confirmação, etapas e resultado | implementado | nos dois; o nativo age sobre o servidor ativo, o web sobre o escolhido na aba |
| Pílula "servidor desatualizado" na barra de cima e aviso no cartão do servidor | implementado | só no nativo, de propósito: a tela do web vem do próprio servidor e não fica mais nova que ele |
| "Atualizar tudo" na barra: servidor desta máquina primeiro, depois o app | implementado | só no nativo, de propósito: no web o botão da barra atualiza o servidor e a tela vem junto |
| Largura da barra lateral arrastada pela borda (200–520 px), lembrada neste computador | implementado | `sidebar_width` em `appearance.json` (o `cp_sidebar_w` do web); uma largura para Barra lateral e Conversas, sem alça no trilho nem com abas no topo |
| Máquinas: uma linha por máquina, casando as guardadas neste aparelho com o registro do servidor pelo identificador que cada uma responde (sem ele, pelo host e caminho) | implementado | `machines.rs` (`join_lines`, porta de `unirMaquinas`); identificador lembrado só em memória, o web guarda no navegador; não exercitado na janela |
| Máquinas: estado das sessões por linha e cartão dos recados com a volta medida pelo token guardado aqui | implementado | aparecem, token recusado, falta o token, desligada aqui/no servidor, não respondeu; não exercitado na janela |
| Máquinas: "Mostrar as sessões dele" liga e desliga a entrada guardada; sem entrada, usa o token que o servidor guarda | implementado | sem o campo para digitar o token quando o do servidor falha |
| Máquinas: token digitado, trocar nome/token de uma entrada, tirar endereço repetido (também do servidor conectado), escolher o endereço da volta, cadastrar de novo, ligar recados de máquina só deste aparelho, identificador de outra máquina | pendente | o cartão mostra a frase do web sem o botão; o interruptor de recados de máquina só deste aparelho fica desligado com "próxima versão" |

## Barra lateral: grupos de sessões

| Capacidade | Estado | Observação |
|---|---|---|
| Blocos por `pair_gid` com cabeçalho (glifo, chave da tarefa em destaque e resto em cinza, quantas esperam, total) e membros recuados com a faixa do grupo | implementado | `grouping.rs`; nas duas listas (Normal e Conversas) e por máquina; recolher o bloco grava junto dos grupos de projeto; o trilho recolhido segue sem cabeçalho de bloco |
| Arrastar sessão sobre outra ou sobre o cabeçalho do bloco abre o diálogo de agrupar; soltar no fundo da lista abre o de sair | implementado | mesmas recusas do `canPair` do web, com o motivo no cartão que acompanha o ponteiro; linha de outra máquina recusa; soltar sobre cabeçalho de seção/projeto conta como fundo (no web não) |
| Diálogo de agrupar/sair: afetadas, tarefa herdada ou campo com Sugerir, 409 vira "Substituir a tarefa", aviso parcial vira título de feito | implementado | não fecha com a chamada em voo; relê a sessão viva antes de confirmar |
| "Agrupar com…" e "Sair do grupo" no menu da sessão | pendente no web | nasceu no nativo; mesmas candidatas do arrastar e o mesmo diálogo |

## Como rodar a prova

```bash
cd desktop-native && cargo build --locked
PARITY_COMPOSER_PORT=18794 python3 tools/parity_composer_fixture.py   # token parity-composer-fixture
LANG=pt_BR.UTF-8 target/debug/hangar-native                            # Conexão: http://127.0.0.1:18794
PARITY_SESSION_PORT=18796 python3 tools/parity_session_fixture.py      # barra direita e controles; o token está em TOKEN no topo do arquivo
```
