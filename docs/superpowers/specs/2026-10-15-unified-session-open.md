# Abertura de sessão única no Rust (`open(spec)`)

Status: rascunho para aprovação (2026-10-15)

Material de apoio (fora do repositório, em `~/Projetos/hangar/.superpowers/sdd/2026-10-15-abertura-de-sessao/`):
- `escopo.md`: uso real, chamadores e rotas;
- `inventario-*.md`: 769 comportamentos;
- `suspeitas.md`: 81 pontos classificados;
- `decisoes.md`: D-001 a D-010.

## Problema

Uma sessão nasce e renasce por cerca de 17 entradas e 25 lançadores, metade no Python e metade no
Rust. Criar, retomar, trocar de modo, trocar de conta, reabrir em bypass, recarregar e restaurar
depois do reboot montam cada um a própria linha de comando e o próprio ambiente. Daí vêm os 47 bugs
classificados. Exemplos:
- o Codex volta em Full Access depois do reboot;
- a sessão reabre sem modo de permissão quando o rodapé está ilegível;
- `CP_PROVIDER` vazio no `/resume`;
- a tela diz "feito" e a sessão morreu.

## Objetivo

Um caminho só, no Rust:

```
SessionOpenRequest (o que o cliente mandou)
   └─ resolve_open() ── herança, padrões, regra dos 95%, validação ──▶ SessionSpec (tudo decidido)
                                                                          │  gravado com a sessão
open_session(spec) ──▶ plano de lançamento (argv, ambiente, pasta) ──▶ terminal (tmux/psmux) ou processo sem terminal
reopen_session(nome, SessionChange) = open_session(spec gravado ⊕ mudança)
```

Todo cliente chama a mesma coisa: app nativo, PWA, Expo, `hangar-send`, MCP, voz, `orq`,
`hangar-codex`, os comandos `claude`/`pi`/`omp`/`kimi` digitados no terminal e o restore depois
do reboot. O Python deixa de abrir e de reabrir sessão. O resto do backend Python não muda.

**"Abrir certo" é investigado, não suposto (usuário, 2026-10-15).** O modal "+" e a Nova
conversa são como o usuário abre, não uma referência comprovada. A definição de sessão correta
sai de uma matriz: tudo que o Hangar oferece e que depende de como a sessão nasceu (plugins,
MCP `hangar`, Jev, navegador embutido, Computer Use, hooks de estado, ponte do plugin,
statusline, conta, permissão, modelo, motor, …) × cada origem de abertura. A origem mais próxima
do correto vira o ponto de partida; o `resolve_open()` sem parâmetro nenhum entrega **tudo**.
Toda origem abre **exatamente igual**: modal, Nova conversa, celular, voz, uma sessão abrindo
outra (mesmo de outro computador), MCP, `hangar-send` e o `claude` digitado no terminal.
Consequências:
- O que hoje só algumas telas preenchem sozinhas passa para o `resolve_open()`. Quem omite um
  campo recebe o padrão completo.
- Todo cliente aceita o conjunto inteiro de parâmetros.
- O "+" sem escolha de modo nasce no padrão da conta (D-010); escolher bypass continua valendo.

**O lançador também é um comando de terminal.** `resolve_open()` e o plano de lançamento ficam
numa biblioteca do Rust usada pelo servidor e por um comando (`hangar-open`, nome a fechar na
Task 2). O `claude`/`pi`/`omp`/`kimi` digitado chama esse comando:
- com o servidor de pé, o servidor abre e registra a sessão;
- com o servidor fora do ar, o próprio comando abre a sessão igual, e o servidor a adota quando
  voltar.

Assim, o terminal nunca depende do Hangar estar no ar para abrir certo. Fica de fora (roda o CLI
cru, como hoje): `-p`/modo não interativo, entrada por pipe, `--resume` explícito e flag que o
pedido não conhece.

## Tipos

Nomes escolhidos para não colidir com o que já existe no `hangar-server`: `OpenRequest` é da voz
(`voice/organizer.rs:606`), `Provider` existe três vezes (`accounts/types.rs:9`,
`transcript/mod.rs:25`, `session_write/table.rs:6`), `gateway::open` (`gateway.rs:739`) e
`enum Reopen` (`gateway.rs:111`) são do runtime. O enum novo de provider é `AgentProvider`; o
`Provider { Claude, Codex }` do `session_write` passa a derivar dele.

### `SessionOpenRequest`: o pedido, no fio

É o mesmo JSON de hoje (`CreateBody`, 23 campos), mais `inherit`. Clientes antigos continuam
valendo.

| Campo | Tipo | Obrigatório | Quando omitido |
|---|---|---|---|
| `name` | texto não vazio | sim | — |
| `cwd` | caminho não vazio | sim | — |
| `provider` | `claude` \| `codex` \| `pi` \| `omp` \| `kimi` | não | padrão do servidor (`_default_session_provider`) |
| `headless` | bool | não | herda da criadora; senão `headless_default` |
| `config_dir` | caminho de conta Claude | não | herda da criadora; senão a padrão; regra dos 95% (D-003) |
| `codex_account` | id | não | padrão; se ela não estiver conectada, a primeira conectada, com aviso |
| `omp_profile` | nome | não | sem perfil |
| `engine`, `engine_account` | nome no `engines.json` | não | conta Anthropic |
| `model`, `effort`, `service_tier` | validados por provider | não | padrão do binário/conta |
| `permission_mode` | enum por provider | não | herda da criadora; senão o padrão da conta |
| `subagent_model` | texto | não | nenhum |
| `claude_customizations` | objeto | não | nenhuma |
| `jev` | bool | não | `jev_padrao` do servidor |
| `read_only` | bool | não | `false` |
| `branch`, `new_branch`, `base` | worktree | não | sem worktree |
| `remember_provider` | bool | não | `false` |
| `initial_prompt` | texto | não | nenhum; quando vier, é entregue em todo provider (S-40) |
| `creator` | nome de sessão | não | sem herança |
| `inherit` (novo, D-001) | bool | não | `true` com `creator`; `false` faz o omitido cair no padrão da conta |

### `SessionSpec`: a sessão decidida, gravada

Depois do `resolve_open()` nada fica implícito, e cada campo tem tipo fechado:

- `provider`: enum `AgentProvider`.
- `surface`: enum `Terminal | Headless`.
- `account`: enum
  - `Claude { config_dir }`
  - `Codex { account_id }`
  - `Omp { profile }`
  - `Engine { name, account }`
  - `Default`
- `account_source`: `Explicit | Inherited | Default | Quota`. No fio (`CreatedSessionInfo`,
  `models.py:224`) continua como hoje: `"inherited"`, `"quota"` ou ausente.
- `model`, `effort`, `service_tier`, `permission_mode`: valores já validados, ou ausentes.
  Ausente quer dizer "o padrão do binário".
- `subagent_model`, `customizations`, `jev`, `read_only`.
- `worktree`: o resultado da criação, quando houve.
- `creator`.
- `key`: chave estável da sessão.
- `created_at`.

O spec é gravado num arquivo novo por sessão, indexado pela `key` (não pelo nome, que muda no
rename). A Task 2 fecha o lugar e o formato. Nesta entrega os sidecars de hoje
(`claude-headless/`, `codex-sessions/`) **não perdem campo nenhum**: assim um `git revert` volta
sem reabrir sessão em modo errado. Quem mais escreve hoje e precisa de contrato:
- o `hangar-codex-tui`, que lê e grava `permission_mode` do sidecar Codex (`:636-684`);
- o rename, que ainda é do Python (`runtime_coordinator.py:1799`). O modo de permissão e o modelo que a própria CLI muda durante a sessão são
gravados no spec quando o Rust os observa (S-02). Assim, reabrir nunca volta ao valor velho.

### `SessionChange`: o que uma reabertura muda

São só os campos mudáveis: `surface`, `account`, `permission_mode`, `model`, `effort`,
`service_tier`, mais o motivo (`mode_switch`, `account_switch`, `bypass`, `reload`, `resume`,
`reboot_restore`, `park_wake`, `limit_switch`). Uma regra só para todos, sem nunca ter dois
processos na mesma conversa (S-17):
1. prepara a nova parada (argv, ambiente, auxiliar), como o Rust faz hoje (`gateway.rs:1370-1396`);
2. encerra a antiga e confirma que ela saiu;
3. dá a partida na nova e confirma que ela está viva;
4. grava o spec novo.

Falha antes do passo 2: nada muda. Falha depois: a sessão volta pelo spec antigo e o erro sai com
código.

## Regras (das decisões)

- **D-001 Herança:**
  - com `creator`, o que veio omitido (conta, modo de permissão, com/sem terminal) vem da
    criadora;
  - o que veio informado vence;
  - `inherit:false` faz o omitido cair no padrão da conta;
  - vale igual para todo provider que tenha o conceito.
- **D-002 Troca de conta no limite:** a sessão que esgota a janela de 5 h ou a de 7 dias é
  reaberta na conta com mais folga, e recebe uma mensagem para continuar. Sem rodar em
  círculo: com todas as contas no limite, avisa e espera. Sessão em motor fica de fora.
- **D-003 Os 95% na abertura:** vale a mesma regra para todo cliente, e o aviso aparece em toda
  tela.
- **D-006 Estacionar:** a sessão Claude sem terminal parada há 65 min, sem nada em aberto, é
  encerrada. A próxima mensagem a reabre pelo spec.
- **D-007 MCP:** o servidor `/mcp` vai para o Rust com as mesmas 14 tools.
- **D-008 Python:** o Python de cada parte é apagado no mesmo PR, depois que o Rust dela estiver
  provado. Sem reserva Python. No modo `python` do Supervisor, abrir e reabrir respondem
  `session_open_needs_rust_server`.

## Erros

Um conjunto só de códigos (`erro_*`), igual para todos os clientes. Os erros novos do Rust ganham
frase no `errosApi.ts` e no nativo (S-38). Cada falha de lançamento grava no diário a etapa, o
código e o stderr resumido do tmux ou do processo (S-15, S-35).

## Pontos levantados pela revisão do plano (a cobrir)

- **Convidado e Connect:** o login de convidado é autenticado no Python
  (`guest_user_gate.py:182-195`) e o `guests.json` tem trava só no Python
  (`guest_users.py:170-199`). Criar como convidado e pela porta 8768 precisa de caminho sem
  Rust → Python → Rust e sem dois escritores.
- **Restore do reboot:** o resurrect recria os panes antes de o backend subir
  (`tmux-claude-resume.sh:29-31,286`). O restore passa a ser do Rust na subida, a partir dos
  specs; o resurrect pula as sessões do Hangar.
- **Recuperação quando o Rust cai de vez:** hoje o coordenador Python assume as sessões
  (`runtime_coordinator.py:377-395, 407-466, 791-833, 1659`). Mexer nisso exige decisão do
  usuário (CLAUDE.md, Supervisor). Pergunta curta antes da Task que toca o coordenador.
- **Modo `python` depois de um pull com Rust velho:** abrir para de funcionar. A atualização
  compila o Rust antes de reiniciar, e `session_open_needs_rust_server` aparece no app e no
  diário.
- **Chamadores fora do plano original:**
  - `GET /api/sessions/creation-progress` (`api.py:2229`);
  - `remember_provider` gravando `runtime-config.json`, hoje só o Python grava;
  - `hangar-conta --prep` sem o cwd (`hangar-conta:36-39`);
  - `python3` no Windows.

## O que continua fora do Rust

- **Porta do Hangar Connect (8768):** o Python confere quem chamou e repassa ao Rust, num sentido
  só.
- **Programas que rodam fora do backend e que o Rust chama:**
  - `hangar-codex-tui`, que roda dentro do terminal do Codex;
  - `hangar-conta --prep`.
- **O resto do backend Python:** histórico, eventos, estatísticas e estado de Pi/omp/Kimi pela
  tela.
