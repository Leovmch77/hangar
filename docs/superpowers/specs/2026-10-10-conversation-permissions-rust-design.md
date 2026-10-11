# Perguntas, permissões e conversa terminal no Rust

Estado: contrato revisto pela opção A de 11/10, substituindo instruções antigas de reserva/ciclo de vida Python; retrabalho por subagentes autorizado. Identidade/DTOs/clientes/guardas/recibos/Store 1–5, transporte 8 e preparação 9 integrados são preserváveis, não prova de adequação funcional ao novo corte. `permissions-gpt` coordena 1–7/12–13; `permissions-codex` refaz 10 em Rust e mantém 8–11. Verificações não executadas permanecem pendentes; serviços e operações Git seguem suas autorizações específicas.

## Objetivo e decisões de escopo

Concentrar no Rust as perguntas, aprovações de ferramentas e modos de permissão do Claude e do Codex, sem refazer os caminhos sem terminal que já funcionam no Rust. Retirar as decisões e memórias Python desse caminho, não apenas mudar a linguagem das rotas HTTP.

O usuário escolheu dois planos separados:

1. Este trabalho: perguntas e permissões; inclui conexão, envio, fila e estado do Codex com terminal para não criar outra ponte temporária de perguntas entre Python e Rust.
2. Trabalho posterior: abertura completa de sessões, do pedido de criação ao processo registrado e adotado pelo runtime.

A ampliação para o fluxo do Codex com terminal e o novo corte foram aprovados: com Rust ativo, fatos, entrega, plugin/perguntas, publicação, memória de permissões, sondagem/troca, reabertura bypass, pane morto, fechamento/limpeza da sessão e troca de conversa/sidecar são Rust. A decisão A confirmada em 11/10 também atribui ao Rust o relançamento da sessão já aberta: no Codex, terminal↔sem terminal e reiniciar; no Claude, reabrir para bypass. A inspeção corrigiu a explicação anterior: troca de conta de um Codex aberto não existe e não é criada; importar de Claude abre um Codex novo, ainda na abertura inicial Python. Python conserva somente a abertura inicial e seu preparo. `POST /api/sessions`, instalação/cadastro/login de conta, troca geral de provedor e gestão de worktrees continuam fora; relançar uma sessão existente não é criar outra.

Exceções delimitadas informadas na continuação: autorização existente das portas Python e repasse mínimo de escritas num sentido ao Rust (Q1/B); após DELETE do dono de Codex terminal concluído pelo Rust, repasse ao Python apenas da limpeza externa existente (DELETE/A), sem chamada de volta. Não estender essas exceções a decisão/pergunta/lifecycle Claude. Crescimento Python só cabe no repasse mínimo aprovado, com saldo por arquivo; restante zero/negativo. A decisão A de relançamento retira `hand-over` inteiro: `open_headless`/`open_terminal` sobre sessão existente são executados no Rust sem devolver a posse ao Python. `publish_imported` é abertura de um Codex novo a partir de Claude e continua no fluxo inicial Python, sem criar troca de conta Codex que não existe.

Os controles e as escolhas disponíveis permanecem os mesmos, sem redesenho. O contrato dos clientes precisa carregar a identidade da pergunta exibida; mensagens de retorno precisam distinguir envio de confirmação. O usuário continua podendo responder pelo app ou pelo terminal. Dono único significa uma implementação ativa do Hangar para a operação; não significa proibir a pessoa de responder pela TUI do provedor.

## Base existente

Este desenho atualiza o recorte das subpartes C2, da parte necessária de C3/C4 e da conversa terminal da 5C. Não substitui as demais etapas dos desenhos anteriores:

- `docs/migracao-rust/parte5-claude/spec.md`: plugin, fatos do terminal, administração e ciclo de vida separados.
- `docs/migracao-rust/parte5-codex/spec.md`: motor Codex sem terminal e adoção do app-server de uma sessão com terminal.
- `docs/decisoes/harnesses.md` e `docs/decisoes/windows.md`: comportamento vigente e particularidades dos provedores e sistemas.

Evidência histórica da base `0264a8150`, não retrato de conclusão da árvore atual. Os contratos integrados 1–5/8/9 e a memória pura 7a são preservados; fontes, controlador/lifecycle e corte ainda precisam do retrabalho:

| Área | Situação atual | Fonte |
| --- | --- | --- |
| Claude sem terminal | O motor Rust guarda perguntas e aprovações e monta as respostas ao agente. | `crates/hangar-server/src/runtime/claude.rs:374` |
| Codex sem terminal | O motor Rust guarda pedidos RPC, respostas em curso e resoluções. | `crates/hangar-server/src/runtime/codex.rs:1405` |
| Claude com terminal | Perguntas seguradas, respostas pelo plugin e confirmação ainda vivem no Python. | `backend/app/plugin_bridge.py:1428`, `backend/app/runtime_terminal.py:379` |
| Modos Claude | Rotas, sondagem e memória do modo ainda passam pelo Python. | `backend/app/api.py:9808`, `backend/app/api.py:9890` |
| Entrega Claude com terminal | O escritor Rust ainda consulta fatos e publicação do plugin no Python. | `backend/app/runtime_terminal.py:322` |
| Codex com terminal | A tabela entrega as escritas ao Python; o descritor terminal do Rust só aceita Claude. | `crates/hangar-server/src/session_write/table.rs:28`, `crates/hangar-server/src/runtime/gateway.rs:671` |
| Transporte Codex | Já há cliente Rust com transporte WebSocket. | `crates/hangar-codex/src/client.rs:146` |
| Abertura | Python ainda cria o terminal e o lançador Codex inicia app-server e TUI. | `backend/app/registry.py:2468`, `scripts/hangar-codex-tui:691` |

## Fronteira do primeiro plano

### Entra

- Plugin Claude: identificação/autenticação, instância ativa, publicação, perguntas e permissões seguradas, resposta, confirmação, cancelamento, estado e sugestões que compartilham essa memória.
- Fatos e controles necessários para responder perguntas e entregar pelo plugin sem voltar ao Python; observação de modo de permissão e acionamento da fila no Rust.
- Lista, sondagem, memória e troca do modo de permissão Claude, com e sem terminal; reabertura necessária para bypass executada no Rust.
- Ciclo de vida da sessão aberta no Rust: pane morto, fechamento/limpeza terminal/sidecar, `/clear`, troca de conversa/sidecar e nova geração sob as barreiras e diário existentes.
- Codex com terminal: adoção da conexão existente, envio, fila, confirmação, interrupção, estado/prévia, perguntas, aprovações, modos de permissão e lifecycle da sessão aberta.
- Entrada do dono e delegação das operações migradas que chegam pelas portas de convidado/Connect, mantendo a autorização própria dessas portas.
- Identidade da interação nos payloads e retornos de `packages/core`, PWA, app mobile e desktop nativo, sem novos controles. Chamadores legados compartilhados também são ajustados para não quebrar a interface existente.
- Coexistência com responsabilidades Python não migradas e paridade Linux/Windows. Responsabilidade já migrada não tem reserva Python quando Rust cai; Guest/Connect e legado não migrado continuam funcionando. Resposta de cliente antigo sem identidade é recusada no caminho migrado com erro explícito, conforme o contrato abaixo.

### Não entra

- `POST /api/sessions`, montagem geral de comando/ambiente, preparo de conta e lançamento de processos.
- Cadastro/login de contas, troca geral de provedor, movimentação administrativa de conversas não ligada ao relançamento aprovado e criação/exclusão de worktrees.
- Abertura inicial de sessão nova e renomear não são portados por vizinhança. Relançar o Codex existente — alternar terminal/sem terminal ou reiniciar — foi aprovado como Rust. Importação Claude→Codex cria um processo novo e continua na abertura inicial; trocar conta de Codex aberto não existe e não será inventado neste port. Fechamento, pane morto, reabertura bypass e troca de conversa/sidecar também permanecem no dono Rust.
- Novas funcionalidades de modelos/esforço, `/btw`, `/then`, `/loop`, controles e redesenho visual. Preservar transformações dos controles existentes que perdem cliente Python usando comandos Rust já suportados, sem expandir o recorte.
- Histórico do convidado, estatística, voz, custos, MCP, grupos, navegador, atalhos, atualizações e Pi/omp/Kimi não migram por vizinhança.
- Ampliar a migração para funcionalidades ainda Python ou desligá-las: isso não foi autorizado. O código antigo de uma responsabilidade migrada pode permanecer para consulta, mas sem caminho ativo ou reserva. A retomada do Rust não devolve a responsabilidade migrada ao Python; a parte não migrada continua funcionando e pode usar a implementação Rust em um sentido.

Operações fora do recorte conservam comportamento anterior. Escritas que chegam pelas portas Python passam pela autorização existente e pelo repasse mínimo Q1/B, sem outro cliente/decisor Python e sem volta Rust → Python → Rust. Isso não autoriza ponte nova para persistência, reabertura ou lifecycle. A exceção DELETE/A após fechamento Codex limpa somente lojas externas anteriores, não migra as funcionalidades dessas lojas.

## Arquitetura proposta

### 1. Plugin Claude com estado único no Rust

Completar a ponte do plugin junto da infraestrutura Rust existente de mods, autenticação, vínculo e controle de sessão. Preservar tokens atuais, inclusive os vinculados à chave da sessão, e a identificação após renomear uma sessão sem relançar o agente.

As rotas sob `/api/plugin` — `whoami`, `pull`, `suggest`, `ask`, `ask-fim`, `filled`, `submitted`, `state` e `rate` — passam ao Rust para as sessões migradas. Rotas de mods que já são Rust não ganham uma implementação concorrente. A propriedade deve ser resolvida antes de executar qualquer efeito.

O Rust mantém por sessão a instância do plugin, capacidades, espera ativa, publicação em curso, pergunta pendente, resposta em curso e confirmação. A identidade inclui a chave da sessão e os identificadores de conversa, geração e pedido disponíveis no protocolo; nome de sessão sozinho não autoriza aplicar uma resposta.

A mudança alcança o conjunto do plugin porque perguntas, publicação e confirmação compartilham instância e memória. Não criar um serviço de perguntas que continue consultando o Python a cada resposta.

Preservar os contratos e prazos efetivos do código, documentando divergências dos documentos antigos: `ESPERA_S = 25`, `SEM_POLL_S = 5`, `CONFIRMA_S = 5`, teto absoluto `ESPERA_S + 10`, `PUBLICA_S = 30` e `VALIDADE_ESTADO_S = 90`. Não aumentar esperas nem criar um laço periódico adicional por sessão. Store/autenticação integrados são reutilizados, não reimplementados.

Regras de resposta:

- Uma pergunta admite uma resposta em curso. Repetição aguarda a mesma confirmação; não repete tecla ou efeito.
- Resposta tardia para outra pergunta, geração ou conversa é recusada.
- `ask-fim` confirma quem concluiu; interrupção invalida imediatamente a pendência aplicável.
- Pergunta comum pode usar a alternativa por teclado já existente quando cabível. Permissão segurada pelo hook não tem um menu correspondente no terminal: não inventar uma aprovação por tecla se o plugin não respondeu.
- App ausente, terminal anexado e modo sem diálogo conservam as regras atuais de devolver o controle ao terminal. A migração não amplia permissões.
- Desconexão não confirma entrega. A recuperação distingue pedido não escrito de pedido cujo resultado ficou desconhecido.

### 2. Estado, entrega e modos Claude usam o mesmo dono

As `Sources` do plugin, `LiveSources`, `RuntimeFeed`, `Monitor`, lista e rotas de controle leem diretamente o mesmo `plugin::Store`/`RuntimeRegistry`. Retirar fatos ativos do plugin Python, consulta `/internal/sessions/{name}/plugin`, notificação de interrupção Python e políticas `terminal_facts`, `terminal_publish`, `terminal_plugin_control`.

Portar `runtime/terminal.rs::Services::{facts,publish}` mantendo `TerminalServices`, `InputFacts`, `Services::writing` e `Action::MarkWriting`. Fontes Rust leem campo de entrada, pergunta, capacidades, vínculo e transporte, com captura/parsers/guardas/recibos existentes; não criar segundo monitor. Modo do remetente/alvo usa leitura publicada validada, sem consultar a própria caixa de comandos do ator ou criar espera circular entre atores.

O descritor `TerminalTarget` leva `config_dir`, `agent_pid`, `agent_birth`, `created`, `legacy_import_after`, `fingerprint` e endpoint do remetente provenientes do vínculo atual. Conservar `plugin_key`, `TerminalBinding`, `mux_argv`, `windows`, `clipboard_lock_path` e a origem do remetente aplicável a cada OS. Registro nativo deve conferir pid/sessionId antes de usar `messagingSocketPath`/estado; não inferir pelo nome nem substituir por lookup mais permissivo. A revisão real de fonte exigida pelas guardas 4 vem desse caminho Rust, não de token esperado/epochs Python.

`PermissionMemory`/`PermissionView` já integradas permanecem únicas; `permission.observe` sai do caminho ativo. `LiveSources::deliverable` chama diretamente o handle do `RuntimeRegistry`, sem `session.deliverable -> Python -> Rust`. Identidade, geração e lifecycle migrados não são fatos decididos pelo Python. A Task 6 congela as assinaturas efetivas da ligação no produtor antes de 7/10/12, sem inventar fachada/tipo antecipadamente.

As rotas Claude `GET /api/sessions/{name}/permission-modes` e `POST /api/sessions/{name}/permission-mode` preservam:

- Leitura sem sondagem não envia teclas.
- Sondagem explícita percorre o ciclo e tenta restaurar o modo original; se não restaurar, a resposta informa o modo efetivo.
- `dontAsk` não é sondado; bypass não é alcançado por teclas quando não pertence ao ciclo da sessão.
- Troca pode acontecer durante trabalho quando a CLI permite; painel de terminal aberto, menu incompatível e transferência mantêm suas proteções.
- A resposta informa o modo confirmado, não apenas o solicitado.
- Sessão sem terminal reutiliza o comando e a memória do motor Rust, inclusive `previous_non_plan` e restauração após aprovar a saída de plano.

O controlador de leitura/sondagem/troca ocupa o executor serial durante toda a sequência. Preservar `TETO_TECLAS = 6`, `ESPERA_POR_TECLA = 2.0`, `INTERVALO_POLL = 0.02`, `INTERVALO_POLL_MAX = 0.2`, `TETO_SONDA = 8.0` e prazo próprio de restauração. `PermissionMemory::begin` recusa ausência de retrato e só um begin válido admite finish; não publicar modo intermediário. BTab é exclusivo do controle admitido, não ampliação de `mods_keys`.

Se bypass exigir reabertura, Rust registra `operation_id`, confere atomicamente chave/geração/condições sob barreira, encerra a vida antiga e executa a reabertura restrita com primitives existentes. Não chamar `permission-reopen`/`RuntimeCoordinator.change`/persistência Python nem manter admissão bloqueando seu próprio fechamento. Atualizar conversa/sidecar e geração no Rust, invalidar alvos/recibos antigos e confirmar modo no novo runtime antes de sucesso. Falha vai ao diário, sem devolução de posse.

A unidade 7l captura a receita de reabertura local do Claude vivo/ocioso usando `process::LaunchSpec`, `ProcessView` e leitores existentes: argv/executável/cwd/env com pid/nascimento/chave/conversa conferidos antes/depois, env somente em memória. Não adicionar LaunchSpec Python. Preservar envelope bwrap/read_only, engine/escolhas reais, settings temporários privados antes de matar pai Windows e quoting/destinos tmux/psmux; reutilizar `sysinfo` instalado para ler o processo Windows. Receita ausente, ilegível ou obtida após morte não é prova equivalente: recusar antes de matar sem declarar a reabertura funcional concluída.

O mesmo lifecycle Rust atende pane morto, fechamento explícito terminal/sidecar, limpeza e `/clear`/troca de conversa. Limpar A não remove B; conservar gerações/barreiras/diário. A Task 7 congela o contrato comum de geração/admissão/fechamento com a Task 10 antes de 11/12. A abertura inicial permanece separada, não é atalho Python para executar lifecycle migrado.

### 3. Codex com terminal: adotar a conexão, não criar outro agente

Reutilizar o cliente `hangar-codex` e o motor Codex existentes. Acrescentar ao runtime uma representação explícita da sessão Codex com terminal, com endpoint, identidade do app-server, thread, geração e pane. Não representar essa sessão como headless para contornar validações.

O Rust adota o app-server que o lançador já criou. A abertura/lançador inicial Python, TUI e processo permanecem; não criar segundo app-server. Há um cliente de controle Hangar por sessão, além da TUI. Retirar cliente e produtores Python do caminho da sessão adotada; corpos antigos podem ficar somente como referência, sem reserva quando Rust cair. Preservar responsabilidades ainda não migradas em funcionamento, sem novo vigia/coordenador/passagem de dono Python. A Task 10 é retrabalho Rust de `permissions-codex`; preservar transporte 8/preparação 9 e conferir apenas os contratos comuns alterados, não outra revisão inteira de 9–11.

A adoção valida identidade e endereço local, conecta, inicializa e tenta assinar a thread existente sem iniciar turno nem criar conversa. Conexão adotada e assinatura concluída são estados distintos: uma thread identificada ainda sem primeiro turno pode não ter rollout, e `thread/resume` pode responder `no rollout found for thread id`.

Nesse caso específico, o primeiro envio à thread existente continua permitido após confirmar conexão e identidade; ele não espera a assinatura que depende desse mesmo turno. O histórico passa a ser lido quando o rollout aparecer, e a assinatura é retomada com espera crescente limitada. Não inventar prévia completa enquanto faltam eventos, não criar outra thread para contornar a ausência do arquivo e não tratar qualquer erro de assinatura como “ainda não está pronta”. Thread inválida, processo diferente e falha de protocolo têm erro visível. Esse recorte preserva o comportamento descrito em `backend/app/adapters/codex/adapter.py:535`.

Troca de thread pela TUI atualiza vínculo, geração e conversa/sidecar no Rust antes da nova admissão/publicação. Não voltar a `sessions.switch_thread` Python para persistir. Reconexão do transporte adotado conserva a conversa e os pedidos comprovadamente recuperáveis; não cria thread headless ou app-server novo quando a retomada falha. Há uma tentativa em voo, espera inicial de 1 s, multiplicador 1,5 e teto de 10 s; revalidar processo/endpoint/vínculo antes de conectar. Pane/processo morto e fechamento são tratados pelo lifecycle Rust, não pelo Python.

O motor recebe pelo transporte WebSocket os eventos que hoje recebe do cano e publica estado, prévia, pensamento, ferramenta e perguntas pelo feed Rust. Reaproveitar os tipos e regras atuais; separar apenas as diferenças reais de transporte e operação terminal.

O cliente WebSocket existente não é uma substituição direta do cano: gerencia IDs RPC próprios e sua API pode terminar ao enfileirar a mensagem. A adaptação deve preservar os IDs do motor, a correlação com `operation_id` e os resultados `WriteOutcome::NotWritten`, `Written` e `Unknown`. Entrar na fila local não confirma escrita no socket. Usar uma conexão e uma sequência de confirmação, sem um segundo cliente para obter recibos; a adaptação localizada do transporte precisa entregar ao runtime o resultado real de escrita ou a incerteza.

O envio normal, fila, confirmação pelo rollout, `steer` e interrupção passam ao mesmo runtime. A tabela de despacho só reivindica as operações que têm execução terminal completa. Não ativar todas as rotas marcadas genericamente como controle Codex se alguma continuar fora do recorte.

#### Perguntas e aprovações

- Reutilizar a interpretação dos pedidos e a validação de respostas que já existem no motor Rust.
- Preservar a distinção entre pergunta RPC bloqueante e pergunta assíncrona que vira novo envio; esta última usa a mesma fila/serialização da conversa.
- Resolução pelo terminal, término de turno, troca de thread e desconexão invalidam ou reconciliam a pendência conforme o protocolo. Resposta velha não pode ir para outro turno.
- A TUI continua podendo responder. Distinguir resposta escrita, pedido resolvido e decisão do app comprovada. `serverRequest/resolved` informa `requestId` e `threadId`, não o vencedor nem a decisão aplicada (`crates/hangar-codex/schema/0.161.0.json:6280`). Portanto, escrita concluída não comprova que a opção do app venceu. A resolução fecha o cartão com resultado sem autoria comprovada; o app não anuncia “permitido” ou “negado por você” sem prova adicional do provedor. Reutilizar o resultado incerto do runtime para ausência de confirmação, sem reenvio automático. A disputa app/TUI deve ser coberta nas duas ordens; não reutilizar no terminal a equivalência headless entre `Written` e decisão aplicada.
- Não copiar para terminal a recusa automática de todos os pedidos que o motor headless não atende: o terminal possui outro participante legítimo. O plano deve listar a política por tipo de pedido e preservar as alternativas atuais.
- Quando a aprovação só tiver controle na TUI, o Rust dirige e confirma esse diálogo pelo executor terminal, sem Python decidir ou escrever a resposta.

#### Modos de permissão

A lista e a troca do comando `/permissions` do Codex terminal usam o seletor vivo, não uma tabela fixa de rótulos. Portar a interpretação e a confirmação hoje em `backend/app/codex_permissions.py` e `backend/app/terminal_input.py`, reutilizando o executor Rust. As rotas HTTP correspondentes são `GET` e `POST /api/sessions/{name}/codex-permissions`.

Preservar a conferência do item sob o cursor antes de confirmar, a confirmação adicional de Full Access, o fechamento do seletor nas saídas apropriadas e a releitura do modo efetivo. DTO de opção conserva `{ numero, nome, desc, atual, cursor }`; GET `{ modes, current }` e POST `{ current }`. Prazo esgotado aguardando confirmação não significa que o diálogo não aparecerá. A assinatura do controlador comum é congelada na Task 7 antes da Task 11, sem inventar tipos/fachadas antecipadamente.

Não usar o comando headless de mudar sandbox para a TUI: esse comando pode reiniciar o processo e não tem o mesmo contrato. O teclado fica serializado durante toda a operação, inclusive quando alguma administração não migrada precisar usar a sessão; a integração existente deve delegar ao dono sem voltar a criar outro escritor.

### 4. Corte conjunto, portas Python e recuperação

A autorização existente das portas Python permanece. Depois de autorizar, repassar minimamente a escrita ao mesmo dono Rust, conservando corpo, `interaction_id`, IDs nativos e correlação; devolver seu código/resultado. Q1/B permite somente crescimento mínimo desse repasse, incluindo escritas de convidado/Connect/broadcast/grupo/par/MCP, sem migrar essas funcionalidades. Python não recalcula aprovação, reconstrói pergunta, normaliza corpo depois do ingresso nem mantém pendência/Store/guarda novos.

Tabela, rotas e portas cortam juntas na Task 12. Forma inválida, identidade ausente/antiga e dono doente nas responsabilidades migradas recebem resposta Rust, não relay de volta ao Python. Nenhuma falha pontual em `rust`/`pending` ativa o código Python anterior.

Exceção DELETE/A do dono de Codex terminal: Rust encerra pane/ator/app-server/sidecar/fila e a saída de grupo pelo mecanismo existente, depois repassa o pedido ao Python só para limpeza externa anterior (`share_store`/`sync_tunnel`, `ThenLink`, atalhos e caches). Python não chama Rust de volta; falha de limpeza é visível. Não estender a Claude, persistência de conversa ou reabertura.

Discriminar saldo Python por arquivo: crescimento mínimo de repasse Q1/B, demais alterações zero/negativas. O +78 declarado na revisão da Task 10 ainda exige atribuição a essa exceção, não aprovação pelo total. A decisão A exige retirar `hand-over` e as chamadas Python de relançamento; o dono Rust valida e executa a transição inteira sem janela sem dono. O crescimento autorizado de repasse não autoriza conservar essa ponte antiga.

#### Identidade que veio da tela, não da pergunta atual do servidor

Hoje `/select` pode receber somente `{ option }` (`packages/core/src/api.ts:730`), e `/answer` sem `request_id` pode assumir a pendência atual (`crates/hangar-server/src/session_write/answer.rs:201`). Esse comportamento não distingue clique atrasado na pergunta A de resposta à pergunta B e não será preservado no caminho migrado.

Acrescentar `interaction_id`, identificador opaco da interação exibida, ao estado/pergunta publicado e às respostas por `/api/sessions/{name}/select`, `/select/submit` e `/answer`. Ele vincula chave da sessão, conversa/geração e revisão da pergunta ou menu; não muda a cada poll ou movimento transitório do cursor. IDs nativos continuam no protocolo e são conferidos junto do vínculo, sem serem substituídos pelo nome da sessão.

Cada cliente devolve o identificador do cartão/menu sobre o qual a pessoa agiu, nunca um ID buscado depois do clique. O dono valida e serializa essa identidade com a operação antes do primeiro efeito; troca de pergunta ou de vida da sessão invalida a resposta antiga. Para interação pela TUI, conferir também o diálogo observado antes das teclas e não alegar exclusão sobre ações simultâneas da pessoa que o protocolo não permite controlar.

Cliente anterior sem identidade necessária recebe 409 no caminho migrado, com mensagem de atualização/recarga, sem envio ou associação à pergunta atual. A recusa vale nos ingressos Python autorizados com corpo intacto, sem normalização depois da entrada no Rust. Preservar contratos do legado não migrado. Corpos Python de responsabilidade já migrada podem ficar como referência, sem execução/reserva; não recriar `backend/app/interactions.py`, `test_interaction_contract.py` ou `test_runtime_interaction_guard.py`, arquivados/retirados. Essa matriz de identidade pertence ao Rust, não a uma implementação Python antiga ou nova.

Atualizar API/tipos compartilhados em `packages/core`, os chamadores web/mobile e os próprios tipos/chamadas do desktop nativo. Preservar o layout e os controles; ajustar somente payloads e apresentação fiel de erro/resultado incerto. Novos textos respeitam `pt.json`/`en.json`. Não supor que a instalação conjunta atualiza uma PWA já aberta: esse caso tem erro de contrato seguro e prova específica.

Erros de ponte nunca viram pergunta vazia ou aprovação automática. A mudança de identidade é uma alteração de contrato deliberada, não uma compatibilidade silenciosa.

Leitores das portas ainda Python conservam a projeção runtime/feed existente, sem reconstruir pergunta ou duplicar seu dono. Lista/chat do dono leem diretamente a fonte Rust. Retirar o caminho ativo dos produtores já migrados em `side-events`, `state.py`, fatos/plugin Python; seu código pode permanecer temporariamente como referência, não como reserva. Partes não migradas e o uso unidirecional do Rust continuam funcionando. Não publicar cartão duas vezes nem conservar espera após resolução.

Persistência da sessão aberta, troca de conversa/sidecar e nova geração são Rust. Python conserva os registros iniciais da abertura e preparo/lançador, não persistência/reabertura como serviço de retorno para uma operação Rust.

Se o Rust cair, a responsabilidade já migrada permanece indisponível com erro visível até a recuperação do Rust; não passa a ser executada no Python. O Python ainda atende o que não foi migrado, incluindo suas portas e operações de abertura. Não desligar essas funcionalidades, revogar os repasses em um sentido ou ampliar este lote. O supervisor e a disponibilidade da porta pública precisam desenho confirmado antes de uma mudança ampla. Código Python antigo da responsabilidade migrada pode ficar para consulta, sem caminho ativo.

Reiniciar Rust/backend não deve encerrar a TUI nem seu app-server vivo. Reconstruir o que tiver fonte comprovável e invalidar pedidos sem vínculo confiável. Uma aprovação em voo sem confirmação nunca é reenviada automaticamente como nova aprovação. No Claude, o hook deve poder voltar ao diálogo normal da CLI quando perder a ponte, como no comportamento atual.

## Compatibilidade e segurança

- Reutilizar autenticação da ponte do plugin e admissão das rotas privadas; segredo interno e bearer do dono não entram no ambiente do agente nem no diário.
- Validar chave, conversa, geração, endpoint e identidade do processo antes de adotar ou controlar a sessão.
- Manter barreiras de transferência e terminal aberto. Nenhuma mudança de modo amplia permissões sem escolha explícita do usuário.
- Preservar pedidos de subagentes do Codex quando o protocolo exigir resposta; filtro de thread de notificação não pode descartar um pedido RPC.
- Windows usa psmux e seus endereços/clipboard; Linux usa tmux. Não transportar suposições de `%pane`, quoting ou sinal POSIX para Windows.
- Não trocar dependências ou atualizar CLIs apenas para facilitar a migração.
- Contrato interno alterado exige incrementar `RUST_SERVER_PROTOCOL` e `INTERNAL_PROTOCOL` juntos. Snapshot do cano só muda se seu formato realmente mudar, com as versões correspondentes.

## Critérios de conclusão e provas do plano

O plano de implementação deve deixar verificações executáveis para cada comportamento alterado. Não rodar testes ou builds durante este desenho; execuções seguem a autorização do usuário e as regras do projeto.

A entrega só pode ser considerada concluída depois das provas pertinentes:

1. Pergunta comum, múltipla escolha, texto livre, conversar em vez de responder, permitir/negar e saída de plano funcionam nas combinações aplicáveis de provedor e terminal.
2. Resposta dupla, resposta atrasada, interrupção, pergunta trocada e recriação com o mesmo nome não produzem segunda entrega ou resposta para outra conversa. Incluir clique em A com chegada depois de B, também por `/select`; cliente sem identidade recebe recusa sem efeito. Conferir captura do ID exibido nos clientes core/web/mobile/nativo e conservação do corpo/ID no repasse mínimo das portas Python; provar separadamente o legado não migrado em funcionamento e a responsabilidade Rust sem reserva Python durante queda, sem recriar matriz de identidade Python.
3. Claude terminal tem lista e chat coerentes durante permissão segurada; app ausente e terminal presente mantêm a escolha de onde responder.
4. Modos Claude e Codex preservam leitura, sondagem, confirmação, modo anterior e necessidade de reabertura. Full Access/bypass nunca são aplicados por interpretação de timeout como sucesso.
5. Codex terminal aceita mensagem pelo app e pela TUI, publica estado/prévia uma vez, interrompe corretamente e retoma a conexão sem criar conversa ou turno extra. Incluir adoção sem rollout, primeiro envio antes da assinatura e erro de assinatura que não seja ausência do primeiro turno. Na disputa entre respostas divergentes do app/TUI, testar ambas as ordens e não afirmar decisão aplicada quando só existe escrita ou resolução sem autoria. Entrada na fila WebSocket não pode ser tratada como `Written`.
6. Dono, convidado e Connect preservam autorização e usam a mesma decisão do runtime. Campos do dono e segredos não chegam ao convidado.
7. Reinício, queda de conexão e indisponibilidade do Rust não ativam escritor Python para responsabilidades migradas: erro visível até recuperar Rust. Responsabilidades não migradas, suas portas e abertura continuam no Python. Recuperação arquitetural do supervisor precisa desenho confirmado antes de código, sem promessa de reserva da porta pública ou ponte privada. Pane morto, clear, fechamento, troca de geração/sidecar e reabertura bypass são comprovados no Rust, sem matar TUI/app-server pela simples queda do transporte.
8. Linux e Windows são cobertos com diferenças reais de tmux/psmux. Uso real ocorre em sessões descartáveis e no ambiente combinado, nunca nas sessões vivas de trabalho.
9. Evidência confirma ausência de chamadas Python para fatos/entrega/drenagem, plugin/perguntas/publicação, memória/sondagem/troca de permissões, lifecycle e persistência da conversa migrados. Delimitar autorização/repasse mínimo Q1/B e limpeza externa DELETE/A só depois do fechamento Codex, com ausência de chamada de volta e falhas visíveis; registrar saldo por arquivo. Provar também o relançamento Rust completo das sessões existentes, sem `hand-over`, sem modo presumido e sem perder a proteção, a conta ou a fila escolhidas.

Fixtures e testes existentes de perguntas, permissões, transporte Codex e terminal são a base da paridade. O plano lista os testes focados afetados e as provas reais; suites completas e `scripts/verificar-local` só entram quando pedidos ou exigidos pelo fluxo de publicação autorizado. Não há promessa de ganho de latência sem medir antes/depois na mesma carga.

## Ordem de implementação a detalhar no plano

1. Preservar identidade/DTOs/clientes/guardas/recibos/Store/autenticação 1–5, transporte 8 e preparação 9 já integrados; não recriar sua antiga metade Python ou seus testes novos retirados. Marcadores anteriores não comprovam o novo corte ou execução de provas.
2. Task 6: portar `Services::facts/publish`, `Sources` do plugin, `LiveSources`, feed/lista diretamente ao Store/RuntimeRegistry; descritor com identidade nativa/remetente e remoção de chamadas ativas Python. Congelar assinaturas no produtor antes dos consumidores.
3. Task 7: preservar PermissionMemory integrada, implementar controlador serial e lifecycle Rust, incluindo bypass/pane morto/fechamento/clear/troca de conversa/sidecar. Congelar contrato de geração/admissão/fechamento em conjunto com a Task 10.
4. Task 10 por `permissions-codex`: retrabalho Rust da adoção/lifecycle/feed do Codex, conservando transporte/primeiro input e contratos de 9. Conferir delta comum, não revisar 9–11 de novo. Task 11 recebe controlador comum congelado.
5. Task 12: rotas/tabela/portas cortam juntas; erros migrados ficam no Rust; Python conserva responsabilidades não migradas funcionando, autorização/repasse mínimo Q1/B e limpeza externa DELETE/A Codex. Responsabilidades já Rust não têm execução Python antiga como reserva durante queda; seus corpos podem ficar como referência sem chamador ativo. Ativar o relançamento Rust das sessões já abertas somente após integrar suas dependências revisadas. A abertura inicial permanece no Python; o desenho de recuperação do supervisor ainda depende de decisão do usuário. Task 13 recebe provas autorizadas e documentação do estado real.

Unidades Claude/Codex independentes podem seguir em paralelo sem disputar arquivos. Rotas/tabela/gateway/versão de protocolo e remoções Python comuns são integradas com um escritor por árvore. Não inventar tipos/interfaces ausentes: a unidade responsável congela sua ligação efetiva antes dos consumidores. Escrever regressões durante a implementação, sem executar até pedido do usuário; nenhuma prova ou Task é marcada concluída por revisão documental.

## Trabalho posterior contratado: abertura

- [ ] Preparar e submeter um segundo desenho/plano para abertura completa de Claude/Codex, com e sem terminal.

Esse segundo trabalho inclui pedido de criação, reserva de identidade/nome, escolha da conta, configuração efetiva, comando/ambiente, registros iniciais, lançamento, adoção, cancelamento e recuperação. Inclui substituir o lançador/supervisor Python do Codex terminal quando necessário para tornar o nascimento responsabilidade do Rust. Deve preservar locks de conta, systemd, tmux/psmux, `PATHEXT` e sincronização de conta Codex que não bloqueia a abertura.

Não implica migrar login/cadastro de contas, transferência de conversa ou operações gerais de worktree. Serviços auxiliares que continuarem Python precisam ser delimitados no segundo desenho, sem voltar a dividir a decisão de iniciar o agente. Este item permanece pendente e não desaparece com a conclusão do primeiro plano.
