# Plano de implementação: perguntas e permissões no Rust

> **Para agentes executores:** execução autorizada pelo usuário com `superpowers:subagent-driven-development`, coordenada por `permissions-gpt` e `permissions-codex`, em worktrees isoladas da mesma base publicada de `main`. Executar por Task e marcar somente Steps efetivamente cumpridos. Testes/builds, serviços, commits e publicação continuam sujeitos às autorizações específicas abaixo; a execução não os autoriza automaticamente.

**Objetivo:** tornar Rust o único responsável ativo pelas perguntas, aprovações e modos de permissão Claude/Codex, incluindo conexão, envio, fila e estado do Codex com terminal, sem migrar a abertura completa.

**Arquitetura:** reutilizar os motores e escritores Rust existentes. O plugin Claude passa a ter memória Rust; o Codex terminal adota o app-server já existente por WebSocket, sem lançar outro processo. Uma identidade da interação exibida acompanha a resposta do cliente até a operação serializada; envio escrito e decisão aplicada permanecem conceitos distintos.

**Stack:** Rust, Tokio, Axum, Serde, `hangar-api`, `hangar-codex`; Python/FastAPI somente na abertura/preparo e na autorização existente das portas Python com repasse mínimo de escritas ao Rust; TypeScript compartilhado, Svelte, Expo e GPUI. Usar as dependências já instaladas.

**Desenho aprovado:** `docs/superpowers/specs/2026-10-10-conversation-permissions-rust-design.md`.

**Base consultada:** `0264a8150`, branch `Hangar-rust`; protocolos Python/Rust em `51`. Linhas citadas identificam essa base; procurar pelo símbolo se houver deslocamento.

**Contrato vigente (opção A, 11/10):** este texto substitui as instruções anteriores que atribuíam reserva, ciclo de vida, persistência ou reabertura ao Python. Preservar identidade/DTOs/clientes/guardas/recibos/Store já integrados nas Tasks 1–5, transporte 8 e preparação 9; conferir a ligação ao novo dono nas unidades responsáveis, sem redispatchar sua implementação nem revisar novamente 9–11 por inteiro. A revisão do contrato antigo não comprova o corte novo. Os marcadores existentes registram somente trabalho efetivamente integrado; nenhum marcador é acrescentado por esta revisão documental e todas as provas não executadas continuam pendentes. Os arquivos Python novos de identidade e seus testes foram arquivados/retirados e não serão recriados.

## Restrições globais

- Retrabalho por subagentes autorizado. Sessão `permissions-gpt-2`: continuação das Tasks 1–7 e integração/provas 12–13; sessão `permissions-codex`: Tasks 8–11 e retrabalho Rust da Task 10. `hangar` somente retransmite retornos antigos. Nenhuma sessão escreve na worktree da outra. Ver o contrato compartilhado do grupo e o registro de execução para pacotes de transferência.
- Abertura completa é um segundo trabalho. Não portar `POST /api/sessions`, lançador inicial Codex, preparo/instalação/login de conta, gestão geral de worktrees ou criação inicial de processos. Python conserva somente criação/abertura, lançador e preparo de conta. Relançamentos Codex existentes — terminal↔sem terminal e reiniciar — são Rust. A inspeção corrigiu a explicação: troca de conta de Codex aberto não existe e não será criada; `publish_imported` é transferência Claude→Codex com abertura nova, portanto continua no fluxo inicial Python. Transferência administrativa fora do recorte continua fora. Atualização do vínculo/conversa/sidecar da sessão adotada é Rust.
- Com Rust ativo, fatos, entrega, plugin/perguntas, publicação, memória de permissões, sondagem/troca, reabertura para bypass, pane morto, fechamento/limpeza e troca de conversa/sidecar são Rust. Nenhum desses caminhos volta ao Python.
- Exceção aprovada para as portas Python: autorização existente e repasse mínimo de escritas em um sentido ao Rust, conservando corpo, `interaction_id` e correlação da operação. Q1/B admite somente o crescimento mínimo indispensável a esse repasse, por arquivo; após entrada no Rust, Python não normaliza corpo nem reconstrói pergunta, e erro de forma ou dono doente é tratado pelo Rust.
- Exceção DELETE/A, somente Codex terminal: o Rust encerra a sessão e depois repassa o pedido ao Python apenas para limpeza externa já existente (`share_store`/`sync_tunnel`, `ThenLink`, atalhos e caches). Python não decide lifecycle nem chama Rust de volta. Não estender a Claude.
- As demais alterações Python são remoção/condicionamento de produtores antigos, com saldo zero ou negativo. O acréscimo declarado de +78 linhas na Task 10 ainda precisa ser discriminado por arquivo e atribuído somente ao repasse aprovado; não é autorização geral de crescimento. Não criar reserva, passagem de dono, vigia ou ponte Python novos. Preservar o legado não migrado em funcionamento; código Python de responsabilidade já migrada pode ficar como referência, sem chamador ativo nem reserva quando Rust cair.
- Decisão A confirmada em 11/10: relançar sessão já aberta é Rust. No Codex cobre os relançamentos existentes terminal↔sem terminal e reiniciar; no Claude inclui reabertura para bypass. Troca de conta Codex não existe; importar de Claude cria um Codex novo e pertence à abertura inicial, conforme conferência do código e correção da explicação ao usuário. Retirar `hand-over` inteiro (rota, espera e chamadas Python), não liberar o dono antes de validar e não usar Python para executar o relançamento. Python conserva somente a abertura inicial; cadastro/login e preparo inicial de conta continuam fora do port.
- Voz, custos, MCP/grupos/navegador/atalhos/estatística e Pi/omp/Kimi não migram por vizinhança. Preservar seus contratos existentes sem ampliar este lote.
- Não redesenhar telas nem acrescentar controles. Alterar somente contratos, captura da identidade exibida e mensagens necessárias para representar erros/resultados incertos.
- Nenhuma operação amplia permissões sem escolha explícita. Não transformar ausência de resposta em aprovação.
- `interaction_id` acompanha a pergunta/estado/lista e os pedidos de resposta. Sem identidade, o caminho migrado recusa com 409; não assume a pergunta atual.
- Identidade inclui chave da sessão, conversa/geração e revisão semântica da interação. Cursor, spinner e nova publicação do mesmo estado não criam outra interação.
- A operação valida novamente a identidade no dono, antes do primeiro efeito, sob a mesma serialização da escrita.
- Perguntas e aprovações sem terminal já implementadas no Rust são reutilizadas, não reconstruídas.
- `ESPERA_S = 25`, `SEM_POLL_S = 5`, `CONFIRMA_S = 5`; pergunta segurada tem teto absoluto `ESPERA_S + 10`. Preservar `PUBLICA_S = 30` e `VALIDADE_ESTADO_S = 90` do plugin.
- Modo Claude: `TETO_TECLAS = 6`, `ESPERA_POR_TECLA = 2.0`, `INTERVALO_POLL = 0.02`, `INTERVALO_POLL_MAX = 0.2`, `TETO_SONDA = 8.0`; a restauração da sondagem possui seu próprio prazo, como hoje.
- Correção humana de 11/10: responsabilidade já migrada não volta ao Python quando o Rust cai, nem como reserva; o supervisor recupera o Rust com erro visível. As funcionalidades ainda não migradas continuam funcionando no Python, inclusive as portas convidado/Connect, sem ampliar este lote. A coexistência em um sentido continua autorizada. O desenho da porta pública durante a retomada precisa confirmação antes de alterar o supervisor; não desligar legado ou introduzir um corte global por interpretação.
- Reiniciar backend/Rust não deve matar a TUI/app-server adotados. Fechar conexão e encerrar processo são operações diferentes.
- Linux/tmux e Windows/psmux têm a mesma entrega funcional. Preservar endereços, clipboard, identidade e confirmação específicos de cada sistema.
- O nativo não importa `packages/core`. Atualizar seus DTOs e chamadas próprios; manter `messages/pt.json` e `messages/en.json` juntos.
- Testes automatizados avulsos não rodam por Task sem pedido. Escrever regressões junto do código; os comandos abaixo ficam reservados para o lote focado solicitado pelo usuário. Não começar com suites completas.
- Uso real exige ambiente combinado e sessões descartáveis. Não subir segundo backend nem experimentar nas sessões de trabalho. Windows é DELPHI-02, sem tomar a sessão RDP nem ligar WinBoat.
- Sem formatter em massa, dependência nova, branch/worktree nova, commit ou push sem a autorização específica correspondente.
- A troca de contrato interno incrementa `RUST_SERVER_PROTOCOL` e `INTERNAL_PROTOCOL` juntos na integração. Na base consultada, o próximo número é `52`; se a base avançar, conferir ambos e usar o próximo livre. Não alterar a versão do cano sem mudança no seu snapshot.

## Foco da revisão

Cada caso abaixo possui prova na Task indicada; não é uma lista para abrir outra auditoria no fim.

1. Clique de cliente/PWA antiga chega depois de outra pergunta com texto idêntico: recusar sem efeito, inclusive `/select/submit` e ingressos autorizados das portas Python com corpo intacto. Tasks 1–4 e 12.
2. TUI nega enquanto app permite: não inventar autoria pelo ACK de escrita ou por `serverRequest/resolved`; não reenviar automaticamente. Task 9.
3. Thread Codex identificada ainda não tem rollout: primeiro envio funciona antes de `subscribed`, sem criar outra thread. Tasks 9–10.
4. WebSocket cai depois do enqueue e antes da confirmação: conservar resultado desconhecido e correlação dos IDs, sem tratar enqueue como `Written`. Task 8.
5. psmux reutiliza `%1`, sessão reaparece com o mesmo nome ou painel abre durante seleção: validar vida/destino e preservar proteção do terminal, sem tecla na sessão errada. Tasks 5, 7, 11–13.

## Mapa das unidades

| Unidade | Arquivos novos propostos | Código existente reutilizado |
| --- | --- | --- |
| Identidade da interação | Nenhum adicional: preservar `crates/hangar-server/src/interactions.rs` integrado | DTOs `hangar-api`, motores, Monitor e projeção da lista; sem registro Python novo |
| Clientes | Nenhum módulo de infraestrutura novo | APIs core, callbacks Svelte/Expo, snapshots GPUI |
| Plugin Claude | Preservar `crates/hangar-server/src/plugin/mod.rs`, `store.rs`, `routes.rs` integrados | Autenticação/vínculo em `mods/bridge.rs`, protocolo do plugin e executor terminal |
| Fatos locais da entrega | Definir organização local na Task 6, sem antecipar tipo/fachada | `runtime/terminal.rs::Services`, `InputFacts`, `TerminalServices`, Store e RuntimeRegistry |
| Modos e seletor terminal | Módulos de controlador definidos na Task 7 | `PermissionMemory` integrada, parser `state/permission.rs`, `TerminalIo`, executor serial |
| Transporte Codex | Preservar `crates/hangar-server/src/runtime/websocket.rs` integrado | Transporte de `hangar-codex/src/client.rs`, `IoEvent`, `WireFrame`, motor existente |
| Adoção Codex terminal | Retrabalho de `crates/hangar-server/src/runtime/codex_terminal.rs` pela parceira | RuntimeRegistry, ator, fila, recibos e feed Rust; não coordenador Python novo |
| Provas integradas | `crates/hangar-server/tests/it/conversation_contract.rs` | Fixtures e regressões Rust/clientes atuais; sem recriar testes Python de identidade |

As interfaces de identidade/guardas/Store/transporte já integradas são preservadas conforme os símbolos atuais, não reimplementadas pelos exemplos históricos abaixo. Para as ligações ainda pendentes nas Tasks 6/7/10/12, descrever responsabilidades sobre os símbolos existentes; a unidade produtora congela a assinatura efetiva antes de liberar consumidores. Não inventar antecipadamente tipos, fachadas ou pontes Python. Os blocos de regressão fixam comportamento, não comprovam execução.

## Dependências e integração

```text
Task 1 -> Tasks 2, 3, 4, 5
Task 5 -> Task 6 -> Task 7
Tasks 1, 4, 8 -> Task 9 -> Task 10
Tasks 7, 10 -> Task 11
Tasks 1-11 -> Task 12 -> Task 13
```

Task 8 é independente da unidade Claude e seu transporte integrado é preservado. A preparação 9 já entregue conserva os contratos de identidade/comando 1/4 e transporte 8. Task 10 é retrabalhada em Rust por `permissions-codex`; nova geração, admissão e fechamento usam contrato comum congelado com a Task 7 antes dos consumidores 11/12, não outra revisão inteira de 9–11. Task 11 depende também do controlador serial da Task 7. Tasks 2 e 3 não compartilham componentes de tela. Gateway, ator, DTOs, protocolo e roteador são arquivos de integração: um escritor por árvore; não editar o mesmo arquivo em paralelo nesta worktree.

As Tasks preparatórias podem ser conferidas isoladamente, mas não são releases autônomas. Não publicar cliente exigindo campo que o backend descarta, nem ativar domínio Rust antes dos leitores/controles dependentes. A Task 12 faz o corte completo pela tabela de dono e pelas rotas; não introduzir feature flag nova para esconder implementação incompleta.

---

### Task 1: Identidade estável da interação e contrato de erro

**Arquivos:**
- Preservar: `crates/hangar-server/src/interactions.rs`, `crates/hangar-server/src/lib.rs`, `crates/hangar-api/src/state.rs`, `crates/hangar-api/src/ask.rs`, `crates/hangar-api/src/session.rs` já integrados.
- Preservar os literais de `AskQuestion` em `crates/hangar-server/src/state/ask.rs` e `state/monitor.rs`: `serde(default)` não supre campos de inicializadores Rust.
- Escrever/conservar regressões Rust internas de `interactions.rs`, sem executar. `backend/app/interactions.py`, `backend/tests/test_interaction_contract.py` e `backend/tests/test_runtime_interaction_guard.py` foram arquivados/retirados; não recriar nem incluí-los nos comandos deste plano. Modelos Python só entram se indispensáveis ao repasse mínimo da Task 12, sem nova memória ou contrato autoritativo.

**Interfaces:**
- Preservar `InteractionBinding { key: String, conversation: String, generation: u64 }`, com `Clone`, `PartialEq` e `Eq`.
- Preservar `InteractionKind::{Question, Approval, Menu}` e `InteractionTarget { kind: InteractionKind, request_key: String }`, com `Clone`, `PartialEq`, `Eq` e `Hash`. `request_key` codifica a identidade nativa completa, incluindo thread e tipo do ID; o número `1` não é a string `"1"`. Menu sem ID nativo usa identidade de vida/abertura observada, não só seu texto.
- Preservar `InteractionStore::observe(&self, binding: &InteractionBinding, target: &InteractionTarget, semantic: Option<serde_json::Value>) -> Result<Option<String>, InteractionError>`.
- Preservar `InteractionStore::validate(&self, binding: &InteractionBinding, supplied: Option<&str>) -> Result<InteractionTarget, InteractionError>`; retorna o pedido associado ao token, não apenas aprovação booleana.
- Preservar `InteractionStore::forget(&self, key: &str) -> Result<(), InteractionError>` para invalidar todos os alvos daquela sessão e expor `Unavailable` se a trava falhar; não há implementação Python nova.
- Preservar `InteractionError::{Missing, Changed, Unavailable}` e o vínculo autoritativo/limpeza condicional já refinados na Task 4.
- DTOs Rust conservam `interaction_id: Option<String>`; ausente continua legível em mensagens antigas. Portas Python conservam o campo recebido no corpo, sem Store paralelo. Nenhuma autorização se baseia somente nesse identificador. O campo do estado/lista pertence ao seletor ali exibido; `codex_question` e `ask_question` levam seu próprio ID no payload da pergunta. Eles podem coexistir com IDs diferentes.

- [x] **Step 1: Escrever regressões de identidade antes da ligação às rotas**

Incluir troca A/B com conteúdo igual, fechamento/reabertura da mesma pergunta, mudança de geração, reutilização do nome com outra chave e formulário simultâneo a uma aprovação. O mesmo retrato completo do mesmo alvo conserva o ID; leitura indisponível não é `None` e não apaga a interação.

```rust
#[test]
fn conversation_identity_keeps_question_and_approval_independent() {
    use serde_json::json;
    let store = InteractionStore::default();
    let a = InteractionBinding { key: "key-a".into(), conversation: "sid".into(), generation: 1 };
    store.bind(&a).unwrap();
    let approval = InteractionTarget { kind: InteractionKind::Approval, request_key: "approval-1".into() };
    let form = InteractionTarget { kind: InteractionKind::Question, request_key: "question-1".into() };
    let prompt = json!({"question":"Permitir?","options":["Sim","Não"]});
    let first = store.observe(&a, &approval, Some(prompt.clone())).unwrap().unwrap();
    let form_id = store.observe(&a, &form, Some(json!({"question":"Qual pasta?"}))).unwrap().unwrap();
    assert_eq!(store.observe(&a, &approval, Some(prompt.clone())).unwrap(), Some(first.clone()));
    assert_eq!(store.validate(&a, Some(&form_id)), Ok(form.clone()));
    assert_eq!(store.validate(&a, Some(&first)), Ok(approval.clone()));
    assert_eq!(store.validate(&a, None), Err(InteractionError::Missing));
    store.observe(&a, &approval, None).unwrap();
    assert_eq!(store.validate(&a, Some(&form_id)), Ok(form));
    let second = store.observe(&a, &approval, Some(prompt.clone())).unwrap().unwrap();
    assert_ne!(first, second);
    assert_eq!(store.validate(&a, Some(&first)), Err(InteractionError::Changed));
    let b = InteractionBinding { generation: 2, ..a.clone() };
    store.bind(&b).unwrap();
    store.observe(&b, &approval, Some(prompt)).unwrap();
    assert_eq!(store.validate(&a, Some(&second)), Err(InteractionError::Changed));
}
```

- [x] **Step 2: Implementar o registro pequeno, sem outro dono das perguntas**

Guardar vínculo, alvo, representação semântica e token opaco por interação ativa, não um único token por sessão. As pendências, resposta em curso e recibos continuam no motor/plugin dono. Preservar `InteractionStore`/`StoreState`/`Entry` atuais, incluindo vínculo autoritativo e revisão de fonte; erro de lock/aleatoriedade vira `Unavailable`. Gerar 16 bytes com `ring::rand::SystemRandom` e codificar em 32 caracteres hexadecimais. Não persistir tokens nem reaproveitá-los após restart ou troca de vínculo; não adicionar geração de tokens Python.

A validação preserva a implementação integrada: `validate` usa `expected`, que confere vínculo ativo e token sob a mesma trava e copia alvo, semântica e revisão nativa. Não substituir por um mapa antigo que ignore a ativação autoritativa ou a revisão de fonte.

A busca percorre apenas interações vivas, removidas ao resolver ou sair o vínculo; não guardar histórico de tokens. Preservar o refinamento autoritativo da Task 4: nova geração/conversa é ativada por `bind` do dono, não por `observe` de callback/publicação antiga. Limpeza de A é condicional ao vínculo/revisão de A e não apaga B; remoção total fica na saída autoritativa daquela vida. Não chamar encerramento a partir de evento parcial que apenas omite a pergunta. O exemplo anterior conserva a matriz de identidade com `bind`; regressões integradas preservam também a revisão de fonte e as assinaturas efetivas de 4.

Publicações de formulário e aprovação não prevalecem uma sobre a outra: `StateEvent.interaction_id` identifica `question/options`, enquanto `StateEvent.codex_question.interaction_id` e o `ask_question` correspondente identificam o formulário. Ordem entre os eventos não afeta validade. Validar retorna o alvo exato; o comando responde a esse pedido nativo, nunca ao primeiro da coleção atual. `/select` rejeita token de formulário incompatível com a ação, mesmo que o token pertença à mesma sessão.

- [x] **Step 3: Acrescentar os campos e fixar as respostas públicas**

Em `StateEvent`, `AskQuestion` e `SessionRow` Rust, preservar o campo opcional com default de leitura. Não recriar equivalentes produtores Python; o repasse da Task 12 conserva o corpo recebido. Publicação nova inclui o ID da interação correspondente àquela superfície; formulário e aprovação simultâneos podem ter IDs diferentes. DTO antigo sem campo ainda pode ser lido. Atualizar já nesta Task os literais `AskQuestion` de `state/ask.rs` (incluindo o teste) e `state/monitor.rs` com `interaction_id: None`; `serde(default)` não preenche literais. A publicação autoritativa das Tasks seguintes atribuirá o valor.

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub interaction_id: Option<String>,
```

Fixar envelopes de erro, usando o formato `erro(código, mensagem)` existente:

| Condição | HTTP/código | Mensagem pt-BR |
| --- | --- | --- |
| ID ausente/vazio no caminho migrado | 409 `erro_interacao_sem_identidade` | Atualize o app ou recarregue a página antes de responder. |
| ID antigo, conversa/vida diferente ou pergunta encerrada | 409 `erro_interacao_desatualizada` | Essa pergunta mudou ou já foi encerrada. Confira a pergunta atual. |
| Dono/retrato indisponível | 503 `erro_interacao_indisponivel` | Não foi possível conferir a pergunta. Nenhuma resposta foi enviada. |

Não gerar efeito para esses erros. Para um efeito que pode ter acontecido, usar o erro existente de resultado incerto, nunca a mensagem “nenhuma resposta foi enviada”.

- [ ] **Step 4: Conferir a prova focal desta unidade quando autorizada**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --lib conversation_identity
```

Resultado esperado: IDs estáveis apenas na mesma interação; rotação de vida/fechamento invalida os antigos no dono Rust. Não executar o comando sem pedido; os testes Python de identidade retirados não fazem parte desta prova.

### Task 2: Propagar o ID exibido no core, PWA, mobile e controles legados

**Arquivos:**
- Alterar: `packages/core/src/types.ts`, `packages/core/src/api.ts`, `packages/core/src/api.test.ts`.
- Alterar: `frontend/src/screens/Chat.svelte`, `frontend/src/components/OptionButtons.svelte`, `MessageList.svelte`, `AskQuestionStepper.svelte`, `AskQuestionCard.svelte`, `AskQuestionSheet.svelte`, `BoardCard.svelte`, `AttentionFeed.svelte`, `WorkspaceAttentionStrip.svelte`.
- Alterar: `mobile/src/stores/chat.ts`, `mobile/app/s/[server]/[name]/index.tsx`, `mobile/app/s/[server]/[name]/ask.tsx`, `mobile/src/features/ask/AskStepper.tsx`, `mobile/src/chat/OptionButtons.tsx`.
- Testar: `frontend/src/screens/Chat.codex-flow.test.ts`, `frontend/src/components/AskQuestionStepper.test.ts`, `frontend/src/components/OptionButtons.test.ts`, `mobile/src/features/ask/AskSheet.test.tsx`, `mobile/src/stores/chat.test.ts`, `mobile/src/chat/OptionButtons.test.tsx`.

**Interfaces:**
- `SessionInfo`, `StateEvent` e `AskQuestionPayload` recebem `interaction_id?: string | null`.
- Assinaturas novas, sem overload de compatibilidade silencioso:

```ts
selectOption(name: string, option: number, interactionId: string | null | undefined, server?: Server | null): Promise<void>
submitSelected(name: string, interactionId: string | null | undefined, server?: Server | null): Promise<void>
selectOptionForServer(s: Server, name: string, option: number, interactionId: string | null | undefined): Promise<void>
submitSelectedForServer(s: Server, name: string, interactionId: string | null | undefined): Promise<void>
answerQuestions(name: string, answers: AnswerItem[], requestId: string | number | undefined, interactionId: string | null | undefined, server?: Server): Promise<{ ok: boolean; fallback?: boolean }>
```

Provedores fora da migração passam `undefined` explicitamente e conservam a forma anterior do corpo. Não fabricar ID local para Pi/omp/Kimi ou para servidor antigo.

- [ ] **Step 1: Prender os envelopes nos testes do core**

Ampliar a matriz existente `contratos de conversa com servidor explícito` e importar `selectOptionForServer`/`submitSelectedForServer` no arquivo de teste. Preservar `request_id: 0`, destino da sessão e erro sem repetição automática do POST. Incluir um estado com aprovação e formulário simultâneos: botões devolvem o ID de `question/options`, e o formulário devolve o ID de seu próprio payload, sem copiar o campo superior do estado.

```ts
it('envia a identidade exibida na seleção e no submit', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"ok":true}'));
  const target = { id: 'b', label: 'Servidor B', baseUrl: 'https://b.test', token: 'token-b' };
  await selectOptionForServer(target, 'sessao', 1, 'interaction-a');
  await submitSelectedForServer(target, 'sessao', 'interaction-a');
  expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ option: 1, interaction_id: 'interaction-a' });
  expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({ interaction_id: 'interaction-a' });
});
```

Adicionar caso de `/answer` com ID numérico zero e caso sem ID para um provedor não migrado; nenhum usa teste por truthiness.

- [ ] **Step 2: Alterar APIs e callbacks para carregar o retrato renderizado**

Usar o parâmetro recebido, sem consultar estado global depois do clique:

```ts
body: JSON.stringify({
  option,
  ...(interactionId == null ? {} : { interaction_id: interactionId }),
})
```

`submitSelected` passa a enviar JSON, não corpo vazio. `answerQuestions` conserva `request_id` separado de `interaction_id`. Não alterar `AnswerItem.question_id`, que identifica uma pergunta dentro do formulário.

Nos componentes, encaminhar identidade junto de `index`/`answers`/Submit. No Svelte, criar snapshot imutável dentro do bloco correspondente à interação, usando a identidade na chave; não fechar o callback sobre o `askPayload` mutável do pai. Em React, capturar o payload da renderização e passar a identidade recebida pelo callback até a API.

A deduplicação/reset de stepper, escolhas e submissão em voo inclui `interaction_id`, não só `request_id` ou texto. Retorno de A não fecha B. Atualizar também as opções no Board/Canvas, AttentionFeed, WorkspaceAttentionStrip e seletor pré-thread web, sem acrescentar funcionalidades a esses legados.

- [ ] **Step 3: Cobrir trocas visuais sem redesenhar**

Nos testes de componentes existentes, manter dois payloads com mesmas perguntas e IDs diferentes:

```ts
const first = { ...payload, request_id: 'same-native-id', interaction_id: 'interaction-a' };
const second = { ...payload, request_id: 'same-native-id', interaction_id: 'interaction-b' };
expect(first.questions).toEqual(second.questions);
expect(first.interaction_id).not.toBe(second.interaction_id);
```

Renderizar A, reter callback/submissão de A, renderizar B e concluir A. A chamada deve levar `interaction-a`, e B deve continuar aberta. Testar também múltipla escolha: mudar marcação não troca ID; Submit usa o mesmo retrato. Expo pré-thread continua oferecendo terminal, não ganha seletor novo.

Erros de identidade/resultado incerto usam os avisos existentes; nenhum handler substitui o ID pelo atual e reenvia para “corrigir” o erro.

- [ ] **Step 4: Reservar os checks focados e a prova de tela**

```bash
npm run test -w @hangar/core -- src/api.test.ts
npm --prefix frontend run test -- src/screens/Chat.codex-flow.test.ts src/components/AskQuestionStepper.test.ts src/components/OptionButtons.test.ts
npm --prefix mobile run test -- src/features/ask/AskSheet.test.tsx src/stores/chat.test.ts src/chat/OptionButtons.test.tsx
```

Quando solicitados, executar em um lote, respeitando os locks dos scripts. Na prova real final, verificar PWA/mobile e preservação dos controles legados; testes de tipos não substituem clicar e responder.

### Task 3: Capturar a identidade nos DTOs e snapshots do nativo

**Arquivos:**
- Alterar: `desktop-native/src/api/dto.rs`, `desktop-native/src/interaction.rs`, `desktop-native/src/app.rs`, `desktop-native/src/app/controls.rs`.
- Reutilizar: `desktop-native/src/api/mod.rs::act`, `hangar_api::state::StateEvent`.
- Testar: testes internos de `desktop-native/src/interaction.rs` e do snapshot em `app.rs`.

**Interfaces:**
- `AskPayload.interaction_id: Option<String>` e `SessionInfo.interaction_id: Option<String>`.
- `answer_body(&Ask, &[Pick]) -> Option<Value>` conserva assinatura e inclui campo no envelope.
- `select_snapshot(&SessionState)` conserva seu tipo atual, mas a igualdade inclui `interaction_id`.
- `Action::path()`/`act(...)` transportam corpo JSON no Submit; não importar o core TypeScript.

- [x] **Step 1: Acrescentar regressão com duas perguntas iguais**

```rust
#[test]
fn conversation_answer_body_preserves_displayed_interaction() {
    let raw = serde_json::json!({
        "provider":"claude", "request_id":7, "interaction_id":"interaction-a", "is_async":false,
        "questions":[{"header":"Escolha","question":"Qual?","multiSelect":false,
            "options":[{"label":"A","description":"Primeira"}]}]
    });
    let payload: AskPayload = serde_json::from_value(raw.clone()).unwrap();
    let ask = Ask::new(payload, &raw);
    let body = answer_body(&ask, &[Pick::Options(vec![0])]).unwrap();
    assert_eq!(body["interaction_id"], "interaction-a");
    assert_eq!(body["request_id"], 7);
}
```

Incluir snapshot A/B com mesmo texto/opções e IDs diferentes; retorno atrasado não libera B nem troca sua seleção.

- [x] **Step 2: Atualizar DTOs, envelope e ações capturadas**

```rust
if let Some(id) = &ask.payload.interaction_id {
    body["interaction_id"] = serde_json::json!(id);
}
```

Aplicar em `answer_body`, seleção simples, múltipla/Submit e `preselect`. O callback leva o snapshot que já capturava, agora com identidade; não buscar outra no início da requisição. `Ask::fingerprint`/reset conserva IDs novos no retrato bruto. Construções de `AskPayload` sintéticas de Pi/omp/Kimi recebem `None`.

- [ ] **Step 3: Preservar erro e ausência de confirmação**

Recusa 409 de ID antigo não vira aprovação local nem novo POST. Resultado incerto não mostra “permitido por você”; o cartão encerra pela resolução publicada, sem atribuir autoria. Reutilizar a apresentação de erro atual, com traduções da Task 4.

- [ ] **Step 4: Reservar verificação e uso real do nativo**

```bash
cargo test --manifest-path desktop-native/Cargo.toml conversation_
```

Rodar somente quando pedido, com os demais testes focados. Build otimizado e print do app real entram na Task 13; não confundir navegador embutido com tela GPUI nem roubar o mouse para testar escondido.

### Task 4: Validar identidade no ingresso e no ponto de efeito

**Arquivos:**
- Alterar: `crates/hangar-server/src/interactions.rs` para `ExpectedInteraction`/`expected`; `session_write/control.rs`, `answer.rs`, `table.rs`; `runtime/claude.rs`, `runtime/codex.rs`, `runtime/terminal.rs`, `terminal_input.rs`, `state/ask.rs` (todos sob `crates/hangar-server/src/`).
- Python: preservar handlers de responsabilidades não migradas; corpos de respostas já migradas podem ficar somente como referência, sem chamador ativo ou reserva. Em `api.py`/`runtime_adapter.py`, conservar autorização e repasse mínimo dos corpos ao Rust no corte da Task 12. Não refazer guardas, leitores de perguntas ou normalizadores Python nem desligar portas/CLI.
- Preservar: `messages/pt.json`, `messages/en.json`; `scripts/prova-parte4.py` apenas nos envios afetados.
- Escrever/conservar: `crates/hangar-server/tests/it/session_write_control.rs`, `session_write_answer.rs` e regressões guardadas Rust já integradas, sem executar. Não recriar os testes Python novos de identidade retirados.

**Interfaces:**
- Corpos `/select`: `{ option, interaction_id }`; `/select/submit`: `{ interaction_id }`; `/answer`: `{ answers, request_id?, interaction_id }`.
- `RuntimeCommand.payload` e controle terminal preservam `interaction_id` até o dono; o `request_id` nativo é validado separadamente.
- Preservar `interactions.rs::error_code`, `ExpectedInteraction` e `InteractionStore::expected` integrados: vínculo, alvo, token, semântica e revisão de fonte copiados sob a mesma trava.
- Preservar os métodos guardados de seleção/Submit/resposta do `TerminalDriver` integrado. Conferência de diálogo fica dentro da serialização, sem adquirir o mesmo lock novamente; fonte nativa real é ligada na Task 6, não substituída por leitor Python.
- Preservar controle terminal `answer_chat` pelo `TerminalHandle::control`: pergunta esperada, fechamento, texto e recibo em um único `operation_id`.

- [x] **Step 1: Escrever a matriz de ingresso antes dos handlers**

Preservar a matriz escrita no Rust: corpo `{option:1}` sem ID, ID antigo, `interaction_id` numérico, `option:"1"` com ID antigo e extras inválidos. Ausência devolve o 409 definido, sem completar o token pela pergunta atual; erro de forma é respondido pelo Rust, sem retorno ao normalizador Python. Todas as recusas têm zero comandos no escritor.

Os marcadores históricos deste Step não autorizam recriar sua antiga parte Python. Na Task 12, conservar a prova de autorização das portas e do repasse do corpo recebido, não adicionar Store/guarda Python.

- [ ] **Step 2: Tirar a associação implícita com a pergunta atual**

`control.rs::parse_option` reconhece o campo de identidade sem `object.len() == 1`; forma inválida é tratada no próprio Rust. Não devolver corpo normalizável ao Python depois do ingresso. `answer.rs::terminal_plan` não infere identidade a partir de `pending` para suprir a falta do ID público.

```rust
let supplied = payload.get("interaction_id").and_then(serde_json::Value::as_str);
let expected = interactions.expected(&binding, supplied)?;
```

Esse núcleo entra na operação do dono. A resposta RPC/plugin localiza o pedido nativo indicado por `expected.target`, confere também seu tipo/revisão e não escolhe o primeiro pedido que estiver pendente. Manter os IDs nativos exatos, inclusive número zero.

No caminho por teclado, a memória do Monitor não basta: sob a serialização do executor, capturar o pane atual e confrontar pergunta/menu, opções e evidência nativa/sidecar de `expected` antes do primeiro efeito. A captura deve ser posterior à aquisição da operação, não uma foto do poll anterior. B já visível enquanto o Monitor ainda guarda A deve recusar A sem tecla. Cursor e marcações da mesma pergunta não alteram a identidade, mas a posição a confirmar é relida. Se o protocolo não oferece sinal para distinguir substituição byte-idêntica de diálogo, declarar esse limite; não prometer uma exclusão impossível sobre a TUI humana. Vínculo/geração/fonte ambíguos recusam, não autorizam pelo texto parecido.

“Conversar sobre isso” passa a ser um único controle `answer_chat`: forma o texto a partir do retrato A, confere A, fecha A, espera sua saída e só envia se o pane estiver em condição comprovada de entrada e nenhuma B tiver surgido. Não manter o `interrupt({})` seguido de `Input` com IDs independentes nem enviar texto apesar do timeout do rodapé. Falha depois de possível efeito retorna resultado incerto, conservando a correlação da operação.

Retirar a exclusão incondicional do sidecar em `answer.rs::terminal`. A conclusão de A registra consumo da revisão de fonte capturada em A no recibo/estado da pergunta; leitores ignoram somente essa revisão consumida, sem apagar o caminho que pode já conter B. Revalidar revisão ao ler/publicar; não substituir isso por `read` seguido de `remove_file`, que mantém a corrida. Quando o hook encerrar/remover sua própria pergunta, o estado correspondente é descartado. Provar B surgindo durante o fechamento ou a conclusão de A e verificar que arquivo, formulário e opções de B permanecem.

Preservar guardas/recibos Rust já integrados. Ligar sua revisão nativa/sidecar real na Task 6 usando fonte local, sem leitor ou epochs Python novos. As regressões Rust precisam cobrir B antes do próximo poll, B durante o retorno de A e formulário/aprovação simultâneos. A Task 12 conserva o corpo e `interaction_id` na passagem autorizada Python → Rust. Código não migrado continua funcionando no Python; responsabilidade já migrada permanece no Rust e devolve erro enquanto ele se recupera, sem executar sua implementação Python antiga como reserva.

- [ ] **Step 3: Delimitar os provedores e as entradas fora da conversa adotada**

Aplicar obrigatoriedade aos caminhos Claude/Codex migrados. Pi/omp/Kimi e menus anteriores à existência de thread Codex continuam seu contrato anterior de abertura Python, sem Store/identidade Python novos e sem fabricar thread para atender uma seleção. A admissão ao runtime separa explicitamente essa abertura da conversa adotada.

Convidado/Connect autorizam primeiro e encaminham corpo/ID intactos ao Rust. Não completar campo ausente buscando o pedido novo, normalizar após ingresso ou responder no Python quando o dono Rust estiver doente. Adaptar as provas existentes para obter o ID do retrato que exibem, nunca forjar o ID mais recente imediatamente antes do POST.

Cadastrar os erros da Task 1 em ambos os idiomas e reutilizar `erro_sem_confirmacao_resposta` para resposta possivelmente escrita sem confirmação. Não converter `Unknown` em sucesso nem em “não enviado”.

- [ ] **Step 4: Reservar o lote de regressões das rotas**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it session_write_control
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it session_write_answer
```

Pronta quando todos os ingressos conservam o ID recebido e o dono recusa a troca de pergunta entre admissão e efeito. A ativação pública conjunta é feita na Task 12.

### Task 5: Plugin Claude com memória, autenticação e confirmações no Rust

**Arquivos:**
- Criar: `crates/hangar-server/src/plugin/mod.rs`, `store.rs`, `routes.rs`.
- Alterar: `crates/hangar-server/src/mods/bridge.rs`, `routes.rs`, `lib.rs`, `runtime/gateway.rs` para ligação do serviço.
- Referência de port: `backend/app/plugin_bridge.py`, incluindo `publish_terminal`, `whoami`, `pull`, `ask`, `ask_fim`, `pergunta_pendente`, `responder_pergunta`, `filled`, `submitted`, `state`, `rate` e `plugin_facts`.
- Testar: testes internos de `plugin/store.rs`, `crates/hangar-server/tests/it/plugin_loopback.rs`; preservar as regressões existentes de `backend/tests/test_plugin_bridge.py` como referência de comportamento, sem manter chamador Python ativo para o plugin já migrado.

**Interfaces integradas a preservar:**
- `plugin::Store`, compartilhado pelo mesmo `Arc` entre AppState, runtime e fontes de estado; não reimplementar a Task 5.
- `PluginQuestion` conserva `id`, `interaction_id`, `questions`, `tool`, `summary` e o campo externo `resumo` por `serde(rename)`.
- Consumir os métodos efetivos de pendência/fatos/publicação/interrupção/limpeza do Store integrado, sem substituir suas assinaturas por uma proposta antiga. A Task 6 congela a ligação às fontes antes dos consumidores.
- `Store::answer` conserva o corpo completo `{permitir}`/`{answers}`/`{deny}` no topo e acrescenta recibo; manter `NotWritten`/`Unknown` e não usar tecla para `perm:`.
- Rotas conservam corpos externos, tokens e autenticação já integrados, sem exigir instalação simultânea de plugin novo para preservarem `/ask-fim` e recibos.

- [ ] **Step 1: Portar as regressões do contrato, não apenas o caso feliz**

Criar uma função interna pura de validade e testá-la com relógio explícito:

```rust
fn question_visible(interrupted: bool, poll_open: bool, age: Duration) -> bool {
    !interrupted && age <= Duration::from_secs(35) && (poll_open || age <= Duration::from_secs(5))
}

#[test]
fn conversation_held_question_expires_without_poll_and_on_interrupt() {
    assert!(question_visible(false, true, Duration::from_secs(25)));
    assert!(!question_visible(false, false, Duration::from_secs(6)));
    assert!(!question_visible(true, true, Duration::ZERO));
    assert!(!question_visible(false, true, Duration::from_secs(36)));
}
```

Usar também os casos atuais de `test_plugin_bridge.py`: terminal preso, app ausente, modo que não pergunta, instância antiga de `pull` terminando depois da nova, `pull` de outra conversa, confirmação dupla, desconexão do proxy e estado que não pode ser rebaixado por `pull` antigo.

- [ ] **Step 2: Implementar a memória por sessão e as esperas canceláveis**

Portar pergunta, publicação e recibo usando canais Tokio/Notify e relógio monotônico, sem thread bloqueada em `Event.wait` nem um poll por sessão. Identidade do waiter impede que o `finally` do poll antigo remova o novo. Uma segunda resposta ao mesmo pedido espera o mesmo resultado; não publica outro efeito.

A resposta ao plugin conserva os nomes existentes:

```json
{"publication_id":"publication-1","generation":2,"session_id":"sid","answers":{"Escolha":"A"}}
```

Só `ask-fim` com recibo correspondente e vencedor aplicável confirma a entrega; resposta guardada sem poll vence pelos prazos atuais. `perm:` não usa fallback de tecla quando a publicação falha. Ao interromper, invalidar a pergunta na memória e na interação pública antes de publicar o próximo estado.

`publish_terminal` conserva `NotWritten`/`Filled`/`Accepted`/`Unknown`, inclusive publicação cujo poll caiu antes de receber. Não permitir que o próprio cancelamento HTTP perca o rastreamento de algo já entregue.

- [ ] **Step 3: Reutilizar autenticação e resolver identidade sem confiar só no nome**

Compartilhar o menor trecho de admissão de `mods/bridge.rs`; não duplicar HMAC/comparação. Preservar `mint`, `mint_keyed` e derivação de `machine_key` sobre `plugin:machine`. `/whoami` continua exigindo loopback e chave de máquina; bearer do dono ou token de convidado não equivalem ao token do plugin.

Resolver pane/socket/psmux e conversa com os fatos de identidade já disponíveis na lista/runtime. Preservar o interruptor existente do plugin. Falha de identidade não é autorização por nome. Limites e campos vêm dos modelos atuais do Python, não do limite genérico de outra rota de mods.

Mapear os nove sufixos públicos sob `/api/plugin`; `ui`/toast/foco que já estão no Rust usam a mesma sessão. A cópia eventualmente necessária a leitores legados é projeção, não outra instância que decide perguntas.

- [ ] **Step 4: Ligar o serviço em memória sem ativar uma metade incompleta**

Acrescentar `AppState.plugin` e passar o mesmo `Arc<Store>` ao registry e às fontes. Reaproveitar a associação chave/vida do runtime. Falha de ligação deve ser explícita, não uma implementação vazia em produção.

Reservar:

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --lib conversation_held
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it plugin_loopback
(cd backend && uv run pytest tests/test_plugin_bridge.py tests/test_internal_plugin_bridge.py)
```

O roteamento público e o desligamento da memória Python só entram com a Task 12 e consumidores da Task 6 prontos.

### Task 6: Fatos locais, publicação e drenagem Claude sem ida e volta Python

**Arquivos:**
- Alterar: `crates/hangar-server/src/runtime/terminal.rs`, `runtime/gateway.rs`, `terminal_input.rs`, `state/live.rs`, `state/facts.rs`, `state/monitor.rs`, `state/runtime_feed.rs`, `list/bridge.rs`, `list/classify.rs`, `list/sig.rs`, `list/reply.rs` e fontes de `plugin/`.
- Python: retirar o caminho ativo de produtores migrados em `state_facts.py`, `list_facts.py`, `runtime_policy.py`, `runtime_terminal.py`, `internal_api.py`, `sse.py` e `state.py`. Seus corpos podem ficar como referência, não como reserva; preservar funcionalidades/provedores ainda não migrados. Não aplicar acréscimos vetados das antigas subpartes 6a/6b.
- Escrever/conservar sem executar: `crates/hangar-server/tests/it/terminal_runtime.rs`, `terminal_routes.rs`, `state_monitor_round.rs`, `contract_terminal.rs`, `contract_list/` e regressões da fonte nativa.

**Ligação sobre símbolos existentes:**
- Conservar `TerminalServices::{facts, publish, writing}` e `InputFacts`; portar a implementação de `runtime/terminal.rs::Services` diretamente para fontes Rust/Store, não o protocolo do escritor inteiro.
- Ligar fontes do plugin, `LiveSources`, `RuntimeFeed` e lista ao mesmo `plugin::Store`/`RuntimeRegistry`. Remover fatos de plugin ativos vindos do Python.
- `RuntimeRegistry::writable(name)`/handle existente conduz `drain()`; nenhuma chamada `session.deliverable -> Python -> Rust` nem produtor por conexão SSE.
- Estender o descritor `TerminalTarget` com os dados hoje existentes no vínculo: `config_dir`, `agent_pid`, `agent_birth`, `created`, `legacy_import_after`, `fingerprint` e endpoint do remetente. Preservar `plugin_key`, `TerminalBinding`, `mux_argv`, `windows`, `clipboard_lock_path` e origem `uds:<INBOX.path>`/`uds:hangar-<pid>` quando aplicável; não presumir UDS no Windows nem inferir identidade pelo nome.
- A Task 6 congela as assinaturas efetivas de construção/leitura e ligação de Store/Registry antes de liberar 7/10/12; não antecipar `LocalTerminalFacts` ou outra fachada ainda inexistente. Projeções incluem o mesmo `interaction_id` autoritativo, inclusive lista sem chat aberto.

- [ ] **Step 1: Escrever prova de ausência das chamadas antigas**

Nos fakes HTTP existentes, recusar e contar chamadas de `terminal_facts`, `terminal_publish`, `terminal_plugin_control`, `session.deliverable`, `permission.observe` e fatos ativos de plugin Python. O envio/pergunta/estado migrados devem funcionar com todas essas chamadas recusadas, usando somente fontes Rust; o diário e a revisão nativa continuam obrigatórios.

```rust
let blocked_policies = [
    "terminal_facts", "terminal_publish", "terminal_plugin_control", "session.deliverable", "permission.observe",
];
assert!(blocked_policies.iter().all(|kind| !observed_policy_kinds.contains(&kind.to_string())));
```

`observed_policy_kinds` é a coleção de chamadas capturadas no fake da prova, não uma nova lista de produção. Incluir um envio comum e uma pergunta segurada; olhar só `/input` sem entregar não serve.

- [ ] **Step 2: Substituir a implementação dos fatos e da publicação**

Trocar o corpo de `Services::facts` que chama `PolicyClient.run_for` por leitura Rust de vínculo, captura canônica, estado nativo/hook, pergunta, capacidades do plugin e disponibilidade do transporte. Preservar a ordem atual de preferência das fontes de `runtime_terminal.facts`.

Implementar essa leitura no `Services` existente, reutilizando captura canônica, arquivos/registro nativo e Store/Registry já ligados. Modo do remetente/alvo usa vínculos/metadados e leitura publicada validada de `RuntimeRegistry::live`/`Published`, sem consultar a própria caixa de comandos do ator nem criar espera circular entre atores. A unidade congela o formato efetivo do leitor antes de seus consumidores.

A publicação chama o `plugin::Store` integrado; o controle de pergunta usa a mesma memória Rust depois de validar `interaction_id` e ID nativo. Preservar `Services::writing` e `Action::MarkWriting` antes do primeiro efeito: retirar HTTP não retira o diário.

Não desabilitar socket nativo ou clipboard para simplificar. Portar o caminho efetivo de `runtime_terminal.facts`: `_native_record` lê o registro pelo `agent_pid` e confere `pid` e `sessionId`; `_native_socket` lê `messagingSocketPath` desse registro; `_native_state` usa o mesmo registro validado. Preservar também `_plugin_current` e as verificações Windows. `uds_messaging.socket_da_sessao` existe, mas não substitui esse caminho mais estrito do executor. Integração de recados fora do recorte pode continuar fornecendo o endereço de sua caixa de retorno como fato de vínculo; não pedir a ela para decidir cada entrega nem criar nova caixa por mensagem.

- [ ] **Step 3: Unificar consumidores de estado e de interação**

As `Sources` do plugin, `LiveSources::facts`, `RuntimeFeed` e lista leem diretamente o mesmo Store/RuntimeRegistry. Remover fatos ativos Python de pergunta, sugestão, permissão e ciclo de vida migrados; fatos de recursos fora do recorte permanecem delimitados, sem migrá-los por vizinhança. A parte da lista sem Monitor usa o mesmo registro de interação, não gera token independente.

`LiveSources::deliverable` chama o handle Rust pela entrada existente de `RuntimeRegistry`; não usa coordenador Python para adotar, decidir ou drenar. Retirar o circuito `session.deliverable -> Python -> Rust`, `permission.observe` e leitura de plugin Python. Vínculo ausente ou fonte indisponível é erro visível, nunca sucesso vazio ou Python assumindo.

Preservar `question`, `ask_question`, contagem de pendências e cada `interaction_id` na publicação Rust e na projeção já existente para os leitores das portas Python. Remover duplicação no `side-events`/SSE sem acrescentar nova ponte. Em `backend/app/state.py`, os corpos antigos de `observar_ou_confirmado` e `plugin_bridge.pergunta_pendente` podem ficar como referência, mas não são executados para perguntas/permissões já migradas, inclusive durante queda do Rust. Preservar produtores Python de outros provedores/responsabilidades ainda não migrados; não desligar Guest/Connect. A revisão nativa exigida pelas guardas 4 vem do registro/arquivo/protocolo Rust real, nunca do token esperado nem de epochs Python.

- [ ] **Step 4: Reservar as regressões de estado e entrega**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it terminal_runtime
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it state_monitor_round
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it contract_terminal
```

Casos adicionais: só lista aberta, só convidado aberto, sair do app durante permissão segurada, captura ilegível, clipboard indisponível e interrupção sem `ask-fim`. Nenhum deles pode criar pergunta vazia por erro nem bloquear para sempre a fila.

### Task 7: Modos Claude no Rust e reabertura restrita para bypass

**Arquivos:**
- Criar: `crates/hangar-server/src/permission_control.rs`, `session_write/permissions.rs`.
- Alterar: `state/permission.rs`, `state/live.rs`, `state/monitor.rs`, `runtime/protocol.rs`, `runtime/terminal.rs`, `runtime/gateway.rs`, `session_write/mod.rs`, `terminal_input.rs` (todos sob `crates/hangar-server/src/`).
- Python: retirar o caminho ativo das responsabilidades migradas em `api.py`, `permission_mode.py`, `runtime_policy.py`, `internal_api.py`, `runtime_coordinator.py`; corpos antigos podem ficar como referência, sem reserva. Preservar responsabilidades não migradas e suas portas, sem nova ponte de ciclo de vida.
- Referência de comportamento: `backend/tests/test_permission_mode.py`, `test_runtime_lifecycle.py`. Escrever/conservar sem executar regressões Rust internas de `state/permission.rs` e do controlador, `tests/it/terminal_control.rs` e testes do gateway/lifecycle afetados.

**Ligação sobre símbolos existentes:**
- `PermissionMemory`/`PermissionView` já integradas em `state/permission.rs` são preservadas. `begin` recusa ausência de retrato; somente depois de `begin` válido chamar `finish`. Não implementar segunda memória.
- Implementar controlador de leitura/sondagem/troca usando `TerminalDriver`, `TerminalHandle::control`, executor serial e `RuntimeRegistry` atuais. A Task 7 congela assinatura de comando/resultado antes da Task 11; não antecipar uma fachada que ainda não existe.
- Admitir BTab somente dentro da operação serial de permissão. `mods_keys` conserva sua allowlist atual, sem BTab.
- Reutilizar `SetPermissionMode` e o motor sem terminal; definir a ligação de leitura no protocolo existente dentro desta unidade.
- Substituir a execução Python `permission-reopen` por ciclo de vida Rust no gateway/runtime existente. Geração, admissão, fechamento e reabertura compõem o contrato comum com a Task 10, congelado antes de 11/12. Não criar rota/ponte Python para executar bypass, persistir sidecar ou devolver posse.

- [ ] **Step 1: Portar regressões da memória e da sondagem**

```rust
#[test]
fn conversation_permission_probe_does_not_publish_intermediate_mode() {
    let mut memory = PermissionMemory::default();
    memory.observe("key", "bypassPermissions");
    memory.begin("key");
    assert_eq!(memory.observe("key", "manual").current, "bypassPermissions");
    let final_view = memory.finish("key", "plan");
    assert_eq!(final_view.current, "plan");
    assert_eq!(final_view.previous_non_plan, "bypassPermissions");
}
```

Portar também os casos já testados no Python: `dontAsk` não envia tecla; sonda que não restaura devolve modo efetivo; primeira leitura em 20 ms sem pausa fixa; intervalo aumenta até 200 ms; operação concorrente não publica modos intermediários.

- [ ] **Step 2: Implementar leitura/troca no executor serial existente**

Reutilizar `state::permission::parse_permission_mode`. O comando de troca/sonda ocupa o executor durante toda a operação; chamada a `TerminalDriver::key` isolada não basta para serializar a sequência inteira. `PermissionMemory` conserva o retrato confirmado até terminar e acorda o Monitor por evento.

Em `terminal_input.rs`, reutilizar `pane_effect` e `TerminalBinding` para enviar BTab somente no controle admitido; conservar `mux_argv`/psmux/Windows. A operação serial mantém a sequência inteira: ler modo, comparar com o pedido, enviar no máximo seis teclas e aguardar até dois segundos por mudança após cada tecla. A Task 7 congela a assinatura efetiva desse controle antes dos consumidores, sem ampliar a API geral de mods.

Conferir que `mods_keys(&["BTab"])` continua recusado e que somente a operação de permissão admite BTab. Não ampliar a API de teclas de mods para contornar sua allowlist.

Usar os intervalos/prazos globais para espera e conversão dos erros no controlador. Sem leitura confiável, falha, não modo presumido. Sondagem tenta restaurar e informa `restaurado:false` quando não conseguiu; restauração conserva seu prazo próprio.

Rotas reutilizam admissão, barreira de transferência e guarda do painel. Não aplicar guarda de sessão trabalhando ao BTab quando a CLI permite a troca. Remover `permission.observe` do caminho migrado; sua implementação Python anterior pode ficar como referência, sem execução para permissões já Rust, inclusive durante queda. As responsabilidades não migradas continuam no Python.

- [ ] **Step 3: Executar reabertura e ciclo de vida no Rust**

Se bypass não é alcançável na vida atual, registrar intenção no Rust com `operation_id`; o gateway/runtime valida chave, geração e condições de reabertura atomicamente na barreira antes de encerrar. Não manter uma escrita admitida esperando um fechamento que depende dela. Entrada ocupada entre intenção e fechamento recusa antes de parar processo. Reutilizar registro, barreiras, diário e primitives de processo existentes; não chamar `RuntimeCoordinator.change`, `permission-reopen` ou persistência Python.

A subunidade 7l é responsável pela receita local de reabertura: reutilizar `process::LaunchSpec`, `ProcessView` e os leitores de processo atuais, sem acrescentar LaunchSpec/fato de lançamento no Python. Capturar argv/executável/cwd/ambiente do processo Claude vivo e ocioso, validando pid/nascimento/chave/conversa antes e depois. Ambiente fica somente em memória; vazio/ilegível ou receita capturada após morte não é prova equivalente. Preservar bytes/OsString, engine/escolhas reais, envelope bwrap/read_only e settings temporários; copiar settings privados antes de matar o pai Windows. Reutilizar quoting/destinos tmux/psmux e `sysinfo` instalado para a leitura Windows. Falta de receita comprovada recusa antes de matar, mas não substitui a entrega de reabertura funcional. Não usar cano headless como TUI falsa nem preparar/login de conta novamente.

O Rust encerra a vida antiga somente após validar essa receita, invalida Store/interações/recibos aplicáveis, executa a reabertura necessária para bypass preservando conversa/fila/escolhas, atualiza conversa/sidecar e geração e só admite/publica a vida nova após vínculo confirmado. A rota só confirma quando o runtime novo informa o modo pedido. Falha fica visível no diário; não devolve posse nem ativa escritor Python.

Portar também detecção de pane morto, fechamento explícito terminal/sidecar, limpeza e `/clear`/troca de conversa para o mesmo ciclo de vida Rust. Preservar guardas contra reutilização de pane/nome e consumo específico de revisão; limpar A não remove B. Encerrar controle/backend não mata TUI/app-server adotados; fechamento explícito tem a limpeza apropriada. A abertura inicial continua no Python, não é usada como atalho para lifecycle migrado.

Escrever provas Rust de cancelamento HTTP, clique repetido, input concorrente, falha do relançamento, pane morto, fechamento/clear e geração nova, sem executar. `operation_id` evita duas reaberturas; a assinatura comum de geração/admissão/fechamento é congelada com a Task 10 antes dos consumidores.

- [ ] **Step 4: Reservar os checks e a prova de permissão real**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --lib permission
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it terminal_control
```

Uso real: manual/auto/plano, sondagem, painel aberto e bypass que exige reabertura, sempre em sessão descartável autorizada. Aguardar modo confirmado e conferir a memória anterior ao plano.

### Task 8: WebSocket bruto com IDs preservados e ACK de escrita real

**Arquivos:**
- Alterar: `crates/hangar-codex/src/client.rs`, `crates/hangar-codex/tests/client.rs`.
- Criar: `crates/hangar-server/src/runtime/websocket.rs`.
- Alterar: `crates/hangar-server/src/runtime/mod.rs`, `runtime/cano.rs`, `runtime/actor.rs` na ligação de transporte.
- Testar: testes existentes de cliente e testes internos de `runtime/websocket.rs`.

**Interfaces novas em `hangar-codex::client`:**

```rust
pub struct RawWrite {
    pub text: String,
    pub receipt: tokio::sync::oneshot::Sender<Result<(), ClientError>>,
}
pub struct RawWebSocket {
    pub incoming: tokio::sync::mpsc::Receiver<String>,
    pub outgoing: tokio::sync::mpsc::Sender<RawWrite>,
}
pub async fn connect_raw_ws(url: &str) -> Result<RawWebSocket, ClientError>;
```

`connect_ws` existente reutiliza o mesmo transporte bruto, preservando sua API. O ator recebe frames sem o cliente gerar outro ID ou consumir respostas RPC no lugar do motor. O adaptador Rust associa `receipt` a `WireFrame.operation_id` e produz os `IoEvent` existentes.

- [ ] **Step 1: Escrever prova de enqueue versus escrita**

No fake WebSocket existente de `crates/hangar-codex/tests/client.rs`, receber exatamente um frame com ID fornecido pelo motor e confirmar somente depois do `send` no socket. Incluir fechamento antes de enfileirar, depois de enfileirar e durante a escrita.

Mapeamento obrigatório no adaptador, testado separadamente:

```rust
fn queued_write_outcome(
    queued: bool,
    receipt: Option<Result<(), hangar_codex::client::ClientError>>,
) -> WriteOutcome {
    if !queued { return WriteOutcome::NotWritten; }
    match receipt {
        Some(Ok(())) => WriteOutcome::Written,
        Some(Err(_)) | None => WriteOutcome::Unknown,
    }
}

#[test]
fn conversation_enqueue_is_not_a_write_receipt() {
    assert_eq!(queued_write_outcome(false, None), WriteOutcome::NotWritten);
    assert_eq!(queued_write_outcome(true, None), WriteOutcome::Unknown);
    assert_eq!(queued_write_outcome(true, Some(Ok(()))), WriteOutcome::Written);
}
```

Não concluir `NotWritten` só porque o socket devolveu erro depois de receber o frame: parte da escrita pode ter saído.

- [ ] **Step 2: Extrair o transporte comum e manter uma conexão**

Reutilizar limites de frame, tratamento de UTF-8, fechamento e filas do cliente existente. O recibo é concluído pelo writer após `sink.send`; consumidor não espera resposta dentro do laço que drena notificações.

```rust
let result = sink.send(tokio_tungstenite::tungstenite::Message::text(write.text)).await;
let _ = write.receipt.send(result.map_err(|error| ClientError::Io(error.to_string())));
```

O bloco fica no writer de transporte, não no enqueue da API. Preservar a política atual de diagnóstico sem conteúdo/segredos; a mensagem bruta de erro não vai ao diário público. Queda fecha leitores e recibos pendentes. Soltar transporte fecha conexão, nunca mata o app-server adotado.

- [ ] **Step 3: Adaptar a entrada do ator sem abstração de processos nova**

Permitir que o ator receba os mesmos canais/eventos de cano ou WebSocket por uma representação finita de transporte, por exemplo enum interna `RuntimeConnection::{Cano, WebSocket}`. Manter a política de spawn/kill só no caso que realmente possui o processo. Não fabricar `CanoBinding` nem inicializar o cliente tipado em paralelo para receber respostas.

O frame `hangar:<geração>:...` chega intacto ao provedor e a resposta intacta ao motor. `operation_id` permanece associado à confirmação de escrita; ACK de outra geração não conclui operação atual.

- [ ] **Step 4: Reservar os testes de transporte**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-codex --test client
cargo test --manifest-path crates/Cargo.toml -p hangar-server --lib conversation_enqueue
```

Resultado esperado: uma conexão, IDs intactos, falhas classificadas conservadoramente e nenhum encerramento de processo pela simples desconexão.

### Task 9: Motor Codex terminal, primeiro envio e resultado de aprovação honesto

**Arquivos:**
- Alterar: `crates/hangar-server/src/runtime/codex.rs`, `protocol.rs`, `actor.rs`, `queue.rs`, `receipt.rs`; `session_write/codex.rs`, `control.rs`, `answer.rs`.
- Testar: `crates/hangar-server/tests/it/runtime_codex.rs`, `runtime_queue.rs`, `runtime_receipt.rs`, `session_write_control.rs`, `session_write_answer.rs`.
- Referência: `backend/app/adapters/codex/adapter.py::_subscribe_when_ready`, `answer_questions`, `appserver.py::respond`; schema Codex versionado no repo.

**Interfaces:**
- `Engine::new`, `bootstrap`, `command`, `apply`, `view` conservam as assinaturas atuais.
- Acrescentar estado terminal explícito `connected`/`subscribed`; `headless:false` não implica `ready:false` para sempre nem troca o processo por stdio.
- `RuntimeReply.payload` de resposta terminal conserva `write_outcome` e informa `decision_confirmed:false` quando a resolução não prova autoria. O estado remove cartão resolvido sem inventar quem aprovou.
- Resposta por HTTP sem confirmação usa o erro de resultado incerto, não `ok:true` genérico do headless.
- Novo `ReservedAsyncAnswer { request_id: String, interaction_id: String, entry_id: String, operation_id: String, text: String }`, vinculado à chave/thread/geração da operação persistida na fila. Não criar arquivo de reservas separado.
- Novo `Engine::ready_async_answer_entry(&self) -> Option<String>` escolhe somente uma entrada reservada apta, sem tornar `deliverable()` verdadeiro para mensagens comuns.
- Novo `OperationKind::DispatchAsyncAnswer`, aceito apenas pelo ator para entrada proveniente da fila cuja reserva corresponda; não é rota pública nem comando aceito de chamador avulso. A reserva/enqueue é uma atualização atômica do `QueueActor`, e sua recuperação deriva da mesma operação persistida.

- [ ] **Step 1: Escrever regressões contra o motor existente**

Em `tests/it/runtime_codex.rs`, reutilizar `clock`, `frames`, `line` e `command` existentes:

```rust
#[test]
fn conversation_terminal_writes_before_subscription_without_overriding_permissions() {
    let mut engine = Engine::new(serde_json::json!({
        "name":"session", "thread_id":"thread-1", "headless":false,
        "initialized":true, "connected":true, "subscribed":false
    }), 1, clock(10.0));
    let effects = engine.command(command(OperationKind::Input, serde_json::json!({"text":"Olá"})), clock(11.0)).unwrap();
    let writes = frames(&effects);
    let start = writes.iter().find(|frame| frame["method"] == "turn/start").unwrap();
    assert_eq!(start["params"]["threadId"], "thread-1");
    assert!(start["params"].get("approvalPolicy").is_none());
    assert!(!writes.iter().any(|frame| frame["method"] == "thread/start"));
}
```

Adicionar conversa identificada sem rollout no cursor/recibo; `no rollout found for thread id` retentável, thread inválida não retentável. Falha real de assinatura não pode virar `idle` sem problema.

- [ ] **Step 2: Separar prontidão de envio e assinatura**

Terminal inicializa/conecta à thread existente e pode enviar seu primeiro turno mesmo antes de assinar eventos. Reaproveitar a espera crescente limitada atual; somente ausência do rollout nessa fase tem a política especial. O primeiro envio não chama `thread/start` nem passa parâmetros de aprovação/sandbox extraídos da tabela headless.

`capture_cursor`/`ReceiptIndex` precisam distinguir rollout inexistente de caminho inválido. O cursor anterior ao primeiro arquivo representa ausência comprovada; quando o rollout surgir, confirmar pelo conteúdo. Não abrir um arquivo de caminho vazio, nem aceitar o enqueue como prova de entrada no transcript.

`thread/started` de outra thread adotada pela TUI muda o vínculo e invalida perguntas/recibos antigos. Filtrar notificações não autoriza descartar pedido RPC de subagente.

- [ ] **Step 3: Definir a política de pedidos e resolução terminal**

| Pedido | Política no terminal |
| --- | --- |
| `item/tool/requestUserInput` | Pergunta nativa, ID exibido conferido antes da resposta |
| Aprovação de comando/arquivo/permissões | Reutilizar interpretação e opções do motor; se só a TUI oferece o controle, usar o executor terminal conferido |
| Elicitação MCP reconhecida | Preservar alternativas existentes, sem inventar campo ou resposta |
| Pedido que a TUI atende e Hangar não interpreta | Não aplicar a recusa automática do headless; manter para TUI e registrar informação necessária sem segredos |
| `serverRequest/resolved` | Encerrar a pendência indicada, sem atribuir vencedor/decisão |
| Fim de turno/vida/thread | Invalidar as pendências correspondentes; nenhuma resposta tardia é transplantada |

No ramo terminal, `Written` conserva a resposta em curso até a resolução, e não a transforma em decisão aplicada. O retorno ao app pode ser incerto; não reencaminhar automaticamente. Repetição é recusada/espera a mesma operação, nunca cria outro frame.

```rust
let disposition = match (outcome, self.headless) {
    (WriteOutcome::NotWritten, _) => Disposition::Rejected,
    (WriteOutcome::Unknown, _) => Disposition::Unknown,
    (WriteOutcome::Written, false) => Disposition::Unknown,
    (WriteOutcome::Written, true) => Disposition::Accepted,
};
```

Aplicar esse núcleo somente ao retorno de resposta a pedido do servidor, não a todo comando Codex. Provar duas ordens: app escreve e TUI resolve; TUI resolve antes do ACK do app. Nos dois casos, sem prova adicional não há “permitido por você”.

Pergunta assíncrona que vira mensagem entra na mesma fila/serialização, mas não como `Input` indistinguível. `deliverable()` hoje é falso enquanto a própria pergunta está pendente; esperar essa condição sem tratamento específico cria uma espera circular.

Ao aceitar a resposta, validar o alvo exato e gravar atomicamente uma entrada reservada ligada à pergunta e ao texto já formado, sem retirar a pergunta ainda. Resposta repetida encontra a mesma reserva/entrada; não abre outra. `ready_async_answer_entry()` permite reivindicar somente essa entrada por `Action::Claim { min_ts: target.created, limit: Some(1), entry_id: Some(id) }` quando conexão/identidade estão prontas, não há turno ou RPC bloqueante em curso e a reserva continua válida.

Outras perguntas assíncronas sem resposta não bloqueiam a resposta reservada de uma delas; mensagens comuns continuam bloqueadas por perguntas pendentes. Aprovações/perguntas RPC bloqueantes e turno ativo continuam impedindo o despacho. Escolher uma reserva por vez pela ordem da fila. A condição especial não pode liberar a primeira mensagem comum nem dispensar controles de posse.

O ator transforma somente a entrada reservada reivindicada em `DispatchAsyncAnswer`; o motor confere sua reserva e produz `turn/start`. Pergunta e reserva só concluem quando o resultado do protocolo/recibo comprova a entrada correspondente. `NotWritten` pode devolver a mesma entrada para tentativa após revalidar o pedido; `Unknown` conserva resultado incerto e não é reenviado. Retomada recupera vínculo e estado da reserva pela fila; ausência de prova de escrita ou de pendência atual não autoriza novo turno.

Provar a sequência inteira até a confirmação: uma pergunta com resposta reservada e input comum anterior, duas perguntas assíncronas simultâneas, aprovação RPC bloqueando a reserva, fechamento antes do envio e queda depois da possível escrita. Conferir que só o pedido respondido sai das pendências. Não basta verificar que a resposta foi enfileirada.

- [ ] **Step 4: Reservar os testes de protocolo, recibo e resposta**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it runtime_codex
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it runtime_receipt
```

A prova inclui `WriteOutcome` desconhecido após desconexão, resolução de outra thread, múltiplos pedidos pendentes, callbacks tardios e manutenção do comportamento headless já existente.

### Task 10: Adotar Codex terminal e transferir conexão, projeções e leitores

**Arquivos:**
- Retrabalhar: `crates/hangar-server/src/runtime/codex_terminal.rs` existente.
- Alterar: `runtime/gateway.rs`, `runtime/protocol.rs`, `runtime/actor.rs`, `side.rs`, `state/runtime_feed.rs`, `list/classify.rs`, `list/bridge.rs`.
- Python: remover/condicionar cliente e produtores antigos em `runtime_adapter.py`, `runtime_coordinator.py`, `adapters/codex/adapter.py`, `adapters/codex/appserver.py`, `adapters/codex/sessions.py`, `sse.py`, `list_facts.py`; conservar abertura inicial e código não migrado em funcionamento. Não conservar cliente Python Codex como reserva das sessões adotadas pelo Rust; seus corpos antigos podem ficar somente como referência. Somente repasse mínimo Q1/B pode crescer, com saldo por arquivo; limpeza externa DELETE/A não executa lifecycle.
- Escrever/conservar sem executar: `crates/hangar-server/tests/it/runtime_gateway.rs`, `runtime_open.rs`, `runtime_recovery.rs` e regressões de adoção/fechamento/sidecar Rust. Testes Python anteriores permanecem para comportamento fora do corte, sem acrescentar identidade/guarda/reserva novos.

**Responsável:** `permissions-codex` já refaz esta unidade em Rust. Preservar transporte 8 e preparação 9; integração recebe somente o delta de contratos compartilhados, sem outra revisão inteira de 9–11.

**Descritor Rust existente a preservar/refinar nesta unidade:**

```rust
pub struct CodexTerminalTarget {
    pub key: String,
    pub generation: u64,
    pub name: String,
    pub endpoint: String,
    pub app_pid: u32,
    pub thread_id: String,
    pub terminal: crate::terminal_input::TerminalBinding,
    pub metadata: serde_json::Value,
    pub transcript: Option<std::path::PathBuf>,
    pub lease_path: std::path::PathBuf,
    pub state_path: std::path::PathBuf,
    pub projection_dir: std::path::PathBuf,
}
```

- Reutilizar `RuntimeRegistry::open_codex_terminal`, `CodexTerminalTarget`, `Target`, ator/feed e validação atuais; endpoint/pid/thread não são um cano falso.
- Descoberta/adoção, nova geração, admissão e fechamento são Rust. A Task 10 congela a assinatura efetiva em conjunto com o lifecycle da Task 7 antes dos consumidores 11/12; não criar coordenador, passagem de dono ou vigia Python.
- Q1/B: escritas das portas Python chegam em um sentido, com corpo/identidade/código conservados. DELETE/registry.kill de Codex terminal chama o fechamento Rust em vez de cliente Python. DELETE/A do dono encerra no Rust e só depois repassa ao Python a limpeza externa existente, sem retorno ao Rust.
- O relançamento Codex já foi decidido como Rust: retirar a ligação `hand-over` e portar o efeito de `open_headless`/`open_terminal` da sessão existente para o dono Rust. `publish_imported` cria um Codex novo a partir de Claude e permanece na abertura inicial Python; não ampliar o port para toda a transferência. Validar vida, fila, conversa, conta e modo efetivo antes de parar; modo desconhecido recusa sem liberar a sessão e nunca vira Full Access. Reutilizar a receita, o lançamento privado e a operação de geração da unidade 7, sem outro escritor de processo ou diário.

- [ ] **Step 1: Prender admissão e ciclo de vida Rust nos testes existentes**

Adicionar descritor válido com rollout ausente, endpoint não local, pid diferente, thread vazia, chave trocada e tentativa `launch:true` no ramo terminal. A validação local não resolve um hostname fornecido para alcançar máquina remota; aceitar somente o endereço local e porta do app-server comprovado.

```json
{
  "provider":"codex",
  "headless":false,
  "meta":{
    "key":"codex-key",
    "thread_id":"thread-1",
    "endpoint":"ws://127.0.0.1:43210",
    "app_pid":12345,
    "terminal":{"name":"cx-proof","pane":"%7","conversation":"thread-1","generation":1,"created":1,"mux_argv":["tmux"],"windows":false,"clipboard_lock_path":null}
  }
}
```

Esse é o trecho específico de `meta` a inserir no descritor completo das fixtures existentes; não substituir os caminhos de estado/fila/chave da fixture. Nenhum teste usa app-server vivo da pessoa.

- [ ] **Step 2: Transferir o cliente, não o processo**

Retirar/condicionar subscriber, watcher, bomba e cliente Python do caminho ativo; não adicionar `LegacyBridge.quiesce`, watcher ou passagem de dono Python novos. A adoção Rust lê a identidade comprovada e conecta ao app-server existente. Fechamento WebSocket não chama kill no pid adotado. `ensure_running`, `warm_sessions` e watchers anteriores não recriam cliente Python para sessões adotadas, inclusive quando Rust cai ou está em `pending`. Preservar somente o legado de responsabilidades ainda não migradas, sem ativá-lo como reserva do Codex já Rust.

Se a adoção falhar, produzir erro visível e conservar ausência de escritor; não reconectar Python por conta própria nem acrescentar reserva. Rust indisponível mantém a responsabilidade migrada indisponível com 503/erro visível até a recuperação do Rust, sem escritor Python novo ou antigo assumindo. Responsabilidades não migradas e Guest/Connect continuam funcionando. A arquitetura de recuperação do supervisor exige desenho confirmado antes de código, sem prometer reserva da porta pública ou ponte privada. Escrever prova de no máximo um cliente Hangar ativo durante adoção/recuperação, além da TUI legítima.

Pane morto, cancelamento, encerramento explícito, fila/ator/app-server/pane/sidecar e troca de conversa pertencem ao lifecycle Rust. Fechar backend/handle de controle conserva TUI/app-server vivos; fechar a sessão explicitamente executa a limpeza apropriada sob barreira, geração e diário. No DELETE do dono de Codex terminal, concluir essa parte Rust e depois repassar o mesmo pedido ao Python somente para `share_store`/`sync_tunnel`, `ThenLink`, atalhos e caches existentes. Sessão já morta não chama Rust de volta; não estender essa exceção a lifecycle Claude ou a limpeza da sessão.

**Reconexão do transporte adotado é responsabilidade desta Task.** O ramo `IoEvent::End`/fechamento dos canais precisa distinguir transporte WebSocket adotado de cano cujo processo o Rust possui. Para o adotado, marcar conexão indisponível, concluir operações sem recibo como incertas quando cabível e iniciar uma única tentativa de reconexão; não passar por `after_exit`/`Respawn`, `launch_if_needed` nem `kill_process`.

Manter um estado de reconexão no ator terminal, separado de lançamento e da retentativa de assinatura sem rollout: uma tarefa em voo, espera inicial de 1 s, multiplicador 1,5 e teto de 10 s. Antes de cada conexão, revalidar vínculo, processo e endpoint pelo registro atual. Tentativas transitórias continuam enquanto o mesmo processo está comprovadamente vivo, com problema visível desde a queda e diagnóstico limitado; identidade alterada, sessão removida ou processo morto encerram a tentativa e são tratados pelo lifecycle Rust, sem iniciar outro app-server. Cancelamento/fechamento cancela timer e socket e invalida a admissão antiga; não cede posse ao Python.

Ao reconectar, inicializar e reassinar a mesma thread, preservar a distinção conectado/subscribed da Task 9 e invalidar callbacks da conexão antiga por uma época local de transporte. Reconciliar fila/recibos e pedidos com a fonte confirmada; não reemitir frames de operações `Unknown`. Pendência que o provedor não reapresenta e cuja validade não pode ser provada não recebe novo token respondível por suposição; mostrar indisponibilidade dessa interação sem impedir a resposta pela TUI.

Prova obrigatória: derrubar somente o WebSocket de controle mantendo pid da TUI e app-server vivos; reconectar uma vez, voltar a receber estado e enviar texto, sem spawn/kill, sem dois clientes e sem repetir a aprovação que estava em voo. Testar também endpoint/identidade que mudam durante a espera e transferência que cancela a reconexão.

- [ ] **Step 3: Atualizar feed, lista e todas as fachadas que perdem o cliente**

Ligar juntos `Binding::runtime_feed`, seleção da fonte da lista, runtime e leitores Rust. Remover/condicionar dependências Python de `native_slot`, `apply_event`, `_hands_over` e `_state_owner` nas responsabilidades migradas; não acrescentar fachada ou cliente Python. Não fixar `headless:true` no estado terminal. `Terminal` conserva presença do pane e o runtime Rust publica uma vez.

Preservar transformações dos controles existentes que perdem `AppServerClient`, usando comandos Rust já suportados e catálogo fechado, não `RuntimeView` como cliente RPC nem proxy arbitrário. Isso não autoriza migrar voz, custos, MCP/grupos/navegador/atalhos/estatística ou Pi/omp/Kimi. Portas Python apenas repassam a escrita autorizada e devolvem o resultado Rust.

Portar a responsabilidade de `sessions.switch_thread` para o lifecycle Rust: invalidar respostas do vínculo anterior, persistir a conversa/sidecar com a chave correta, confirmar nova geração e só então publicar/admitir. Python não persiste essa troca nem fornece `permission-reopen`. A assinatura comum de geração/admissão/fechamento fica congelada entre 7/10 antes do corte 12.

- [ ] **Step 4: Reservar testes da adoção e dos leitores**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it runtime_gateway
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it runtime_recovery
```

Não ativar `owned_modes()` para terminal Codex ainda: o seletor da Task 11 e os consumidores da Task 12 precisam estar completos.

### Task 11: Seletor de permissões Codex e teclado serializado

**Arquivos:**
- Alterar: `crates/hangar-server/src/permission_control.rs`, `session_write/permissions.rs`, `runtime/codex_terminal.rs`, `runtime/actor.rs`, `terminal_input.rs`.
- Referência de port: `backend/app/codex_permissions.py`, `backend/app/terminal_input.py:2537-2635`, `backend/app/api.py::permissoes_do_codex(name: str)` e `trocar_permissao_do_codex(name: str, body: CodexPermissionBody)`.
- Testar: testes internos do parser novo em `permission_control.rs`; `crates/hangar-server/tests/it/terminal_control.rs`; fixtures `backend/tests/fixtures/pane_codex_permissions.txt` e `pane_codex_permissions_confirma.txt`.

**Interfaces:**
- Consumir o contrato serial efetivo de leitura/troca congelado pela Task 7, usando `TerminalDriver`/executor/admissão existentes. Não reconstruir controlador ou inventar assinatura antes de recebê-la.
- Portar/reutilizar parsers do seletor e seu DTO dentro da unidade responsável. Preservar número, nome, descrição, item atual e cursor; serialização pública `{ numero, nome, desc, atual, cursor }`, GET `{ modes, current }` e POST `{ current }`. Os nomes dos exemplos abaixo são locais à regressão e serão casados aos símbolos efetivos antes dos consumidores.
- A migração não retira números nem descrições usados pelo `packages/core/src/api.ts::CodexPermissionMode` e pelo `frontend/src/components/CodexPermissionPopover.svelte`.
- A operação inteira usa a mesma serialização do dono da sessão que as demais escritas, não um lock Python independente.

- [ ] **Step 1: Prender parser e confirmação tardia em regressões**

```rust
#[test]
fn conversation_codex_permissions_read_the_live_fixture() {
    let pane = include_str!("../../../backend/tests/fixtures/pane_codex_permissions.txt");
    let modes = parse_codex_modes(pane);
    assert!(!modes.is_empty());
    assert_eq!(modes.iter().filter(|mode| mode.current).count(), 1);
    assert_eq!(modes.iter().filter(|mode| mode.cursor).count(), 1);
    assert!(current_codex_mode(pane).is_some());
    for mode in &modes {
        let public = serde_json::to_value(mode).unwrap();
        assert_eq!(public["numero"], mode.number);
        assert_eq!(public["nome"], mode.name);
        assert_eq!(public["desc"], mode.description);
        assert_eq!(public["atual"], mode.current);
        assert_eq!(public["cursor"], mode.cursor);
    }
}
```

Derivar `Serialize` no DTO do parser, com os renames públicos indicados. O caminho acima é relativo a `crates/hangar-server/src/permission_control.rs`. Portar as expectativas específicas de `backend/tests/test_codex_permissions.py`, incluindo diálogo Full Access que aparece tarde e cursor diferente do solicitado.

- [ ] **Step 2: Portar a sequência inteira, não teclas isoladas**

Abrir `/permissions` somente sob guarda de pane apropriada, ler opções atuais, calcular movimento, reler o cursor antes do Enter, aguardar confirmação adicional quando o modo a exige e reler o seletor para saber o modo efetivo. Fechar menu nas saídas previstas sem enviar Esc duplicado depois de ele já ter fechado.

```rust
if selected.as_deref().map(|value| value.to_lowercase()) != Some(requested.trim().to_lowercase()) {
    return Err(RuntimeError::new("permission_cursor_mismatch", "O cursor não está no modo solicitado."));
}
```

`selected` vem da captura imediatamente anterior à confirmação. Timeout aguardando Full Access não significa ausência do diálogo: parar e devolver erro que orienta conferir o terminal, sem digitar outro `/permissions` por cima.

`SetPermissionMode` headless não é usado para terminal. A troca terminal não emite `Effect::Respawn` e não troca sandbox relançando app-server.

- [ ] **Step 3: Compartilhar serialização com envio e controles legados**

Durante o seletor, fila/teclas/ações que poderiam escrever aguardam ou recusam conforme o contrato existente. Escritas migradas vindas das portas Python são somente repassadas e admitidas pelo mesmo dono Rust, sem segundo escritor. Não ampliar o empréstimo Python para executar permissões/lifecycle; conservar mecanismos anteriores somente nas funções fora do recorte, sem migrá-las por vizinhança.

Cobrir menu aberto pelo usuário, painel real aberto, pane que sumiu e Windows com destinos que compartilham `%1`. Uma recusa antes da seleção tem zero teclas de confirmação.

- [ ] **Step 4: Reservar o teste focado e prova Windows**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --lib conversation_codex_permissions
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it terminal_control
```

Na Task 13, provar leitura, troca normal, confirmação Full Access e falha de confirmação na DELPHI-02, sem alterar o nível de permissão de uma sessão real de trabalho.

### Task 12: Corte único de propriedade, portas Python e contrato público

**Arquivos:**
- Alterar: `crates/hangar-server/src/routes.rs`, `session_write/table.rs`, `session_write/mod.rs`, `migration_status.rs`, `lib.rs`, `state/runtime_feed.rs`, `list/facts.rs`, `list/sig.rs`.
- Alterar: `backend/app/rust_server.py`, `runtime_adapter.py`, `runtime_coordinator.py`, `plugin_bridge.py`, `state_facts.py`, `list_facts.py`, `sse.py`, `state.py`, `models.py`, `askquestion.py`, `internal_api.py`, `api.py`.
- Criar: `crates/hangar-server/tests/it/conversation_contract.rs`; registrar em `tests/it/main.rs`.
- Preservar testes existentes de autorização/roteamento Python (`test_runtime_routing.py`, `test_runtime_ownership.py`) para a entrada mínima e responsabilidades não migradas, sem recriar `test_interaction_contract.py`/`test_runtime_interaction_guard.py`. Escrever regressões integradas Rust e de clientes, sem executar.

**Ligação e corte:**
- Publicação de identidade é feita uma vez no Rust; todos os DTOs/cópias conservam o mesmo valor.
- Portas Python autorizam pelo código existente e repassam apenas corpo/`interaction_id`/correlação à escrita Rust pela ligação existente. Não instituir `RuntimeCoordinator` como dono de pergunta, normalização, persistência ou lifecycle.
- Q1/B permite crescimento Python mínimo somente para esse repasse num sentido, discriminado por arquivo; demais mudanças permanecem com saldo zero/negativo. O +78 declarado da Task 10 é pendência de classificação, não aprovação irrestrita.
- DELETE/A de Codex terminal na porta do dono fecha no Rust e depois vai ao Python apenas para limpar `share_store`/`sync_tunnel`, `ThenLink`, atalhos e caches já existentes. Testar ordem e ausência de chamada de volta ao Rust; não estender a Claude.
- Relançamento de sessão existente é Rust, conforme a decisão A: eliminar `hand-over` e sua janela sem dono, conferir que as rotas de relançar não voltam ao Python e que não há modo presumido. Assinaturas Rust de geração/admissão/fechamento e lançamento privado vêm das unidades 7/10, congeladas antes deste corte.
- Saúde/`owned_modes()`/`migration_status`, tabela, rotas e portas mudam juntos somente para responsabilidades realmente conectadas. Erro de forma ou dono doente é Rust no recorte migrado, sem relay Python de recuperação.
- Protocolos de base `51` passam juntos a `52`, ressalvada atualização concorrente da base.

- [ ] **Step 1: Criar a matriz integrada antes de virar as rotas**

No teste Rust novo, usar os fakes de runtime/HTTP existentes para percorrer:

```json
[
  {"provider":"claude","headless":false,"owner":"rust"},
  {"provider":"claude","headless":true,"owner":"rust"},
  {"provider":"codex","headless":false,"owner":"rust"},
  {"provider":"codex","headless":true,"owner":"rust"}
]
```

Para cada combinação, escrever provas de seleção/resposta com ID atual, antigo e ausente, corpo inválido e dono doente: o Rust responde e não pede normalização/recuperação Python. Nas portas Python, conferir autorização de dono/convidado/Connect e corpo/ID intactos no repasse mínimo. Rust indisponível responde erro nas responsabilidades já migradas e nunca ativa seus produtores Python; o supervisor deve recuperar o Rust sem devolvê-las ao Python. O legado ainda não migrado permanece funcionando, com suas portas e uso unidirecional do Rust preservados. O desenho de recuperação/porta pública deve ser confirmado antes de alterações amplas. DELETE Codex terminal: provar fechamento Rust completo antes da limpeza externa Python, sem retorno ao Rust, inclusive repetição e falha de limpeza visível.

- [ ] **Step 2: Ligar fontes e manter a identidade da pergunta exibida**

Os motores, plugin e Monitor produzem representação semântica e `InteractionTarget` de cada interação e chamam o Store da Task 1. Estado/lista usam o ID do seletor de opções; `codex_question` e `ask_question` usam o ID do formulário correspondente. Não sobrescrever um com o outro quando coexistem aprovação e pergunta, nem invalidar por ordem de publicação. Observadores não geram ID por conta própria. Incluir cada campo nas assinaturas de dedup dos respectivos payloads. Resolução invalida somente o alvo concluído; `/clear`, troca de vida/thread e remoção invalidam todos os alvos do vínculo anterior.

O sidecar lido por `state/ask.rs` pode não trazer ID público: o dono Rust associa o ID ao retrato completo e conserva evidência de sua fonte (ID nativo/tool-use quando presente e revisão do arquivo lido) antes de publicar. O código antigo equivalente em `askquestion.py` pode ficar para consulta, mas o caminho da pergunta já migrada não o executa nem o ativa como reserva. Essa revisão integra a conferência guardada e o consumo específico da Task 4; retorno de A não apaga nem oculta arquivo B. Não gravar no registro nativo da CLI nem inventar ID no front. Sem sinal capaz de distinguir substituição invisível e idêntica na TUI, não atribuir ao token uma garantia que a fonte não oferece.

Atualizar reconstruções que hoje descartam campos e retirar fontes duplicadas do `side-events`. A projeção Python pode transportar o valor; não decide outra pergunta quando o retrato Rust falta.

- [ ] **Step 3: Virar a tabela e as rotas com dependências prontas**

Registrar rotas de plugin/modos migradas e alterar a linha de Codex terminal na tabela somente agora. Diferenciar as operações de controle necessárias de rotas de administração ainda não migradas; não trocar `CodexControl` indiscriminadamente se isso anuncia uma operação inexistente.

Retirar do caminho ativo os callbacks Python antigos de pergunta, plugin/fatos, publicação, drenagem, observação de modo e lifecycle já migrados. Seus corpos podem ficar somente como referência, sem chamador ativo nem reserva. Preservar código e regressões legados de responsabilidades não migradas, suas portas e os repasses autorizados; não acrescentar passagem de dono ou vigia Python. Rotas/tabela/portas cortam juntas: forma inválida, ausência de identidade ou dono doente recebem erro Rust nas responsabilidades migradas, nunca relay ao Python para normalizar, reconstruir pergunta ou tentar novamente. Preservar apenas repasse de escrita Q1/B e limpeza externa DELETE/A delimitados; saldo das demais mudanças Python é zero/negativo.

Atualizar em conjunto:

```python
RUST_SERVER_PROTOCOL = 52
```

```rust
pub const INTERNAL_PROTOCOL: u32 = 52;
```

O número é para a base deste plano; conferir os dois valores antes da edição. Snapshot do cano continua na versão vigente, pois identidade pública efêmera e transporte WebSocket não exigem por si uma mudança naquele formato.

- [ ] **Step 4: Reservar provas de propriedade e consumidores**

```bash
cargo test --manifest-path crates/Cargo.toml -p hangar-server --test it conversation_contract
(cd backend && uv run pytest tests/test_runtime_routing.py tests/test_runtime_ownership.py)
```

Verificar ainda controles existentes de modelo/Fast/skills/settings que perderiam o cliente Python, pré-thread fora da adoção, painel terminal, só lista aberta e convidado sem dono olhando. Essas provas preservam o que já existe; não autorizam portar recursos novos.

### Task 13: Conferir a entrega autorizada, documentar fronteiras e deixar abertura registrada

**Arquivos:**
- Alterar ao concluir implementação: `CLAUDE.md`, `docs/decisoes/harnesses.md`, `docs/decisoes/plataforma.md`, `docs/migracao-rust/README.md`.
- Atualizar progresso: este plano.
- Atualizar referências históricas de escopo se necessário: `docs/migracao-rust/parte5-claude/spec.md`, `docs/migracao-rust/parte5-codex/spec.md`; não reescrever resultados antigos como se fossem medições novas.

**Interfaces:** esta Task recebe a entrega completa das Tasks 1–12. Não implementa a abertura, não faz nova auditoria geral e não autoriza publicação.

- [ ] **Step 1: Fazer uma única conferência de cobertura antes do lote pedido**

Conferir a matriz do desenho contra Tasks 1–12: identidade pública e clientes; plugin; fatos/drenagem; modos/lifecycle Rust; transporte; primeiro input; disputa app/TUI; leitores/repasse mínimo das portas; responsabilidade migrada com erro até recuperar Rust e legado não migrado funcionando no Python; limpeza externa DELETE Codex; Windows. Corrigir lacuna concreta e repetir só checks afetados quando já tiverem sido autorizados. Não abrir outra rodada ampla sobre correções já revisadas.

Exemplo de busca de chamadas que não devem sobreviver no caminho ativo:

```bash
rg -n 'terminal_facts|terminal_publish|terminal_plugin_control|permission\.observe|session\.deliverable' crates/hangar-server/src backend/app
```

Ocorrência em corpo sem chamador mantido como referência, em documentação ou em responsabilidade distinta ainda não migrada não é falha. Caminho ativo Python para responsabilidade já migrada refuta o corte, inclusive durante recuperação do Rust. A prova é qual caminho executa, incluindo chamadas observadas pelo fake e pelo uso real; não apagar funções/regressões legadas só para zerar o grep.

- [ ] **Step 2: Executar somente o conjunto de checks solicitado pelo usuário**

Quando solicitado o focado, agrupar os comandos das Tasks afetadas em um lote, aproveitar testes já executados nessa árvore e repetir apenas falhas. A suíte Python precisa de isolamento de HOME/estado/transporte conforme fixtures existentes para não atingir sessões sem terminal reais. Nada de `GIT_DIR` do repositório real nos testes.

Se solicitado o completo, os comandos web/core/mobile são os da raiz:

```bash
npm run check
npm test
```

Os completos Python/Rust/nativo entram conforme o pedido e as regras locais. `scripts/verificar-local` só quando pedido ou exigido pelo fluxo de publicação autorizado; não interpretar este plano como autorização de push/PR. Builds de front/nativo servem à prova de uso, não são disparados ao terminar cada edição de backend.

- [ ] **Step 3: Verificação manual — Claude e clientes reais**

Com ambiente e sessões descartáveis combinados, registrar evidência destas ações:

1. Claude terminal e sem terminal: opção, múltipla escolha, texto, conversar, permitir/negar e aprovar/recusar saída do plano.
2. PWA/mobile/nativo: manter A visível, substituir por B e entregar clique atrasado de A; B não é respondida. Testar cliente antigo sem ID com recusa explícita.
3. Permissão segurada: lista e chat concordam; anexar terminal/deixar app ausente conserva a escolha de onde responder.
4. Sondagem/troca de modo, painel aberto e bypass com reabertura; confirmar modo real e base anterior ao plano.
5. Reiniciar somente no ambiente autorizado; sem pergunta fantasma, repetição automática ou sessão duplicada.

Abrir a interface real, clicar e conferir resultado. No nativo usar build otimizado no cache de cargo e print; não declarar prova de GPUI por olhar apenas página no navegador.

- [ ] **Step 4: Verificação manual — Codex terminal no Linux e Windows**

Em sessão descartável Codex com modelo de teste escolhido pelo usuário, sem alterar Full Access por iniciativa:

1. Abrir pelo caminho existente; primeiro input pelo app antes de qualquer turno/rollout.
2. Trocar mensagens entre app e TUI; confirmar uma prévia/estado e nenhuma thread criada indevidamente.
3. Responder pergunta/aprovação nos dois lados; provocar disputa controlada e conferir retorno sem autoria inventada, sem repetir o frame.
4. Ler/trocar permissões, incluindo confirmação adicional autorizada e falha de confirmação tardia.
5. Desconectar/reconectar Rust sem encerrar TUI/app-server; conferir recuperação de fila/recibo, erro real de assinatura e pergunta encerrada.
6. DELPHI-02: destinos psmux, painel aberto e duas sessões com pane `%1`; nenhuma tecla chega à sessão vizinha.

Se alguma prova não puder ser feita, registrá-la como pendente, não como sucesso por teste simulado. Não testar em sessões vivas de trabalho nem usar RDP que tome a sessão da pessoa.

- [ ] **Step 5: Atualizar documentação e entregar o estado real**

Registrar regra atual de dono e contrato de identidade no `CLAUDE.md`; evidência, limites e medidas em `docs/decisoes/`. Informar que clientes antigos sem ID agora são recusados e que Codex terminal não informa autoria da resolução.

Listar explicitamente a fronteira: Python conserva criação/abertura/lançador/preparo de conta, autorização existente das portas com repasse mínimo Q1/B e, somente após DELETE Codex concluído no Rust, limpeza externa DELETE/A (`share_store`/`sync_tunnel`, `ThenLink`, atalhos e caches), sem chamada de volta. Persistência de conversa/sidecar, reabertura bypass, pane morto, fechamento/limpeza da sessão e demais responsabilidades migradas são Rust. Recursos fora do recorte conservam comportamento anterior sem migração por vizinhança. Discriminar o saldo Python por arquivo: crescimento mínimo somente do repasse aprovado, restante zero/negativo; não aprovar +78 por total agregado. O relançamento Rust das sessões já abertas está autorizado; a migração da abertura inicial é trabalho separado, e o desenho de recuperação do supervisor ainda depende de decisão do usuário. Não declarar prova não executada como feita ou ganho de velocidade sem medição.

Ao encerrar, reportar checks executados, uso real conferido e pendências. Sem commit/push por este Step; se posteriormente autorizados, stage seletivo do trabalho, verificações exigidas, hash/branch e estado real da árvore.

## Segundo trabalho, separado deste plano

- [ ] Escrever e submeter o desenho/plano de abertura completa de Claude/Codex, com e sem terminal, conforme contratado.

Esse item não faz parte das Tasks 1–13 nem pode ser marcado concluído pela migração da conversa. Abrange pedido de criação, identidade/nome, conta, ambiente, registros iniciais, lançamento, adoção e recuperação, incluindo o lançador/supervisor Codex terminal. Cadastro/login de contas, transferência de conversa e gestão geral de worktrees não entram automaticamente nesse segundo escopo.

## Autorização e próximo portão

O contrato revisto autoriza retrabalho por subagentes em duas sessões/worktrees. Preservar entregas revisadas 1–5/8/9, memória 7a e marcadores reais; fontes 6, controlador/lifecycle 7, retrabalho 10 e corte 12 ainda precisam de adequação. O relançamento Rust das sessões já abertas está autorizado e aguarda suas dependências revisadas; o desenho de recuperação do supervisor e a migração da abertura inicial não estão autorizados por essa decisão. Os trabalhos independentes aprovados continuam. Revisão de implementação é por unidade alterada e uma revisão final do conjunto, sem outra auditoria ampla do plano ou revisão inteira de 9–11. Testes/builds, serviços, commits e publicação continuam dependendo das autorizações pertinentes. Provas pendentes permanecem desmarcadas, e não impedem implementar a próxima unidade quando seus contratos de código estiverem revisados; a entrega final não será declarada conferida enquanto faltarem as provas exigidas.
