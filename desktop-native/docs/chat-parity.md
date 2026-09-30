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
| Chip do grupo (glifo sem grupo; nome e estado do par único; "grupo (n)") e "mandar pro grupo" (⇄) | implementado | na faixa de baixo do cartão, à esquerda da pasta (o web o põe na faixa de cima); ligado, o envio do campo vai por `POST /api/broadcast` para ela e os membros, `/comando` vai só para ela, membro que não recebeu vira recusa com quem recebeu e quem não; grupo que muda desliga; atalhos de envio da barra direita não vão ao grupo; não exercitado na janela |
| Prazo do cache de prompt (`cache-chip` + `cachePrazo` do web) | implementado | faixa de cima do compositor, antes do anel de contexto: ponto verde e "59min"/"1h00" em mono, âmbar no último quinto da janela (mínimo 60 s), ponto apagado e "expirou" depois; dica com as chaves `composer_cache_*` do web. Âncora = último `assistant_msg` com `cache_read`/`cache_ttl_s`, TTL = último `cache_ttl_s`; sem os dois não aparece. Relógio de 20 s redesenha só a faixa de baixo. Não exercitado na janela real |
| Orquestrar: aba "Papéis do grupo" (`OrquestracaoSheet.svelte`) | conferido | ícone ao lado do chip do grupo, na faixa de baixo do compositor, abre um diálogo (o web abre pelo compositor e pelo painel de contexto); lista de etapas à esquerda e formulário do papel à direita. Conferido na janela real com o time padrão: etapas na ordem do trabalho, cota e "N linhas nesta conta", "Trocar agora para X (cota N%)", troca rápida de conta e modelo, formulário (modo, fila do rodízio, provider, conta, modelo, esforço, permissão, onde roda, subagentes, Jev), "+ Novo papel", mudanças pendentes e Descartar. Salvar, remover, adicionar conta, 409 e "Começar" não foram exercitados (o contrato é o real). "Contas liberadas" leva a Configurações > Orquestração; o contexto estendido do Codex fica só no "Nova sessão". Diferente do web: conta nova do rodízio nasce na primeira conta liberada (conta vazia é recusada pelo backend com a política montada) |
| Voz, câmera, prévia, shells | pendente | módulos fora desta sequência |

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
| Atalhos da config (`send_text`, `shell`, anexos) | conferido | direto, preencher com proteção, shell só após confirmar e só pela rota existente; internos de terminal/navegador/modo não aparecem |
| Atalhos por projeto (`GET/PUT /project-shortcuts`): globais e depois os do projeto, com marca de pasta e dica "Deste projeto"; `shell` com `pasta` opcional | implementado | igual ao web no desenho do plano: lidos ao abrir a sessão e a página Atalhos, resposta atrasada descartada pelo número do pedido; carregando/erro não escondem os globais (erro numa linha embaixo); seção "Deste projeto (nome)" na página Atalhos, só com sessão aberta, com adicionar, editar, subir/descer e remover, cada mudança gravada na hora (sem arrastar) |
| Seção "Ações" em blocos iguais que quebram linha (colunas pela largura do painel, rótulo em até duas linhas) | implementado | o web passou a seguir o nativo: seção própria em grade, fora da fileira que rolava |
| Exportar/importar atalhos sem credenciais (menu "⋯" de Ações e botões na página Atalhos) | implementado | diálogo de salvar/abrir do sistema; conferência com contagem e um campo mascarado por credencial; atalho com credencial em branco fica apagado e avisa em vez de rodar |
| Terminal de cada atalho `shell` como aba do painel (rótulo, código de saída, ×), botão de terminal em sessão sem pane quando há atalho aberto | implementado | sempre pela rota `shortcut-shell`, também com a sessão nesta máquina; sem pane o painel mostra só as abas dos atalhos |
| Atalhos No Hangar: configuração (dois cartões "Na sessão" / "No Hangar" com ajuda e uso, bloco "Clicar com ele já rodando" com "Pasta de trabalho: ~", "Responder perguntas pelo app.") e marcas "Na sessão · texto" / "Na sessão" / "No Hangar" nas linhas | feito | mesmos campos do web (`runs_in`, `hangar_home`, `answer_in_app`); só o que difere do padrão é gravado; campo com tipo errado derruba o item, como no web. Não exercitado na janela: verificação manual do nativo (Task 11, Step 9) adiada |
| Atalhos No Hangar: lista viva (evento `shortcut_terminals` por servidor, sem SSE próprio), rodar/reaproveitar e servidor antigo | feito | estado por máquina (a ativa em `live_terms`, as outras no `RemoteList`); stream caído ou máquina que sai limpa o dela; clicar com o terminal perguntando abre a pergunta; cópia já rodando não vira segunda (janela à frente, ou o painel abre na aba dela); resposta sem `reused` avisa "ainda não tem os atalhos No Hangar". A chave compara com espaço colapsado |
| Terminal No Hangar como aba do painel de terminal de TODA sessão (grupo HANGAR, ponto verde/âmbar/cinza, ✕ que para) | feito | inclusive sessão sem pane e, sem sessão da máquina à vista, painel só com as abas dele; o socket só conecta na aba à vista e solta ao sair dela (o backend aceita um cliente por terminal); falha do ✕ aparece no cabeçalho do painel |
| Blocos de atalho com estado (verde rodando · N min, âmbar "pergunta pra você", "caiu · código"), marca HANGAR, dica e nota "aberto em outra sessão" | feito | o "N min" anda por um relógio de 30 s enquanto houver No Hangar vivo; sem hora de início a linha some; "Na sessão" só mostra a pergunta |
| Chip "N no Hangar" (ao lado da marca; ponto no trilho) e lista com Ir para a janela / Terminal / Parar / Responder / Ver saída / Rodar de novo / Dispensar | feito | popover de fundo sólido; "Ir para a janela" sem janela avisa "Não achei uma janela dele; abrindo o terminal." e abre a aba; toda falha (parar, rodar de novo com 500, janela, resposta) aparece na lista. Foco por teclado na primeira ação ao abrir (o web faz): pendente, o popover do compositor não move o foco ao abrir e esta entrega não o acrescentou; Esc fecha e Tab percorre os botões |
| Cartão da pergunta do terminal (diálogo com as respostas da rodada, campo com o padrão, "Esconder o que eu digitar", "O que o terminal mostra", Abrir terminal e Enviar) | feito | resposta vai como digitada (vazia aceita o padrão); a pergunta já enviada não volta como nova até a lista mudar; espera 5 s pela próxima e fecha; "Abrir terminal" leva à aba No Hangar, ou à sessão dona (trocando de sessão se preciso) na aba do atalho |
| Atalho Rodar (`RunSheet`) | implementado | botão na grade de Ações (aceso com run vivo, lido ao abrir a sessão); diálogo roda o lembrado ao abrir ou lista personalizados e detectados, espelho do pane a cada 1 s, Trocar/Parar, CRUD de personalizados; parada recusada mantém o run na tela (o web o apaga) |
| Fila da sessão | conferido | contagem no rodapé do painel |
| Recolher e redimensionar | conferido | 240–480 px; some sozinho se a conversa ficaria abaixo de 540 px |
| Fileira de abas (Contexto, Arquivos, Atividade, Git) no desenho da `.abas` do web | conferido | régua de ponta a ponta, sublinhado na escolhida, texto de 12 px; rótulo da primeira na margem de 16 px das seções; as quatro inteiras a 300 px, reticências a 240 px. Diferenças: o recolher mora na mesma fileira (o web o põe no cabeçalho com nome e estado, que aqui ficam no cabeçalho da conversa) e Git é aba, não o botão que abre a coluna do web |
| Menu de ferramentas do painel recém-aberto (Terminal, Alterações, Histórico) | pendente | o web não tem esse menu no painel vazio; recurso do painel nativo, o web não foi feito neste trabalho |
| Navegador como ferramenta do painel lateral | implementado (Windows) | no nativo é a linha "Navegador" do menu do painel (WPE WebKit no Linux, só aparece com a biblioteca instalada; WebView2 no Windows; WKWebView no macOS); no web/Electron o navegador embutido é o do `hangar-preview`, painel próprio da sessão com abas e comando por CLI, fora do painel lateral. No Windows o nativo tem um navegador por sessão, e o `hangar-preview` e as tools MCP o dirigem por CDP dentro do processo (sem porta de depuração), sem abas. macOS e Linux continuam com um navegador por janela, sem controle pelo CLI. A tela remota do navegador no celular (`backend/app/navsock.py`, que usa a porta 9223) continua só no Electron |
| `hangar-preview open` abre a aba Navegador sozinho | pendente | no Electron o `open` monta o painel do navegador na tela; no nativo (Windows) ele cria o navegador da sessão, mas a aba Navegador só aparece quando o usuário a abre. O `open` também só é atendido quando o servidor ativo do app é esta máquina por loopback (`127.0.0.1`/`localhost`); com outra máquina ativa ele não faz nada e o pedido pendente espera o prazo |

## Ciclo e planos

| Capacidade | Estado | Observação |
|---|---|---|
| Codex antes da conversa (`tracked=false`): pergunta da lista respondida por `/select` | conferido | confere que a pergunta não mudou antes de enviar; falha com motivo; a conversa abre sozinha quando o transcript aparece |
| Abertura do Codex antes do histórico | implementado (espera conferida) | mostra `startup_steps` na ordem, etapa atual, marca animada e espera desde a seleção nesta tela; cabeçalho não diz pronto antes de poder ler a conversa; preserva pergunta e falha. Janela isolada com servidor sintético: etapas, cabeçalho carregando e contador crescendo conferidos; falha não exercitada nessa janela |
| Implementar plano do Claude sem terminal parado em modo plano | conferido | troca para o modo anterior, envia o pedido; envio recusado volta ao plano; troca recusada e incerteza têm aviso próprio |
| Âncora do plano sem terminal pelo `anchor_id` da descoberta | pendente | usa a última resposta do turno; o pedido enviado é o mesmo, só a âncora pode diferir num turno com várias respostas |
| Plano do Claude com terminal (`/plan-preview`) | conferido | descoberta ao abrir e ao fim do turno; conteúdo só no gesto "Ler plano" |

## Módulos à parte (dependências, sem simulação)

Terminal embutido, navegador, árvore de arquivos e Git completos (stage, commit, troca de branch), voz, gestão global de sessões/contas/modelos, Board/Canvas e os atalhos internos que dependem deles. Windows/macOS e desempenho seguem sem alegação.

## Conversa

| Capacidade | Estado | Observação |
|---|---|---|
| Rodapé de memória do Codex (`oai-mem-citation`) | implementado | oculto em respostas e prévias Markdown, inclusive rodapé todo na mesma linha e cauda incompleta durante streaming; exemplos em cercas de código e texto da pessoa preservados. Mesmo tratamento do `planDisplayText` do core; não exercitado na janela real |
| Mensagem com marcadores mostra só a legenda e os anexos | conferido | imagem inline pelos bytes do cofre; arquivo como nome + ações |
| Imagem colada no terminal (`image_count`) | conferido | `/transcript-image`; sem duplicar quando o caminho também foi escrito |
| Caminhos citados pelo assistente (absoluto, `~/`, relativo com pasta) | conferido | `/file?path=`; recusa do backend aparece com o motivo dele |
| Abrir | conferido | cópia privada (pasta 700, nome saneado com a extensão preservada) entregue ao programa padrão; só tipos passivos, conferidos no nome gravado |
| Salvar | conferido | diálogo do sistema; HTML/SVG/desconhecidos só salvam, nunca abrem |
| Token fora de URL | conferido | leitura sempre com Bearer no cabeçalho |
| Visualizador de imagem em tela cheia, vídeo e PDF embutidos | pendente | abrem no programa do sistema |
| Perguntas, opções, planos, fila | conferido | Task 3; checagem de não regressão na fixture dela |
| Pergunta do agente: a linha inteira da opção (rótulo, descrição, prévia) é clicável, com hover e cursor de mão | conferido | igual ao web (`.option-btn` do `AskQuestionStepper`); no nativo a linha é o próprio Radio/Checkbox, então o teclado segue o mesmo controle |
| Pergunta do agente: rótulo com peso, descrição em `text_sm` legível e opção escolhida realçada (borda + fundo do destaque) | conferido | igual ao web (`.opt-desc` em `--text-secondary`, `.option-btn.selected` em `--accent`/`--accent-dim`) |
| Pergunta do agente: moldura na cor de destaque, com opção "Destaque das perguntas: cor de destaque / âmbar" em Aparência | pendente | só no nativo; o card do web (`AskQuestionCard`) usa a borda neutra `--border-default` e não tem a opção. Motivo: pedido só para o nativo nesta rodada |
| Pergunta do agente com várias perguntas: abas com o `header`, marca nas respondidas, avanço automático na escolha única, Enviar só com todas respondidas | pendente | o web usa o stepper (uma por vez, "n / total", Voltar, Próximo na múltipla); mesmo fluxo de avanço, sem faixa de abas nem marca. Motivo: pedido só para o nativo nesta rodada |
| Menu do AskUserQuestion lido do pane (linhas "Type something." / "Chat about this") nunca aparece como seletor do terminal nem como aviso de pedido pendente | pendente | só no nativo (`interaction::ask_picker`); o web esconde o `OptionButtons` só enquanto `askActive`, então ele ainda pisca antes do `ask_question` e depois do envio. Motivo: pedido só para o nativo nesta rodada |
| Grupo da Árvore no desenho do Zeron: linhas apagadas (hover só acende o rótulo), sem estado por linha (falha pinta a linha, "rodando" vira a marca animada no cabeçalho, a falha entra no título), raciocínio numa linha só (prévia de três linhas só enquanto chega) | pendente | só no nativo. Motivo: pedido só para o nativo nesta rodada |
| Grupo da Árvore animado: ferramenta nova cresce e sobe no lugar (360 ms, 65 ms entre as que chegam juntas), grupo dobra ao abrir e fechar (140 ms); histórico e troca de sessão aparecem direto | pendente | só no nativo (`motion::TOOL_REVEAL`/`TOOL_FOLD`). Motivo: pedido só para o nativo nesta rodada |
| Linha "trabalhando" com os tokens do spinner do terminal depois dos segundos ("Trabalhando… 29s · ↓ 1.4k tokens"); sem começo conhecido, só os tokens | pendente | só no nativo (`working_tokens`); o `MessageList` do web mostra só verbo e segundos. Motivo: pedido só para o nativo nesta rodada |
| Chamada Agent nunca entra em grupo de ferramentas, em nenhum visual (antes só na Árvore) | pendente | só no nativo (`conversation::build`); no web o Agent ainda pode cair num grupo recolhido. Motivo: pedido só para o nativo nesta rodada |
| Cartão do subagente no desenho do Zeron, igual nos três visuais: ladrilho de 18 com o ícone, tipo em peso médio, descrição, modelo apagado à direita, marca rodando ou "falhou" no fim, ↗ | pendente | só no nativo (`render_agent_card`); o `ToolCard` do web é a linha comum com ↗ e sem o modelo. Pronto não mostra mais "Pronto (N linhas)" no cartão. Motivo: pedido só para o nativo nesta rodada |
| Aba do subagente: rodapé "Pensando" com os segundos desde o `startedAt`, e data/hora do começo sob o prompt | pendente | só no nativo; o `ActivitySheet` do web tem só o `Spinner` sem tempo e nenhuma hora sob o prompt. Motivo: pedido só para o nativo nesta rodada |
| Grupo da Árvore: o traço desce até a ponta da ferramenta nova (480 ms, o tronco de cima primeiro) e o título brilha enquanto o grupo roda (passada de 3,4 s, pintado fora da conversa guardada); parado com movimento reduzido | pendente | só no nativo (`motion::TOOL_CONNECTOR`, `chrome::Shimmer`). Motivo: pedido só para o nativo nesta rodada |
| Markdown pelo gpui-kit 0.7.0: linha com código em linha na mesma altura da linha comum; lista numerada começa no número escrito | conferido (altura) | vem do kit (#3240, #3204), como o web; o texto abaixo de uma linha com código em linha sobe 1 px. O número inicial não foi exercitado: a fixture só tem listas que começam em 1 |
| Número e marcador de lista na cor do código em linha | pendente | só no nativo (`with_list_marker_color` no `gpui-base` vendorizado). Motivo: pedido só para o nativo nesta rodada |
| Skill injetada pelo Codex (notice `skill_loaded`) vira linha recolhida "Skill X carregada" que abre o SKILL.md | implementado | rótulo do aviso + "Mostrar mais"; não exercitado na janela real |
| Diff das edições (Edit, MultiEdit, Write, `apply_patch` do Codex, `edit` do Pi) no lugar da entrada crua | implementado | `editdiff.rs` (Myers do `editdiff.ts`) + `app/edits.rs`; linha recolhida com "+N −M" pelo diff real nos três visuais; aberto, um cartão por edição com caminho, contagem, as linhas da aba Git (duas numerações do trecho, quebra de linha) e realce do tree-sitter; Resultado só quando falhou. Além do web: `apply_patch` com vários arquivos mostra o caminho de cada um, e Copiar leva o texto novo. Diferença: unificado sempre (o web vira lado a lado acima de 600 px); corta em 400 linhas com aviso; não abre sozinho (o web nasce aberto) |

## Configurações

| Capacidade | Estado | Observação |
|---|---|---|
| Aparência em cartões por seção, com atalhos fixos para cada seção | pendente no web | nasceu no nativo (`settings/appearance_page.rs`); o web segue com a lista de linhas |
| Fundo, Leitura, Chamadas de ferramenta e Navegação recolhida escolhidos por miniatura | pendente no web | no web são botões de texto |
| Ajuste dependente recuado sob o de cima (Força, Papel de parede, Solidez da folha, Contraste, O que entra no pensamento, Densidade) | pendente no web | no web cada um é uma linha solta |
| Prévia ao lado que segue a seção mexida (chamadas no estilo escolhido, tarefas, tabela, leitura, navegação) | pendente no web | só com a janela larga (1400px); estreita ou ao vivo, a prévia de conversa fica no corpo como antes |
| Servidores: detalhe da máquina escolhida dentro da página, sem diálogo | pendente no web | nasceu no nativo (`machines.rs`): painel ao lado da lista a partir de 1100px; abaixo disso fica embaixo da lista e escolher uma máquina rola até ele. No web o detalhe é diálogo |
| Servidores: máquina com quadradinho (inicial ou ícone) e farol no canto; "Quem alcança" em dois cartões; recados medidos num desenho de ida e volta | pendente no web | no web são linhas com o farol em texto e as medidas em frases |
| Contas e modelos com resumo no topo (em uso, semana esgotada, login que vence primeiro, redefinições do Codex) e atalhos por seção com a contagem | pendente no web | nasceu no nativo (`accounts.rs`); o web segue com os títulos e as listas soltas |
| Contas em cartões por seção, assinaturas separadas por provider e uma coluna por janela de cota, com a barra crescendo ao abrir | pendente no web | só com a janela larga (1320px); estreita, a linha empilha as barras como antes |
| Plano da assinatura numa ficha ao lado do nome, também nas contas Claude | pendente no web | no web o plano aparece só no subtítulo do Codex |
| Seletor da máquina no cabeçalho do grupo Servidor (`ServidorSeletor.svelte`) | implementado | `render_server_picker` em `settings.rs`: menu com as máquinas próprias (sem convite nem desligada), ponto na cor da máquina e marca na atual; escolher chama `activate_server`. Diferente do web: lá o select muda só o alvo das Configurações (`?srv=`) e aqui troca o servidor ativo; com uma máquina só o web mostra o select apagado com "só uma máquina" e o nativo mostra só o nome. Não exercitado na janela |
| "Atualizar" ao lado do "Reiniciar" na tela de servidores, com confirmação, etapas e resultado | implementado | nos dois; o nativo age sobre o servidor ativo, o web sobre o escolhido na aba |
| Pílula "servidor desatualizado" na barra de cima e aviso no cartão do servidor | implementado | só no nativo, de propósito: a tela do web vem do próprio servidor e não fica mais nova que ele |
| "Atualizar tudo" na barra: servidor desta máquina primeiro, depois o app | implementado | só no nativo, de propósito: no web o botão da barra atualiza o servidor e a tela vem junto |
| Largura da barra lateral arrastada pela borda (200–520 px), lembrada neste computador | implementado | `sidebar_width` em `appearance.json` (o `cp_sidebar_w` do web); uma largura para Barra lateral e Conversas, sem alça no trilho nem com abas no topo |
| Máquinas: uma linha por máquina, casando as guardadas neste aparelho com o registro do servidor pelo identificador que cada uma responde (sem ele, pelo host e caminho) | implementado | `machines.rs` (`join_lines`, porta de `unirMaquinas`); identificador lembrado só em memória, o web guarda no navegador; não exercitado na janela |
| Máquinas: estado das sessões por linha e cartão dos recados com a volta medida pelo token guardado aqui | implementado | aparecem, token recusado, falta o token, desligada aqui/no servidor, não respondeu; não exercitado na janela |
| Máquinas: "Mostrar as sessões dele" liga e desliga a entrada guardada; sem entrada, usa o token que o servidor guarda | implementado | sem o campo para digitar o token quando o do servidor falha |
| Máquinas: token digitado, trocar nome/token de uma entrada, tirar endereço repetido (também do servidor conectado), escolher o endereço da volta, cadastrar de novo, ligar recados de máquina só deste aparelho, identificador de outra máquina | pendente | o cartão mostra a frase do web sem o botão; o interruptor de recados de máquina só deste aparelho fica desligado com "próxima versão" |
| Adicionar neste aparelho (`AdicionarMaquina.svelte`): testar, nome editável, "Mostrar as sessões dele" (ligado de início) e recados; grava a entrada neste aparelho, mesmo endereço atualiza, mesma máquina por outro endereço troca o endereço da entrada | implementado | `machines/add.rs`; convite no mesmo endereço recusa com frase própria (o web grava uma segunda entrada); recado sem identificador recusa em vez de seguir calado; não exercitado na janela |
| Adicionar neste aparelho: "Usar este endereço" para o servidor conectado por outro endereço, e "Escanear QR" | pendente | trocar o endereço do conectado pede reconectar; o botão fica desligado com "próxima versão". Sem câmera no nativo |
| Avançado: Endpoint e Modelo do Jev (`jev_endpoint`, `jev_model`) e rótulos próprios para os quatro campos do texto do Jev | implementado | mesma ordem e mesmos textos do `ServerSettings.svelte`; antes, os campos do texto apareciam com as chaves do Jev e os dois do Jev faltavam |

## Barra lateral: grupos de sessões

| Capacidade | Estado | Observação |
|---|---|---|
| Blocos por `pair_gid` com cabeçalho (glifo, chave da tarefa em destaque e resto em cinza, quantas esperam, total) e membros recuados com a faixa do grupo | implementado | `grouping.rs`; nas duas listas (Normal e Conversas) e por máquina; recolher o bloco grava junto dos grupos de projeto; o trilho recolhido segue sem cabeçalho de bloco |
| Arrastar sessão sobre outra ou sobre o cabeçalho do bloco abre o diálogo de agrupar; soltar no fundo da lista abre o de sair | implementado | mesmas recusas do `canPair` do web, com o motivo no cartão que acompanha o ponteiro; linha de outra máquina recusa; soltar sobre cabeçalho de seção/projeto conta como fundo (no web não) |
| Diálogo de agrupar/sair: afetadas, tarefa herdada ou campo com Sugerir, 409 vira "Substituir a tarefa", aviso parcial vira título de feito | implementado | não fecha com a chamada em voo; relê a sessão viva antes de confirmar |
| "Agrupar com…" e "Sair do grupo" no menu da sessão | pendente no web | nasceu no nativo; mesmas candidatas do arrastar e o mesmo diálogo |
| Painel do grupo (`PairSheet`) pelo chip do compositor: membros com estado, abrir a conversa de um membro, adicionar sessões (várias marcadas), contrato compartilhado em markdown com o caminho, conversa do grupo (últimos 40 recados), sair do grupo | implementado | `group_sheet.rs`, modal; "abrir a conversa" troca para a sessão do membro (o web abre por cima, num modal); membro de outra máquina fica sem o botão; conversa lê a cauda de 1000 eventos de cada membro (o web lê o histórico inteiro); contrato vazio não aparece e a busca que falhou aparece; aviso parcial fica à vista; não exercitado na janela |
| Painel sem grupo: marcar sessões vivas, tarefa opcional, "Parear com …" | implementado | mesmo pedido de criar e adicionar (o servidor une os grupos); não exercitado na janela |
| "Ver em grade" e "Todas lado a lado" / lado a lado por membro no painel do grupo | pendente | o nativo não tem grade de comparação nem vista dividida para abrir |
| Abrir o painel do grupo pelas ações da sessão e pelo painel de contexto | pendente | só o chip do compositor abre |

## Barra lateral: caixa, cabeçalho e rodapé

| Capacidade | Estado | Observação |
|---|---|---|
| Tinta da barra, do painel de contexto e do compositor sobre a área de trabalho, no escuro: a do vidro líquido do Electron (`--glass-bg`, 0,22 + 0,70 × Solidez) | implementado | `theme::panel_alpha`; com Vidro desenhado pela janela segue a tinta própria (`glass_tint`) e no claro a Solidez crua, porque o web usa `--glass-panel` ali. O mesmo número de Solidez dá a mesma barra nos dois apps |
| Importar do Electron traz a "Solidez das caixas" (`cp_surface_solid`, padrão 12 do web) | implementado | antes ficava a Solidez do nativo (padrão 70 = tinta 0,71, contra 0,39 do Electron com Solidez 24) |
| Solidez padrão do nativo igual à do web (12) | pendente | o nativo nasce em 70; baixar muda a primeira impressão de quem nunca mexeu, incluindo o Vidro (0,16), e é escolha de produto |
| Canto dos painéis soltos (barra, contexto, abas, Configurações, páginas) em 24 px, o `--radius-xl` | implementado | `theme::PANEL_RADIUS` |
| Menu "⋯" da sessão que abre para cima (perto do rodapé) fica a 0,25 rem do botão, como o que abre para baixo | conferido | vem do gpui-kit 0.7.0: na 0.6.6 o vão era sempre para baixo e o menu virado encostava no botão; o menu sobe cerca de 6 px |
| Brilho de 1 px na borda de cima do painel solto (`inset 0 1px 1px --glass-specular` do `--elev-3`) | implementado | `theme::panel_shadow`; o compositor fica só com a sombra (`card_shadow`) |
| Cabeçalho: marca de 20 px e "Hangar" em 16 px | implementado | as linhas "Nova conversa" e "Todas as sessões" seguem, desenho do nativo |
| Seletor "Chat / Quadro / Canvas" e botão de busca abaixo do cabeçalho | pendente | Quadro e Canvas não existem no nativo; a busca mora na barra de cima (Ctrl K) |
| Botão de modo seleção (enviar para várias) no cabeçalho e o aviãozinho "enviar p/ todas" no cabeçalho de cada máquina | pendente | o envio para várias sessões não existe no nativo |
| Cabeçalho da máquina: ponto na cor fixa da máquina (`serverColor` do core), rótulo em caixa alta 11 px negrito apagado, contagem em pílula | implementado | a cor sai do id; importadas do Electron têm o mesmo id, cadastradas aqui ganham id próprio e podem cair noutra cor |
| Cabeçalho da máquina focável pelo teclado, com o anel de foco do destaque | pendente | hoje só o clique alterna; precisa de um foco por máquina |
| Contagem de quem espera (âmbar) no cabeçalho da máquina | pendente | o nativo mostra a seção "Aguardando você" no topo da lista |
| Rodapé: pílula cheia no destaque "+ Nova" (36 px) e o recolher ao lado | implementado | rótulo curto do web; leitor de tela e dica dizem "Nova sessão". A linha da conexão embaixo é do nativo |

## Nova conversa sem sessão: git da pasta

| Capacidade | Estado | Observação |
|---|---|---|
| Pílula "Git" ao lado da de branch (atrás/à frente, alterações ou "Atualizada") e painel com branch, remota, último fetch, Fetch, Pull só fast-forward, trocar branch (locais e remotas, com busca) e criar branch (base e "Trocar para ela") | implementado | `create/folder_git.rs` sobre `GET /api/fs/git` e `POST /api/fs/git/{fetch,pull,switch,branch}`; abrir o painel faz um fetch por pasta; pasta suja recusa pull e troca, divergida recusa pull, sessão viva no mesmo checkout pede "Trocar mesmo assim"; não exercitado na janela |
| O mesmo gerenciador no web | pendente no web | o `CreateSessionSheet` do web não tem a pílula de branch/worktree da tela sem sessão, onde o painel mora; as rotas já servem os dois |
| Anexar (clipe, colar imagem, arrastar) e ditar antes de a sessão existir | implementado (só nativo) | anexos ficam no campo e sobem por `POST /api/sessions/{nome}/upload` depois que a sessão nasce, junto da primeira mensagem, na máquina dos chips; falhou, ficam no campo da sessão nova. Ditado usa `POST /api/dictation/transcribe`, sem sessão (servidor sem essa rota responde 404 no ditado). Não exercitado na janela |
| Tela sem sessão com anexos e ditado no web | pendente no web | o web não tem a tela de nova conversa com compositor; cria pelo `CreateSessionSheet` |

## Sessão compartilhada (convidado)

| Capacidade | Estado | Observação |
|---|---|---|
| Colar convite, servidor de convite, "compartilhamento encerrado" | implementado | sem exercício na janela real |
| Vários convites do mesmo dono | pendente | o nativo chaveia servidores pelo endereço (o web, pelo id): o convite novo do mesmo dono substitui o anterior, e um endereço que já é servidor próprio recusa o resgate antes de chamar o backend |
| Link `hangar://` abre o app já aberto | implementado (só nativo) | instância única por porta local com nonce; Linux `.desktop` (vem no `install-linux.sh` do pacote nativo), Windows `HKCU\Software\Classes\hangar` |

## Sessão compartilhada (dono)

| Capacidade | Estado | Observação |
|---|---|---|
| "Compartilhar sessão" no menu da sessão (some em servidor de convite), diálogo com aviso de confiança, gerar link (aparece uma vez), copiar, WhatsApp, quem tem acesso, revogar um e encerrar todos, pré-requisito do Funnel com o comando de correção | implementado | `share.rs`; sem exercício na janela real; quando o diálogo abre só a lista é lida, o link nasce no botão |
| 🔗 na linha da sessão compartilhada, com dica | implementado | `SessionInfo.shared`; o web marca a linha do mesmo jeito |
| Botão "Abrir link" quando o `fix` do pré-requisito é uma URL | diferença deliberada | o web só mostra o texto do `fix`; no nativo a URL abre no navegador e um comando vira "Copiar" |
| "Liberar no Tailscale" (abre o `enable_url` e confere `GET /api/share/prereqs` a cada 3 s, por até 5 min, enquanto o diálogo está aberto; liberado, some o aviso e o "Gerar" volta) e "Copiar" só da linha do comando do operador | implementado | nos dois clientes; sem exercício na janela real |
| "Autorizar" o operador com `pkexec tailscale set --operator=<usuário>` | diferença deliberada | só no nativo, no Linux e com o servidor ativo em loopback: o `pkexec` precisa do agente de senha da sessão gráfica, que o backend (serviço de systemd) não tem; o web mostra o comando com "Copiar" e a dica de que o app nativo desta máquina autoriza com um clique |
| Campo do link selecionável e com seleção automática ao focar | pendente | o nativo mostra o link como texto (não selecionável), com "Copiar"; sem `Input` somente leitura no diálogo |
## Orquestrador sem LLM (orquestrar-auto)

| Capacidade | Estado | Observação |
|---|---|---|
| Linha `orq` com o selo "Orquestrador · sem LLM" (`orq_row_badge`), no bloco do grupo do árbitro | implementado | barra e Conversas mostram o selo; no trilho ele vai na dica; nas abas do topo, só o glifo ◇ |
| Conversa da linha do tempo sem compositor, com "Falar com o árbitro" (`orq_talk_to_arbiter`) abrindo o árbitro atual | implementado | rodapé como o do web: o selo "Orquestrador · sem LLM" e o botão no estilo comum; o árbitro sai de `orq_arbiter` na lista a cada clique; fora da lista, o botão fica desligado; conversa vazia diz que o orquestrador não recebe mensagens |
| Renomear, fechar, interromper e o terminal da sessão escondidos | implementado | o menu da linha tem só "Falar com o árbitro"; pressionar para renomear e o Esc não agem; sem terminal (o botão do cabeçalho some, mesmo com terminal de atalho); clicar na linha não põe o foco num campo que não está desenhado; um 409 `erro_sessao_orq` que escape aparece com o texto do web |

## Como rodar a prova

```bash
cd desktop-native && cargo build --locked
PARITY_COMPOSER_PORT=18794 python3 tools/parity_composer_fixture.py   # token parity-composer-fixture
LANG=pt_BR.UTF-8 target/debug/hangar-native                            # Conexão: http://127.0.0.1:18794
PARITY_SESSION_PORT=18796 python3 tools/parity_session_fixture.py      # barra direita e controles; o token está em TOKEN no topo do arquivo
```
