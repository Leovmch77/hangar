# Abertura de sessão única no Rust — plano

Spec: `docs/superpowers/specs/2026-10-15-unified-session-open.md`. Arquivos de fase da skill
`migrar-python-rust`: `/home/jefferson/Projetos/hangar/.superpowers/sdd/2026-10-15-abertura-de-sessao/`.
Branch `feat/unified-session-open`, worktree `~/Projetos/hangar-abertura-unica`, um PR só (D-005).
`docs/superpowers/` está no `.gitignore`: plano e spec entram com `git add -f`.

## Regras de toda Task

- O comportamento que vale é o do inventário; cada Task recebe só as linhas dela (recorte).
- Os 81 pontos do `suspeitas.md` são problemas a corrigir (D-011): o Rust já nasce corrigido nos
  pontos da Task. Cada conserto é um commit próprio, e a fixture correspondente ganha a diferença
  esperada com a regra de comparação (nunca a saída do Rust gravada como esperada). O resto sai
  igual à fixture do Python (Task 1).
- Padrão sem parâmetros = sessão completa, como definido pela matriz (Task 2, D-012). Toda origem
  abre igual.
- TDD: cada fatia com a linha RED (falha de asserção) e GREEN. Fixtures reais, nunca editadas à
  mão. Entrada externa (pane, JSONL, payload) passa por `proptest` (dependência de teste nova no
  `hangar-server`).
- Falha visível com código; nunca sucesso falso; nunca reserva Python com o Rust de pé.
- No fim de cada Task: o caminho Python que ela substituiu é apagado, e um `grep` nos dois lados
  mostra que nenhum chamador sobrou (D-008).
- Contrato interno mudou: `INTERNAL_PROTOCOL` e `RUST_SERVER_PROTOCOL` sobem juntos, na mesclagem.
- Compilar com `nice -n 19 ionice -c 3`, `-j 3`, `CARGO_TARGET_DIR` próprio da worktree; nunca o
  backend real nem sessão viva (teste em `cx-*` descartável).
- Toda mudança vale no Windows (psmux, `claude.ps1`/`claude-conta.ps1`/`codex.ps1`); conferência
  na DELPHI-02.
- Subagentes deste trabalho (executores, revisores, verificadores) rodam em Opus (`model: "opus"`);
  nunca Sonnet (D-009).
- Nomes novos sem colisão: `SessionOpenRequest`, `SessionSpec`, `SessionChange`, `AgentProvider`,
  `resolve_open`, `open_session`, `reopen_session` (`OpenRequest`, `Provider`, `gateway::open` e
  `enum Reopen` já existem).

## Lotes — o que corre em paralelo

1 → 2 → 3 (serial). Depois da 3: Task 4 (terminal) e Task 5 (registro e recuperação) em paralelo.
Depois da 5: Task 6 (Claude sem terminal). Depois de 4 e 6: Task 7 (Codex), Task 9 (Pi/omp/Kimi)
e Task 13 (estacionar) em paralelo. Depois da 7: Task 8 (reabrir Claude; usa a transferência
Claude→Codex e o mesmo `session_write/relaunch.rs`). Depois de 7, 8 e 9: Task 10 (retomar e
reboot). Depois da 10: Task 11 (clientes). Depois da 11: Task 12 (MCP). Depois de 8 e 11: Task 14
(troca de conta no limite). Por último: Task 15 (provas). Teto: 3 worktrees de rota ao mesmo tempo.

### Task 1: Prender o comportamento do Python (caracterização + diferencial)

Status: done (c41701a0d)

- [x] **Step 1: Fixtures de contrato executando o Python**
  118 fixtures em `backend/tests/fixtures/contract/session-open/`, geradas sobre `git archive
  601bc62a0`: criação (81), reaberturas Claude (19), Codex (5), retomar/arquivo/bastão (13).
- [x] **Step 2: Harness diferencial**
  `uv run python tests/fixtures/contract/session_open_contract.py diff --side python|rust`; o lado
  Rust falha dizendo a rota que falta. Compara o plano de lançamento (pedido resolvido, argv, `-e`,
  arquivos, registros), sem lançar processo.
- [x] **Step 3: Contrato**
  Rust = fixture do Python, exceto os consertos do `suspeitas.md` (D-011) e as decisões D-xxx, cada
  um com sua diferença esperada registrada na Task que o faz. Limites (Codex de verdade,
  Windows/psmux, processo real dos CLIs) ficam para a Task 15 com sessão `cx-*`.

### Task 2: Definir a sessão correta (matriz capacidades × origens)

Status: done (`matriz-capacidades.md`: 24 itens da sessão correta; mais perto do correto: MCP
`new_session`, 22 de 25; terminal digitado, 6 de 25)

- [x] **Step 1: Matriz**
  Tudo que o Hangar oferece e depende de como a sessão nasceu (plugins, MCP `hangar`, ponte do
  plugin, Jev, navegador embutido, Computer Use, hooks de estado, statusline, conta, permissão,
  modelo, motor, protocolo de grupo, …) × cada origem (modal "+", Nova conversa, PWA, Expo, voz,
  `hangar-send`, MCP, terminal, `hangar-codex`, reaberturas), com evidência de código, fixtures e
  sessões vivas. Saída: `matriz-capacidades.md`.
- [x] **Step 2: Padrão completo**
  A lista "sessão correta" (seção 2 do `matriz-capacidades.md`, itens 1–24) vira o padrão do
  `resolve_open()` sem parâmetros (escolhas: itens 9, 17–22, na Task 3) e do plano de lançamento
  (identidade, terminal, ambiente e integrações: itens 1–8, 10–16, nas Tasks 4, 6, 7 e 9).

### Task 3: Tipos, `resolve_open()`, registro e o comando de terminal (R0)

Status: ready-for-agent

- [x] **Step 1: Tipos**
  `SessionOpenRequest` (JSON do `CreateBody` + `inherit`), `SessionSpec`, `SessionChange`,
  `AgentProvider` e os enums fechados; o `Provider { Claude, Codex }` do `session_write` passa a
  derivar do `AgentProvider`. Desserialização estrita, `erro_corpo_invalido`. `account_source` no
  fio com os valores de hoje.
- [x] **Step 2: `resolve_open()`**
  Ordem: provider padrão → herança (D-001, `inherit`) → conta Codex padrão → 95% (D-003) → padrão
  completo da matriz (D-012) → validação (modelo, esforço, tier, motor, permissão, customizações,
  nome). "+" sem modo = padrão da conta (D-010). Recusas com os códigos de hoje
  (`erro_motor_invalido`, `erro_nome_em_uso`, …); as que dependem de efeito (como
  `erro_grupo_limpeza_falhou`) são do lançamento, na Task 4.
- [x] **Step 3: Registro gravado**
  Arquivo novo por sessão, indexado pela `key`, atômico, só o Rust grava. Os sidecars de hoje não
  perdem campo nesta entrega (revert seguro). Contrato com o `hangar-codex-tui` (lê e grava
  `permission_mode` do sidecar Codex) e com o rename (Python). Leitura dos sidecars existentes para
  as sessões já vivas.
- [x] **Step 4: Biblioteca + comando de terminal (D-013)**
  `resolve_open()` numa biblioteca usada pelo servidor e por um comando (`hangar-open`). Com o
  servidor de pé, o comando pede ao servidor; fora do ar, resolve nesta máquina, dos mesmos
  arquivos, e imprime o spec. Abrir igual com o servidor fora (e o servidor adotar depois) entra na
  Task 4, junto com o lançador.
- [x] **Step 5: Despacho provisório do `POST /api/sessions` no Rust**
  Por provider × com/sem terminal; o que ainda não migrou responde 421 e segue ao Python só durante
  a branch. Sai na Task 11.
- [ ] **Step 6: Modo `python` e atualização**
  `session_open_needs_rust_server` no app e no diário; a atualização compila o Rust antes de
  reiniciar o backend.

### Task 4: Lançador de terminal único + criar Claude com terminal (R2)

Status: ready-for-agent

- [ ] **Step 1: Um spawner de terminal no Rust**
  A partir do `lifecycle::stage_session`: escopo systemd (repete a recusa transitória, S-31), `-e`
  completo e igual para todo provider, ramo psmux, conferência de que o comando não morreu ao nascer
  (S-15). Itens TMX.
- [ ] **Step 2: Plano de lançamento do Claude a partir do spec**
  argv e ambiente (motor, `--context`, `--settings`, Jev, portão de hooks, plugin), pré-confiar a
  pasta, preparar a conta (`hangar-conta --prep`, passando o cwd; `python3` no Windows).
- [ ] **Step 3: Criar Claude com terminal no Rust, com worktree**
  `create_worktree` (`crates/hangar-workspace/src/git.rs:365`) ganha o laço de nome `-2…-99` de
  `git_ops.py:472` e o desfazer de `_undo_worktree` (`api.py:2393`).
- [ ] **Step 4: Consertos desta parte**
  S-15, S-31, S-32, S-40, S-45, S-55, S-63, S-66, S-67.
- [ ] **Step 5: Apagar o Python substituído**
  `registry.create` com terminal, os call sites de `tmux.new_session` desta parte e os helpers sem
  chamador.

### Task 5: Registro de sessões e recuperação no Rust

Status: needs-info (decisão do usuário: o que acontece com as sessões quando o Rust cai de vez)

- [ ] **Step 1: Pergunta curta ao usuário sobre a recuperação**
  Hoje o coordenador Python assume as sessões quando o Rust desiste (`runtime_coordinator.py:377-395,
  1659`) e lança processos na subida (`:407-466`, `:791-833`). Mexer nisso exige decisão dele.
- [ ] **Step 2: Registro e travas de troca no Rust**
  O que o coordenador guarda (registro das sessões, travas de troca) passa para o Rust, conforme a
  resposta do Step 1.
- [ ] **Step 3: Apagar o Python substituído**

### Task 6: Claude sem terminal pelo spec (R1)

Status: ready-for-agent

- [ ] **Step 1: Criar Claude sem terminal no Rust**
  Grava o registro e lança pelo plano de lançamento do spec, não pela receita do processo vivo.
  Itens CSH.
- [ ] **Step 2: Relançar e reabrir pelo spec**
  `schedule_claude_respawn`/`reopen_headless_locked` usam o spec; ordem da `SessionChange` da spec
  (prepara parada, encerra e confirma, dá a partida e confirma); o modo observado da CLI vai ao
  spec (S-02).
- [ ] **Step 3: Consertos desta parte**
  S-02, S-11, S-30, S-64, S-72.
- [ ] **Step 4: Apagar o Python substituído**
  `_create_headless`, `launch_process` e companhia, abrir/reabrir do `runtime_coordinator`,
  `internal_api.session_reopen` e a chamada em `locate.rs:118`.

### Task 7: Codex numa implementação só (R3)

Status: ready-for-agent

- [ ] **Step 1: Criar Codex com e sem terminal pelo spec**
  O pane chama o `hangar-codex-tui` com `CP_SESSION_KEY` e o ambiente do spec. Itens CDX.
- [ ] **Step 2: Troca de modo, restart, adoção e transferência numa implementação**
  `codex_relaunch` usando o spec.
- [ ] **Step 3: `hangar-codex` sem `_create_local`**
  Usa o comando de terminal da Task 3 (abre igual com o backend fora).
- [ ] **Step 4: Consertos desta parte**
  S-05, S-24, S-25, S-26, S-28, S-74; lacunas S-56, S-57, S-77.
- [ ] **Step 5: Apagar o Python substituído**
  `CodexAdapter.open_*`, `restart`, `ensure_tmux_tui`, `_create_codex_headless`,
  `sem_terminal.subir`, `_create_local`.

### Task 8: Reabrir Claude como `open_session(spec ⊕ SessionChange)` (R4)

Status: ready-for-agent

- [ ] **Step 1: Rotas no Rust**
  `/modo-execucao`, `/recarregar`, `/conta` (com a transferência Claude→Codex) e
  `/permission-mode` em bypass, na ordem da `SessionChange`. Itens CRA.
- [ ] **Step 2: Modo lido do spec, nunca do rodapé**
  Modo ilegível ou desconhecido é recusado (S-01, S-03, S-04).
- [ ] **Step 3: Consertos desta parte**
  S-01, S-03, S-04, S-07, S-12, S-18, S-20; lacunas S-13, S-21.
- [ ] **Step 4: Apagar o Python substituído**
  `_trocar_modo`, `_reload_terminal`, `_trocar_conta`, `_bypass_reopen`/`_reabrir_em_bypass`,
  `para_terminal`, `para_headless`, `restore_transfer_source`.

### Task 9: Pi, omp e Kimi pelo spec (R6)

Status: ready-for-agent

- [ ] **Step 1: Criar e retomar Pi, omp e Kimi no Rust**
  Perfil do omp, `CP_PI_SESSION` (S-58), ticket do Kimi, omp no Windows sem perder o perfil (S-73).
- [ ] **Step 2: Apagar o Python substituído**
  Os ramos de Pi/omp/Kimi no `registry.create`/`resume`.

### Task 10: Retomar e restaurar depois do reboot (R5)

Status: ready-for-agent

- [ ] **Step 1: Rotas no Rust**
  `/resume`, retomar do arquivo e bastão como `open_session`/`reopen_session`; o retomar do arquivo
  passa pelas guardas da criação (S-08). Itens RET.
- [ ] **Step 2: Restore do reboot pelo Rust, na subida**
  O Rust reabre as sessões a partir dos specs gravados; o resurrect pula as sessões do Hangar
  (`tmux-claude-resume.sh:29-31,286`). Volta com tudo (S-68, S-69, S-70).
- [ ] **Step 3: Consertos desta parte**
  S-08, S-16, S-17, S-19, S-22, S-23, S-36, S-68, S-69, S-70.
- [ ] **Step 4: Apagar o Python substituído**
  `registry.resume`, `resume_archived`, o lançamento do `_passar_bastao` e a montagem de comando do
  script.

### Task 11: Clientes num caminho só (R7)

Status: ready-for-agent

- [ ] **Step 1: Agentes e voz**
  `hangar-send --new` (e o `orquestrar`, que o usa) imprime o nome devolvido (S-44), usa o prazo das
  telas (S-29) e aceita o conjunto inteiro de parâmetros; a voz segue pelo `POST` local, que agora
  é do Rust.
- [ ] **Step 2: Comandos digitados no terminal (D-013)**
  `claude`/`pi`/`omp`/`kimi` (`.posix.sh`, `.fish`; `claude.ps1`) chamam o comando de terminal da
  Task 3. `-p`, pipe, `--resume` explícito e flag desconhecida seguem rodando o CLI cru
  (`claude.posix.sh:59-100`).
- [ ] **Step 3: Convidado e Connect**
  Criar como convidado e pela porta 8768 sem Rust → Python → Rust e sem dois escritores do
  `guests.json` (`guest_user_gate.py:182-195`, `guest_users.py:170-199`).
- [ ] **Step 4: Chamadores que faltavam**
  `GET /api/sessions/creation-progress` (`api.py:2229`); `remember_provider` gravando o
  `runtime-config.json`.
- [ ] **Step 5: Telas**
  Sem padrão escondido na tela ("+" sem modo = padrão da conta, D-010); erros novos com frase no
  `errosApi.ts` e no nativo (S-38); aviso de conta trocada em toda tela (D-003); nome automático
  igual (S-52).
- [ ] **Step 6: Apagar o despacho provisório da Task 3 e o `create_session` Python**
- [ ] **Step 7: Verificação manual no app nativo, PWA e Expo**
  Abrir pelo "+", pela Nova conversa, pela voz, por `hangar-send`, pelo MCP e pelo terminal, e
  conferir que nascem iguais.

### Task 12: Servidor MCP no Rust (R9)

Status: ready-for-agent

- [ ] **Step 1: `/mcp` no Rust com o SDK oficial (`rmcp`, versão fixada)**
  Mesmas 14 tools, nomes, descrições e parâmetros; bearer conferido antes do servidor MCP.
- [ ] **Step 2: Identidade de quem chamou no Rust**
  Porta do `quem_chama.py`: chave vence pane, pane vence nome, pane ambíguo não resolve, nada
  resolvido é erro.
- [ ] **Step 3: Cada tool chama a mesma rota que o `hangar-send`/`hangar-preview` chama**
  `new_session` e `close_session` direto no `open_session`/fechar do Rust, com o conjunto inteiro de
  parâmetros.
- [ ] **Step 4: Apagar o Python substituído**
  `mcp_server.py` e `quem_chama.py` (se sem outro chamador).

### Task 13: Estacionar a sessão parada (R10, D-006)

Status: ready-for-agent

- [ ] **Step 1: Vigia de 65 min no ator do Claude sem terminal**
  Mesmas condições do `_pode_estacionar` (sem turno, permissão, pergunta, subida, esforço pendente
  nem fila por entregar).
- [ ] **Step 2: Próxima mensagem reabre pelo spec**
  Como o `open_parked` do Codex; a lista mostra "estacionada".
- [ ] **Step 3: Apagar o vigia Python**

### Task 14: Troca de conta quando a sessão bate o limite (R8, D-002)

Status: needs-info

- [ ] **Step 1: Sinal de limite**
  Conferir no binário instalado do Claude Code qual evento indica "limite atingido" (hook ou evento
  do stream) numa sessão `cx-*`, e qual janela esgotou.
- [ ] **Step 2: Troca automática**
  `reopen_session` com `SessionChange{account, motivo: limit_switch}` na conta de mais folga +
  mensagem de continuar; sem rodar em círculo; sessão em motor fica de fora.
- [ ] **Step 3: Verificação manual numa conta que bate o limite de verdade**
  Se no fim só esta Task travar o merge, perguntar ao usuário se ela vai para o PR seguinte.

### Task 15: Portões de prova

Status: ready-for-agent

- [ ] **Step 1: Conferência item a item (769 linhas) no `conferencia.md`**
- [ ] **Step 2: Relatório do diferencial e revisão de falhas caladas do diff inteiro**
- [ ] **Step 3: Caminho inteiro: `grep` nos dois lados, nenhum chamador de abrir/reabrir no Python**
- [ ] **Step 4: Verificação manual em uso real: release de checkout limpo no Linux e na DELPHI-02, com sessão `cx-*` (Codex de verdade, psmux, processo real dos CLIs)**
- [ ] **Step 5: Medição: p50/p95 de criar e reabrir, antes e depois, também na DELPHI-02**
