# Grupos entre máquinas e saída do Python — plano de implementação

> **For agentic workers:** execute Task a Task (inline ou por subagentes, conforme a modalidade escolhida). Steps usam checkbox (`- [ ]`); marque `- [x]` ao terminar cada um.

Status: ready-for-agent (aprovado em 19/10; modalidade: subagentes; worktree `~/Projetos/hangar-grupos-federacao`)

**Goal:** (A) nada de grupos fica no Python: texto do protocolo, reinjeção depois de `/clear` e toda
escrita de grupo são do Rust, sem volta Rust↔Python; no modo `python` operação de grupo responde
503 `groups_need_rust_server`. (B) um grupo junta N sessões em M máquinas do próprio dono, com uma
máquina dona e um `gid` comum, aceitando membro de fora (par externo) como o grupo local; par 1:1
antigo vira grupo sozinho. (C) nativo, PWA e app Expo mostram e montam esse grupo dentro do modo de
agrupar escolhido, com selo em cada membro.

**Architecture:** módulo `groups` do `hangar-server` ganha o texto do protocolo (`groups/text.rs`),
o subcomando `hangar-server pair-context` (reinjeção sem servidor), o registro do grupo entre
máquinas na dona (`GroupRecord` em `.hangar-pair/groups/<gid>.json`), uma fila em disco
(`.hangar-pair/groups/outbox.json`) com um trabalhador por máquina de destino, e as rotas
`/api/groups/{gid}/*` entre máquinas do dono. O Python fica só com repasse num sentido na 8768,
leitores do arquivo de grupo e o instalador do hook. Clientes leem um modelo global de grupos
(duas cópias, TS em `packages/core` e Rust no nativo) testado por uma fixture única.

**Tech Stack:** Rust (axum, tokio, serde_json, reqwest, sha1_smol, chrono) em `crates/hangar-server`
e `crates/hangar-api`; Python 3.14 + FastAPI em `backend/app` (só remoção e repasse); GPUI Kit em
`desktop-native`; Svelte 5 em `frontend`; TS em `packages/core`; Expo em `mobile`.

**Fontes** (pasta `.superpowers/sdd/2026-10-19-grupos-federacao/`, fora do Git):
[`decisoes.md`](decisoes.md) (decisões finais do dono), [`escopo.md`](escopo.md),
[`inventario-pair.md`](inventario-pair.md) (PAIR-01..47), [`inventario-texto-hook.md`](inventario-texto-hook.md)
(TXT-01..14, HOOK-01..14), [`inventario-ponte.md`](inventario-ponte.md) (BRG-01..35),
[`desenho-federacao.md`](desenho-federacao.md), [`desenho-clientes.md`](desenho-clientes.md).
Plano antigo: `docs/migracao-rust/parte6-grupos/plano.md` (Tasks 1–8 feitas no PR #124; 9–21
substituídas por este). Linhas citadas conferidas na `main` local `0e6c1e566`; cada Task reconfere
as dela na worktree antes de codar.

**Desvios do desenho de servidor que este plano fixa** (decisões do dono vencem o desenho):
- `desenho-federacao.md` §5 recusava par antigo; **I-8B** manda converter sozinho (Task 11). O
  código `erro_grupo_par_antigo` não existe.
- Renomear membro de grupo entre máquinas **não** é recusado: vai à dona pela fila (Task 9).

## Lotes

- **Task 0** primeiro, sozinha (cria a worktree).
- **Parte A:** Task 1 → Task 2 → Task 3. Task 4 depende só da Task 1 e corre junto da 2/3.
  Task 5 depois de 2, 3 e 4. Task 6 depois da 5.
- **Parte B:** Task 7 corre junto da Task 2, mas as duas tocam `groups/mod.rs`: a Task 2 só
  acrescenta `pub mod text;` e entra primeiro; a Task 7 rebaseia sobre ela antes de mexer na subida
  de `mod.rs`. Task 12 depende só da 7. Task 8 depende de 7 e 2 (o texto precisa da regra do
  contrato remoto). Tasks 9, 10 e 11 depois da 8, em paralelo entre si (arquivos: `exit.rs`/`sweep.rs`;
  `routes.rs` aviso e contrato; `convert.rs`). Tasks 9 e 12 tocam `groups/service.rs`: a 12 entra
  antes da 9 (ou a 9 rebaseia sobre ela); nunca as duas abertas ao mesmo tempo. Task 13 depois de
  5, 8, 9, 10 e 11.
- **Parte C:** Task 14 depois da 12. Tasks 15, 16 e 17 depois da 14, em paralelo (nativo, PWA,
  Expo). Task 18 acompanha cada uma delas (as chaves de um cliente entram no commit dele) e fecha
  com a varredura das sobras.
- **Task 19** por último.
- Um escritor por árvore: Tasks paralelas usam worktree própria a partir da ponta da branch, cada
  uma com `CARGO_TARGET_DIR` próprio; no máximo 3 abertas e no máximo 2 `cargo` na máquina.

## Global Constraints

- **Base:** worktree a partir da `origin/main` criada (Task 0) **depois** que os 26 commits locais
  da sessão `atualizacao` forem publicados. Nunca a partir da `main` local com commits não
  publicados (já arrastou commits alheios num PR). Branch `feat/groups-across-machines`.
- **Commits** na branch, mensagens descritivas em inglês (`feat(groups): …`, `refactor(pair): …`);
  `git add` por caminho, nunca `-A`. **Push só com autorização do dono.**
- **Testes (regra do projeto):** cada Task escreve os testes dela, TDD RED → GREEN por fatia, mas
  roda só quando o dono autorizar na abertura da execução, e então só os focados. Nunca contra o
  backend vivo (porta, config dir e `.hangar-pair` temporários). Comandos:
  - `cd backend && uv run pytest tests/<x>.py`
  - `cd crates && nice -n 19 ionice -c 3 env CARGO_BUILD_JOBS=3 CARGO_TARGET_DIR=<worktree>/crates/target cargo test -p hangar-server --test it <x>` (ou `--lib groups::`).
    O `hangar-server` tem `autotests = false` (`Cargo.toml:7`): o único alvo de teste é `it`; todo
    teste Rust novo é `crates/hangar-server/tests/it/<x>.rs` com `mod <x>;` em `tests/it/main.rs`.
    `--test <x>` sozinho não existe.
  - `npm --prefix frontend run check`; `cd frontend && npx vitest run <arquivo>`;
    `cd packages/core && npx vitest run <arquivo>`; `cd mobile && npx vitest run <arquivo>`
    (`mobile/package.json:85` usa vitest)
  - `cd desktop-native && nice -n 19 ionice -c 3 cargo test <filtro>` (target próprio)
  - Relato de cada fatia: `RED: <comando> -> <linha da falha>` e `GREEN: <comando> -> passou`.
- **Python não cresce:** saldo de linhas Python por Task ≤ 0 (só remoção e troca). Exceção única
  já prevista: a troca do comando do hook no `hook_installer.py` (Task 3), que deve sair com saldo
  ≤ 0 contando a remoção do `PAIR_HOOK`.
- **Sem reserva Python:** no modo `rust`/`pending` nada no Python grava em `.hangar-pair/`; no modo
  `python` toda rota de grupo responde 503 `groups_need_rust_server`. Erro numa operação de grupo
  no Rust é erro com código, nunca repasse ao Python.
- **Contrato interno:** mudou rota `/internal`, variável do filho ou campo da saúde → sobe
  `RUST_SERVER_PROTOCOL` (`backend/app/rust_server.py:35`, hoje 83) e `INTERNAL_PROTOCOL`
  (`crates/hangar-server/src/lib.rs:69`) juntos, no mesmo commit, para o próximo livre na hora de
  juntar, e o teste fixo do protocolo (`crates/hangar-server/tests/it/proxy.rs:36`,
  `assert_eq!(hangar_server::INTERNAL_PROTOCOL, 83)`).
- **Sem rede nem entrega sob o lock de grupo:** sob o lock só disco e fila.
- **Corpo estrito** nas rotas novas entre máquinas: `deny_unknown_fields`, `protocol: 1`, resposta
  sempre com `server_id`.
- **Confiança:** máquina do `peers.json` = mesmo dono (token de dono). Membro de fora só ganha
  acesso na máquina onde o par foi feito (I-6A). Convidado (8766) não ganha rota nova; 8768 só
  repassa.
- **Códigos novos** com frase em `messages/pt.json` e `messages/en.json` e entrada em
  `packages/core/src/errosApi.ts` no mesmo commit (lista na Task 18).
- **Desempenho:** nenhum laço novo sem entrada que mude (trabalhador da fila só com item); I/O de
  arquivo em `spawn_blocking`; sem fsync sob lock; canais com limite.
- **Diário e log:** só código, nome de sessão, id de máquina e nome de campo; nunca texto de
  recado, tarefa ou contrato.
- **Identificador novo em inglês**; comentário curto em português, sobre o porquê.
- **Ler antes:** "Regras vigentes" de `docs/decisoes/windows.md` (Tasks 3, 7, 8) e de
  `docs/decisoes/harnesses.md` (Tasks 2, 3, 4); entradas "Grupos: o Rust grava", "Grupo: o
  protocolo é do HOOK, a saída é de UMA esteira, e o anti-loop é do backend" (`plataforma.md:329`,
  item do SessionStart em `:334`) e "Grupo de 1 só existe no grupo `orq`…" de
  `docs/decisoes/plataforma.md` (Tasks 2, 5, 8, 9); Coding Guides do `gpui-kit` e Design Guides do
  `gpui-kit-design-guides` (Task 15); regras de iOS do CLAUDE.md (Task 17).
- **Fases da `migrar-python-rust`:** `conferencia.md` e `medicao.md` ficam em
  `.superpowers/sdd/2026-10-19-grupos-federacao/`; só a sessão coordenadora escreve neles. A
  `conferencia.md` nasce na Task 1 (esqueleto com todos os IDs) e é preenchida a cada Task; a Task 6
  só a fecha.
- **Nome do contrato remoto** (fixo, igual nas Tasks 2, 10 e 13): tool MCP `contract` (ler e
  gravar) e `hangar-send --contrato [--gravar <arquivo>]`; rotas `GET|PUT
  /api/sessions/{name}/pair/contract`.
- **Retentativa entre máquinas** (Tasks 7–11): tenta de novo só em transporte, 503
  `groups_need_rust_server`, 409 `busy`, 429, 401, 408 e `PeerError::Unknown` (este com aviso
  `grupos.peer_desconhecido` no diário, nunca descartado). Todo outro 4xx com código é recusa
  definitiva. `OldVersion` só é inferido de sinal específico: 404 **sem** `code` no corpo vindo de
  `/api/groups/*`, ou campo `protocol` ausente/menor na resposta de `GET /api/groups/{gid}`; 404
  com código nunca vira versão antiga.

## Review Focus

1. **Máquina que não responde no meio de uma entrada de N membros** (casa confirma `b`, lab não
   responde para `c`): a resposta diz que `b` entrou e `c` não; quando lab volta, não sobra sidecar
   de `c` lá. Teste `join_partial_when_one_server_is_down` (Task 8).
2. **Envio atrasado, repetido ou fora de ordem:** nenhum sidecar nasce fora do `joining`, ninguém
   que saiu volta, envio velho depois de dissolver é ignorado. Testes
   `push_never_creates_sidecar_outside_joining`, `late_push_does_not_resurrect_pending_leave`,
   `stale_push_after_dissolve_is_ignored` (Task 8).
3. **Mesmo nome em duas máquinas** (`a` em casa e `a` em lab): dois membros em todo lugar. Testes
   `same_name_on_two_servers_are_two_members` (Task 8) e caso `same_name_two_servers` da fixture
   (Task 14).
4. **Chave do `peers.json` diferente do `CP_SERVER_ID` da outra máquina:** recusa citando os dois,
   nada gravado. Teste `key_mismatch_is_refused_before_any_write` (Task 7).
5. **Conversão do par antigo dos dois lados ao mesmo tempo** (I-8B): mesmo `gid` e mesma dona nos
   dois, sem dois registros. Teste `both_sides_convert_to_the_same_group` (Task 11).
6. **Membro de fora num grupo entre máquinas** (1A, I-6A, I-7A): o acesso dele continua só na
   máquina do par; aviso de grupo chega a ele uma vez, com o mesmo `notice`. Testes
   `outside_member_access_stays_on_its_machine`, `notice_reaches_outside_once` (Tasks 8 e 10).
7. **Reinjeção com o servidor parado** (I-2A): `pair-context` devolve o texto certo sem rede, e
   nunca trava a abertura. Teste `pair_context_works_without_server` (Task 3).

---

### Task 0: Worktree, plano no lugar e plano antigo substituído

Status: ready-for-agent

**Files:**
- Create: `docs/migracao-rust/parte6-grupos/plano-federacao.md` (cópia deste plano)
- Modify: `docs/migracao-rust/parte6-grupos/plano.md` (cabeçalho das Tasks 9–21: "substituída por
  `plano-federacao.md`", sem apagar o texto)
- Modify: `docs/migracao-rust/README.md:79` ("Grupos feitos (PR #124)" → "Grupos 1a feita (PR #124);
  grupo entre máquinas e saída do Python em `parte6-grupos/plano-federacao.md`")

**Invariante:** a branch nasce da `origin/main` com os commits da `atualizacao` já publicados.

- [x] **Step 1: Conferir a base**: `git fetch origin && git rev-list --count origin/main..main` = 0
  (os 26 publicados) e `git status` limpo no checkout principal. Diferente disso: parar e avisar o
  dono.
- [x] **Step 2: Criar a worktree**: `git worktree add ~/Projetos/hangar-grupos-federacao -b
  feat/groups-across-machines origin/main`; `CARGO_TARGET_DIR` próprio; `rust-analyzer` desligado.
- [x] **Step 3: Plano no lugar**: copiar este arquivo para `plano-federacao.md`, marcar as Tasks
  9–21 do `plano.md` como substituídas, corrigir o README.
- [x] **Step 4: Commit** — `docs(groups): plan for groups across machines and the Python exit`.

---

## Parte A — Python fora dos grupos

### Task 1: Caracterização do Python antes de apagar

Status: ready-for-agent
Revisão: base — motivo: as fixtures são a especificação das Tasks 2, 3 e 5.

**Files:**
- Create: `backend/tests/fixtures/contract/pair_text/` (um `.json` por variante + `README.md` com o
  commit de origem e o comando que gerou)
- Create: `backend/tests/fixtures/contract/pair_hook/` (entrada: sidecar, `external_pairs.json`,
  ambiente; saída: stdout do hook)
- Create: `backend/tests/fixtures/contract/groups_python_mode/` (status e corpo das 6 rotas no modo
  `python`, só para registrar o que deixa de existir)
- Modify: `backend/tests/fixtures/contract/gen_golden.py` (gerador das três pastas; hoje o script
  não lê argumentos — a flag `--only` é criada aqui)
- Create: `.superpowers/sdd/2026-10-19-grupos-federacao/conferencia.md` (esqueleto: uma linha por
  ID PAIR-01..47, TXT-01..14, HOOK-01..14, BRG-01..35, situação em branco; preenchida pelas Tasks
  2–5 e fechada na 6)

**Responsabilidade:** gravar o que o Python responde **executando-o**, nunca lendo o código. Cada
fixture leva `origin_commit` e `command`. Fixtures nunca são editadas à mão.

**Variantes obrigatórias** (IDs do inventário): texto de grupo com e sem tarefa (TXT-02, TXT-12),
harness claude/codex/pi/omp/kimi do destinatário (TXT-03, TXT-05), com e sem contrato (TXT-07),
`orq` (TXT-10), externo (TXT-11), surrogate na tarefa; hook: sem grupo (HOOK-02), sidecar torto
(HOOK-03), `orq` sozinho (HOOK-06), sem peers (HOOK-07), par externo direto e por outro membro
(HOOK-08), `external_pairs.json` ausente e ilegível (HOOK-09), filha ligada e pai que saiu
(HOOK-10), gid vazio (HOOK-11), resolução de nome pelos três caminhos (HOOK-04).

- [ ] **Step 1: Gerador**: criar a flag `--only <pasta,…>` no `gen_golden.py` (sem ela, gera tudo
  como hoje) e estendê-lo para as três pastas, com `pair_dir` e HOME temporários; o hook roda como
  processo (`python backend/hooks/pair_hook.py <pair_dir>`) com o ambiente da variante.
- [ ] **Step 2: Gerar e conferir** que cada variante acima tem arquivo; `README.md` com commit e
  comando; criar o esqueleto da `conferencia.md`.
- [ ] **Step 3: Commit** — `test(groups): record the Python protocol text, hook and python-mode routes`.

**Prova:** `cd backend && uv run python tests/fixtures/contract/gen_golden.py --only pair_text,pair_hook,groups_python_mode` → arquivos gerados, `git diff --stat` só nessas pastas.

---

### Task 2: Texto do protocolo no Rust

Status: ready-for-agent
Revisão: risco — motivo: contrato com os agentes (todo membro lê) e ponto de que Tasks 3 e 8 dependem.

**Files:**
- Create: `crates/hangar-server/src/groups/text.rs`
- Modify: `crates/hangar-server/src/groups/deliver.rs` (`protocol_text` passa a chamar `text.rs`
  em processo; some o `PythonOrq.post("pair/text")` de `deliver.rs:29`)
- Modify: `crates/hangar-server/src/groups/mod.rs` (só `pub mod text;`; entra antes da Task 7)
- Test: `crates/hangar-server/tests/it/groups_text.rs` (+ `mod groups_text;` em `tests/it/main.rs`)

**Interfaces (produz):**

```rust
pub enum Kind { Group, Orq, External }
pub struct ContractLine { pub path: Option<PathBuf>, pub remote_owner: Option<String> }
pub struct TextArgs {
    pub me: String, pub others: Vec<String>, pub task: String,
    pub harness: BTreeMap<String, String>, pub contract: ContractLine,
    pub outside: Vec<OutsideRef>,          // membros de fora: alias::sessao + dono
    pub peer: String, pub owner: String,   // só Kind::External
}
pub fn render(kind: Kind, args: &TextArgs) -> String;
```

`ProtocolArgs` (deliver.rs) passa a ser convertido em `TextArgs`; o campo `contract_remote` vira
`ContractLine.remote_owner`.

**Regras novas (decisões):**
- **I-3A:** membro local de grupo com par externo recebe o texto de **grupo** seguido do bloco
  **externo** (um texto só), no join e na reinjeção. Antes o hook devolvia só o externo (D-TXT-1).
- **I-4A:** linha do contrato: membro na dona → caminho local (TXT-07); membro de máquina própria
  fora da dona → "Decisões que o grupo consulta ficam com a máquina `{owner}`: leia e grave pela
  tool `contract` do MCP ou `hangar-send --contrato`" (nome fixo nas Global Constraints, igual nas
  Tasks 10 e 13); membro de fora → sem linha (D-TXT-3).
- `Kind::Orq` portado só para a reinjeção (D-TXT-2).

**Invariantes:** saída idêntica às fixtures da Task 1 para toda variante que não muda por decisão;
cabeçalho `[painel: grupo de trabalho]` (TXT-01); nunca lista de membros (TXT-09).

**Fecha:** TXT-01..14, D-TXT-1, D-TXT-2, D-TXT-3, I-3A, I-4A.

- [ ] **Step 1: Testes** que leem `backend/tests/fixtures/contract/pair_text/*.json` e comparam
  com `render`; testes novos para I-3A (`mixed_group_gets_group_and_external_text`) e I-4A
  (`contract_line_by_member_kind`: dona, máquina própria, de fora); proptest de `task`/nomes sem
  pânico.
- [ ] **Step 2: Rodar e ver falhar** (asserção, não compilação).
- [ ] **Step 3: Implementar** `text.rs` e trocar `deliver.rs` para usá-lo em processo.
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** — `feat(groups): render the group protocol text in Rust`.

**Prova:** `cd crates && … cargo test -p hangar-server --test it groups_text` → todos verdes; `grep -rn "pair/text" crates/hangar-server/src` → nada.

---

### Task 3: Reinjeção pelo binário (`hangar-server pair-context`)

Status: ready-for-agent
Revisão: risco — motivo: roda na abertura de toda sessão Claude, nas duas plataformas; falha aqui
trava ou empobrece toda sessão.

**Files:**
- Create: `crates/hangar-server/src/groups/context_cmd.rs`
- Modify: `crates/hangar-server/src/main.rs` (despacho do subcomando antes de subir o servidor, como
  `open`/`resolve` em `main.rs:6`)
- Modify: `backend/app/hook_installer.py` (o comando do `SessionStart` passa a ser
  `"<hangar-server>" pair-context "<pair_dir>" || exit 0`; some `PAIR_HOOK`; caminho do binário
  pelo mesmo `rust_bins.find_bin("hangar-server", "CP_RUST_SERVER_BIN")` de `rust_server.py:71`;
  entrada antiga com `pair_hook.py` é trocada, não duplicada; **binário ausente**: o instalador
  remove a entrada antiga do `pair_hook.py`, não instala nenhuma e registra
  `grupos.hook_sem_binario` no diário — nunca volta ao hook Python)
- Delete: `backend/hooks/pair_hook.py`, `backend/tests/test_pair_hook.py` (só depois dos pares Rust
  listados na `conferencia.md`)
- Test: `crates/hangar-server/tests/it/groups_context_cmd.rs` (+ `mod` em `tests/it/main.rs`)

**Comportamento (HOOK-01..14 + decisões):**
- Lê `<pair_dir>/<sanitize(nome)>.json` e `<pair_dir>/external_pairs.json`; monta o texto com
  `groups::text::render`; imprime `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`
  com não-ASCII escapado (`\uXXXX`, igual ao `json.dumps` do Python: o cmd do Windows não troca
  página de código no meio).
- Nome da sessão: sidecar sem terminal com `key` = `CP_SESSION_KEY` em `~/.hangar/claude-headless/`;
  `TMUX_PANE` que aparece **uma** vez em `tmux list-panes -a` (o psmux repete `%N`);
  `CP_SESSION_NAME` com `tmux has-session -t =nome`; prazo 3 s no tmux (HOOK-04).
- Nenhuma rede, nenhum token; qualquer erro → sem saída e código 0 (HOOK-03).
- `fed` presente: linha de contrato da Task 2 (I-4A, D-TXT-4); grupo misto: texto da I-3A.
- Filha ligada não recebe (HOOK-10); `orq` sozinho recebe a versão curta (HOOK-06).

**Fecha:** HOOK-01..14, D-TXT-4, I-2A, BRG-34.

- [ ] **Step 1: Testes** que rodam o binário como processo contra cada entrada de
  `backend/tests/fixtures/contract/pair_hook/` e comparam o stdout (menos o que I-3A/I-4A mudam,
  com teste próprio); `pair_context_works_without_server` (nenhuma porta aberta);
  `pair_context_never_fails_the_open` (sidecar torto, pasta inexistente, tmux ausente → rc 0, sem
  saída); em Python, `test_installer_without_binary_installs_no_pair_hook`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** o subcomando e trocar o instalador.
- [ ] **Step 4: Rodar.** Esperado: PASS. `cd backend && uv run pytest tests/test_hook_installer.py`
  (ou o arquivo que testa `ensure_pair_hook_installed`) verde com o comando novo.
- [ ] **Step 5: Windows**: na DELPHI-02 (clone separado, nunca o Hangar vivo de lá), instalar o hook
  num config dir temporário e abrir uma sessão de teste: o `additionalContext` chega; caminho com
  espaço e `.exe` entre aspas.
- [ ] **Step 6: Commit** — `feat(groups): reinject the group protocol from the Rust binary`.

**Prova:** `cargo test -p hangar-server --test it groups_context_cmd` verde; `grep -rn "pair_hook" backend/` → só o histórico de testes removidos (nada).

---

### Task 4: Sem ida e volta entre Rust e Python

Status: ready-for-agent
Revisão: risco — motivo: concorrência sob o lock de grupo e contrato interno Rust↔Python.

**Files:**
- Modify: `crates/hangar-server/src/groups/routes.rs` (`routes.rs:84-92` `to_python`, `:200`, `:340`;
  o `fallback(pass_any)` de `:47-51` sai)
- Modify: `crates/hangar-server/src/groups/legacy.rs` (`:102`, `:137`)
- Modify: `crates/hangar-server/src/groups/bridge.rs` (`group.orq_associate` e `group.leave`)
- Modify: `crates/hangar-server/src/session_write/bridge.rs` (`:152-175`: depois de repasse bem
  sucedido de fechamento, chamar `leave_and_notify`)
- Modify: `backend/app/api.py` (`:4696-4706` `orq/grupo` manda os fatos do `orq` junto), 
  `backend/app/registry.py` (`:2607-2622` `_clear_pair` sem `group.leave`), `backend/app/internal_api.py`
  (`/internal/orq/associate` sai se ficar sem chamador)
- Test: `crates/hangar-server/tests/it/groups_routes.rs` (existe; `mod groups_routes;` em
  `it/main.rs:151`), `backend/tests/test_groups_bridge.py` (só remoção/ajuste)

**Regras:**
- Corpo que o Rust não aceita (campo desconhecido, tipo errado, surrogate solto) → 422
  `erro_corpo_invalido`, sem repasse (BRG-10, PAIR-12, I-1A).
- `orq/grupo` (I-5A): o Python lê os fatos do `orq` que o Rust pedia em `/internal/orq/associate`
  e os manda no corpo de `group.orq_associate`; o Rust aplica sob o lock sem chamar o Python
  (BRG-20). As consultas `group-phase`, `promote` e `is-orchestrator` continuam Rust→Python num
  sentido (BRG-21..23), fora de pedido vindo do Python.
- `group.leave` (BRG-25, volta 3): fechamento repassado (Pi/omp/Kimi) termina com o Rust chamando
  `leave_and_notify` depois do repasse que deu certo; o `registry` não chama mais a ponte.
- Volta 4 (`group.rename` → `link_return::renamed`): conferir que não toca o Python; se tocar,
  mesma solução (fato no corpo).

**Fecha:** BRG-10, BRG-20, BRG-25, PAIR-12, voltas 1–5 do `escopo.md`.

- [ ] **Step 1: Testes**: `unknown_field_is_422_without_python` (Python falso conta chamadas = 0);
  `surrogate_task_is_422`; `orq_associate_never_calls_python`; `repassed_close_leaves_the_group`
  (sessão Pi fechada pelo repasse sai do grupo e avisa).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS; `uv run pytest tests/test_groups_bridge.py tests/test_orq_group.py` verde.
- [ ] **Step 5: Contrato interno** mudou (`/internal/orq/associate`) → subir os dois protocolos.
- [ ] **Step 6: Commit** — `fix(groups): answer bad bodies and orq association without a Python round trip`.

---

### Task 5: Apagar o Python dos grupos

Status: ready-for-agent
Revisão: risco — motivo: remove o único caminho do modo `python` e mexe no repasse da 8768.

**Files:**
- Delete: `backend/app/pair_texto.py`, `backend/tests/test_pair_texto.py`
- Modify: `backend/app/pair.py` — saem `join_group`, `restore`, `leave`, `rename_pair`,
  `dissolve_lone_orq`, `referenciados_locais`, `GroupsOwnedByRust`, `PairMixError`, `TaskConflito`
  e o que só eles usam. **Ficam** (leitores, peça F): `PairLink.get`, `_pair_dir`, `_arquivo_dir`,
  `contract_path_for`.
- Modify: `backend/app/api.py` — as 6 rotas de grupo (`:4176`, `:4306`, `:4339`, `:4386`, `:4789`,
  `:4893`) viram só repasse num sentido ao Rust (8768); no modo `python` respondem 503
  `groups_need_rust_server`; saem `_group_text`, `_deliver` de grupo, `_avisar_saida`,
  `_recusa_orq`, `_group_estourou`, o laço `_pair_sweep_loop` (`:1135-1162`), a leitura do
  `PairLink` no kill (`:2209`), o handler de `GroupsOwnedByRust` (`:553`)
- Modify: `backend/app/registry.py` — saem `_rename_pair_python` (`:965-969`), `sweep_pairs`,
  `_varrer_pares_mortos`, o atributo de classe `_pair_ausencias` (dict em `:989`, usado em
  `:2658-2664`), `_encerrar_pares_externos` (`:170`) se ficar sem chamador, o ramo Python de
  `_clear_pair`
- Modify: `backend/app/groups_bridge.py` — fica só o repasse `group.route` da 8768 e `group.rename`
  (a rota de renomear é Python; chamada num sentido); saem `_await_rust`/`pending` se nada mais os
  usar (BRG-01, 02, 03, 07)
- Modify: `backend/app/internal_api.py` — sai `/internal/pair/text` (`:295-318`)
- Delete/Modify tests: `test_pair.py`, `test_registry_pair_varredura.py`, partes de
  `test_groups_bridge.py`, `test_internal_groups.py`, `test_orq_group.py` — **cada teste removido
  tem par Rust registrado na `conferencia.md` antes de sair**

**Leitores que ficam** (registrar na `conferencia.md` como "fica, leitor"): `registry.py` lista do
modo `python`/convidado/8768 e transferências (BRG-29), `orq_context.py` (BRG-32), `orq_papeis.py`,
`bastao.py` (BRG-31), `hook_installer.py`, `rust_server.py:364-368` (BRG-28, env do filho),
`guest_header.py` (BRG-30), `migracao_sidecars.py`.

**Fecha:** PAIR-14 (sai), BRG-01, 02, 03, 07, 11–19, 27, 35 (c → recusa), BRG-04/05/06/08/09/26/30
(a, ficam no repasse), D na peça D/E do `escopo.md`.

- [ ] **Step 1: Testes**: `test_python_mode_group_routes_refuse` (as 6 rotas → 503
  `groups_need_rust_server` com `CP_RUST_SERVER=0`); `test_connect_group_route_is_one_way` (8768
  repassa status e corpo intactos, sem lógica).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Remover** na ordem: rotas → registry → pair.py → pair_texto → testes.
- [ ] **Step 4: Rodar.** Esperado: PASS nos arquivos de teste tocados; saldo de linhas Python
  negativo (`git diff --stat -- backend/app`).
- [ ] **Step 5: Contrato interno** mudou (`/internal/pair/text` saiu) → subir os protocolos.
- [ ] **Step 6: Commit** — `refactor(groups): remove the Python group writers and protocol text`.

**Prova:** `grep -rn "pair_texto\|join_group\|rename_pair\|dissolve_lone_orq\|_pair_sweep_loop" backend/` → nada.

---

### Task 6: Portões da migração

Status: ready-for-agent
Revisão: base — motivo: fecha a migração; nenhum item do inventário pode ficar sem situação.

**Files:**
- Modify: `.superpowers/sdd/2026-10-19-grupos-federacao/conferencia.md` (criada na Task 1)
- Create: `.superpowers/sdd/2026-10-19-grupos-federacao/medicao.md`

- [ ] **Step 1: Conferência item a item** (fechar a que as Tasks 2–5 preencheram): todo ID (PAIR-01..47, TXT-01..14, HOOK-01..14,
  BRG-01..35) com situação `igual` + teste Rust que reproduz o caso, `muda` + linha da `decisoes.md`,
  ou `sai` + prova de que ninguém depende. PAIR-32 ganha o teste Rust que faltava
  (`leave_write_failure_restores_snapshot`). Revisor de contexto limpo confere que cada `igual`
  aponta um teste daquele caso.
- [ ] **Step 2: Falhas caladas**: `ecc:silent-failure-hunter` sobre o diff das Tasks 1–5; correção
  volta ao Step 1.
- [ ] **Step 3: Caminho inteiro**: `grep` nos dois lados por todo chamador do `escopo.md`; nenhum
  aponta para código Python de grupo, nenhuma volta Rust↔Python.
- [ ] **Step 4: Medição** (`medicao.md`): p50/p95 de `/pair`, `/group-message`, `DELETE /pair` e do
  `pair-context` antes (main) e depois, no Linux e na DELPHI-02; marcadores do diário
  (`pool.espera`, `loop.atraso`, rotas ≥ 1 s). Mais lento sem motivo registrado não fecha.
- [ ] **Step 5: Commit** dos ajustes de teste que os portões pedirem —
  `test(groups): close the migration gates`.

---

## Parte B — grupo entre máquinas no servidor

### Task 7: Identidade, registro do grupo e fila de saída

Status: ready-for-agent
Revisão: base e risco — motivo: concorrência (fila, trabalhadores), contrato entre máquinas e
desenho de que as Tasks 8–12 dependem.

**Files:**
- Create: `crates/hangar-server/src/groups/outbox.rs`
- Modify: `crates/hangar-server/src/groups/store.rs` (`record(gid)`, `write_record`,
  `remove_record`, `records()`; pasta `.hangar-pair/groups/`)
- Modify: `crates/hangar-server/src/groups/model.rs` (`GroupRecord` ganha `outside: Vec<OutsideRef>`;
  `Member { server, name, provider }` como está; `PROTOCOL = 1`)
- Modify: `crates/hangar-server/src/groups/peers.rs` (`PeerError` + `OldVersion`,
  `IdentityMismatch { key, reported }`; o `PeerClient` confere `server_id` da resposta contra a
  chave do `peers.json`)
- Modify: `crates/hangar-server/src/groups/mod.rs` (subida: grava o próprio `server_id` em
  `.hangar-pair/groups/self.json` na primeira vez que esta máquina entra num grupo `fed`, como dona
  ou participante; com algum sidecar `fed` vivo e `CP_SERVER_ID` diferente do `self.json` →
  `erro_grupo_identificador_trocado` no diário, operações `fed` recusadas e `problema` na linha dos
  membros. **`Fed` não ganha campo**: tem `deny_unknown_fields` (`model.rs:11`) e um binário mais
  velho leria o sidecar como par antigo)
- Test: `crates/hangar-server/tests/it/groups_outbox.rs` (novo, + `mod`),
  `tests/it/groups_store.rs` e `tests/it/groups_peers.rs` (estender; `it/main.rs:150,152`)

**Interfaces (produz):**

```rust
pub struct OutsideRef { pub server: String, pub address: String }
// `origin` = server_id de quem enfileirou: o token de dono não diz quem chamou.
pub enum OutboxItem {
    Push { server: String, gid: String, version: u64, joining: Vec<String>, origin: String },
    Dissolved { server: String, gid: String, version: u64, origin: String },
    Leave { owner: String, gid: String, member: String, origin: String },
    Rename { owner: String, gid: String, from: String, to: String, origin: String },
    Outside { owner: String, gid: String, op: OutsideOp, origin: String }, // link/unlink de par de fora (Task 8)
}
pub enum OutsideOp { Link(OutsideRef), Unlink(OutsideRef) }
pub struct Outbox; // enqueue sob o lock de grupo; um trabalhador por destino
impl Outbox {
    pub fn enqueue(&self, items: Vec<OutboxItem>) -> io::Result<()>;
    pub fn cancel_joining(&self, server: &str, gid: &str, member: &str) -> io::Result<()>;
    pub fn wait(&self, server: &str, gid: &str, version: u64, deadline: Duration) -> impl Future<Output = Delivery>;
}
pub enum Delivery { Confirmed, Refused { code: String }, Pending }
```

**Aviso de grupo fica FORA da fila:** não existe `OutboxItem::Deliver`. O aviso (Task 10) é tentado
direto, uma vez, com `text`, `sender`, `notice` e `from_outside` no corpo; máquina que falha volta
em `pulados`. Fila durável de aviso contradiz "dona fora → nada enviado" e reentregaria recado
velho 30 min depois.

**Regras:** fila antes da rede (registro + itens gravados no mesmo passo); `Push` sem `joining`
coalescido; `Dissolved` substitui `Push` pendente do mesmo gid; `cancel_joining` tira o membro do
`joining` de todo `Push` pendente daquele gid no mesmo passo do `remove_member` (Task 8); retentativa
e recusa definitiva pela lista das Global Constraints (definitiva sai da fila e vai ao diário,
`grupos.recusado`); escada 2 s, 5 s, 30 s, 1 min, 2 min, 4 min, 5 min, 10 min, teto 30 min;
**`enqueue` acorda o trabalhador do destino e zera a escada para o item novo** (senão um
trabalhador dormindo 30 min por falha antiga engole o prazo de 16 s do `wait`); trabalhador só
existe com item; subida reenvia (dona) ou pede (participante).
`CP_SERVER_ID`, `peers.json` e pasta de arquivo continuam vindo pelo ambiente do Supervisor
(decisões técnicas).

**Fecha:** desenho-federacao §2, §3 "Fila", §4 `PeerError`; Review Focus 4.

- [ ] **Step 1: Testes**: `key_mismatch_is_refused_before_any_write`; `outbox_survives_restart`;
  `push_without_joining_coalesces`; `dissolved_replaces_pending_push`; `refusal_leaves_the_queue`;
  `python_mode_503_retries`; `worker_exists_only_with_items`; `server_id_change_with_live_group_is_refused`
  (participante incluída, pelo `self.json`); `wait_after_backoff_retries_now`;
  `busy_429_401_408_are_retried`; `unknown_peer_is_retried_with_warning`;
  `coded_404_is_not_old_version`; `cancel_joining_drops_member_from_pending_push`;
  proptest do `outbox.json`, do `self.json` e do `GroupRecord` lidos do disco sem pânico.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** — `feat(groups): group record, outbox and machine identity checks`.

---

### Task 8: Dona e participante: entrar e criar grupo entre máquinas

Status: ready-for-agent
Revisão: risco — motivo: contrato entre máquinas, concorrência sob o lock, acesso de membro de fora.

**Files:**
- Create: `crates/hangar-server/src/groups/federation.rs` (roteamento do `/pair`, `op: join` na
  dona, `local_apply` na participante)
- Modify: `crates/hangar-server/src/groups/routes.rs` (`:219-224`: o desvio para
  `legacy::pair_cross` sai para pedidos novos; rotas `GET /api/sessions/{name}/group`,
  `GET|PUT /api/groups/{gid}`, `POST /api/groups/{gid}/ops`)
- Modify: `crates/hangar-server/src/groups/local.rs` (`plan_join` preserva `fed` — hoje grava
  `fed: None` em `:120` — e `linked_by`; a recusa `own > 0 && outsiders > 0` de `:84` vale só no
  planejador local; `external_link_refusal` (`:172-176`) deixa de recusar `Mix` em sidecar com
  `fed`: par de fora novo em grupo `fed` vira `OutboxItem::Outside(Link)` à dona, e o fim do par,
  `Outside(Unlink)`)
- Modify: `crates/hangar-server/src/groups/legacy.rs` (`pair_cross` sai; `pair_remote` e
  `unpair_remote` ficam para máquina antiga)
- Modify: `crates/hangar-server/src/share/gate.rs` (`is_open`, `:87`) e `share/caller.rs:74`:
  convidado (8766) recusa `GET …/group` e `/api/groups/*` com código explícito
- Modify: repasse da 8768 do Connect (Python): `/api/groups/*` e `GET …/group` repassados ao Rust
  num sentido, ou recusados com código — **nunca 404 sem código**, que a outra máquina leria como
  `OldVersion`
- Modify: `crates/hangar-server/src/share/pair_routes.rs` (`grant_members`, `:331`, roda depois do
  `local_apply` em cada máquina, só para os membros locais dela — 1A, I-6A)
- Test: `crates/hangar-server/tests/it/groups_federation.rs` (+ `mod` em `tests/it/main.rs`)

**Fluxo** (desenho-federacao §3 "Entrar / criar"): endereço de fora vira a ponta local
(`routes.rs:203-207`); recusas antes de escrever (`erro_pareamento_server_id_ausente`,
`erro_grupo_identificador_igual`, `erro_grupo_peer_nao_registrado`, `erro_grupo_orq_entre_maquinas`,
`erro_link_remoto`, `erro_grupo_peer_versao_antiga`); grupo de cada candidato por sidecar local ou
`GET {srv}/api/sessions/{nome}/group`; nenhum → esta máquina é a dona; um → `op: join` na dona com
`expected` (mudou → 409 `erro_grupo_mudou`); mesma dona → fusão com contrato concatenado; donas
diferentes → 409 `erro_grupo_fusao_entre_donos` (D2). Grupo local com membro de fora vira `fed` e a
máquina dele é a dona; os pares de fora ficam nos sidecars dela (1A). Dona: sob o lock grava
registro + sidecars + itens; fora do lock espera cada participante (`Outbox::wait`, 16 s);
recusado/sem resposta → `remove_member` (que chama `Outbox::cancel_joining` no mesmo passo) +
`warning` `erro_grupo_membro_nao_confirmado`; nenhum confirmado → 502 e o grupo volta ao que era.

**Passe de entrada (sem travamento entre máquinas):** quem inicia solta o passe de entrada da
sessão (`routes.rs:209`, hoje só solto em `:251`) **antes** de chamar a dona e antes do
`Outbox::wait`, como `legacy.rs:66` já faz. O `PUT /api/groups/{gid}` da participante nunca entra
na porta da sessão (`enter()`): ele só toca sidecar sob o lock de grupo. Sem isso, `casa` segura o
passe de `a` enquanto `lab` espera o `PUT` que precisa desse passe, e todo join iniciado fora da
dona sai "não confirmado".

**Participante (`PUT /api/groups/{gid}`):**
- recusa `erro_grupo_peer_nao_registrado` **antes de gravar** se a dona não está no `peers.json`
  local (sem isso, todo `Leave`/`Rename`/aviso/contrato dela cai em `Unknown` e o membro morto
  fica no registro para sempre);
- versão **menor** que a gravada → ignorada (responde a gravada); igual → responde o mesmo sem
  reentregar;
- confere `joining` na própria lista; só cria sidecar para quem está em `joining`; só altera
  sidecar da mesma (dona, gid); preserva `linked_by` e pares de fora;
- **renomear pendente vence:** `Push` que lista um nome com `Rename{from: esse nome}` pendente na
  fila desta máquina usa o nome novo, e a regra "membro que sumiu do `Push` vira `Leave`" não se
  aplica a ele;
- protocolo (Task 2) entregue fora do lock.

**Fecha:** 1A, I-6A, D2, desenho-federacao §3–§4, Review Focus 1, 2, 3, 6.

- [ ] **Step 1: Testes** com duas ou três instâncias (`casa`, `lab`, `vm`; `tempdir`,
  `HANGAR_SERVER_ID` e `peers.json` cruzados): `three_locals_plus_one_remote` (o caso que motivou o plano);
  `join_partial_when_one_server_is_down`; `push_never_creates_sidecar_outside_joining`;
  `late_push_does_not_resurrect_pending_leave`; `stale_push_after_dissolve_is_ignored`;
  `same_name_on_two_servers_are_two_members`; `merge_with_different_owners_is_refused`;
  `local_group_with_outside_member_becomes_federated`;
  `outside_member_access_stays_on_its_machine`; `join_keeps_fed_and_linked_by`;
  `guest_cannot_read_group`; `old_version_peer_is_refused_with_code`;
  `join_from_participant_does_not_deadlock`; `older_version_is_ignored`;
  `asymmetric_peers_refuses_put`; `removed_member_is_cancelled_in_pending_push`;
  `outside_pair_on_fed_group_links_at_owner`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Portas de fora**: conferir que a 8768 repassa `/api/groups/*` e `GET …/group` (ou
  recusa com código) e que a 8766 recusa com código; teste Python
  `test_connect_forwards_groups_routes` e teste Rust `guest_groups_routes_refused_with_code`.
- [ ] **Step 6: Commit** — `feat(groups): groups across the owner's machines with an owner machine`.

---

### Task 9: Sair, morrer, renomear e dissolver

Status: ready-for-agent
Revisão: risco — motivo: concorrência (fila × saída) e contrato entre máquinas.

**Files:**
- Modify: `crates/hangar-server/src/groups/exit.rs` (`leave_and_notify`, `:24`: ramo `fed` apaga o
  sidecar na hora, avisa a sessão e enfileira `Leave` à dona em vez de `/unpair-remote` de
  `:33-74`; na dona aplica `remove_member` e empurra)
- Modify: `crates/hangar-server/src/groups/sweep.rs` (morto local de grupo `fed` sai pelo ramo
  acima; continua ignorando nomes remotos e esperando a restauração, `restore::held()` em
  `:162-163`)
- Modify: `crates/hangar-server/src/groups/service.rs` (`rename`, `:210`: em `fed` enfileira
  `Rename` à dona; `link_return::renamed` segue local) — **depois da Task 12**, que também mexe
  neste arquivo
- Modify: `crates/hangar-server/src/groups/legacy.rs` (`unpair_remote`, `:137-144`: em sidecar com
  `fed` não faz saída local solta; passa pelo `remove_member` da dona)
- Modify: `crates/hangar-server/src/groups/federation.rs` (dissolve quando o grupo inteiro tem ≤ 1
  máquina com membros: registro dissolve, `Dissolved` aos participantes; a máquina que sobrou fica
  com grupo local comum, mesmo `gid`, sem `fed`, com os pares de fora que tinha. **Dona sem membro
  próprio continua dona** enquanto houver membros em duas ou mais máquinas — limite aceito,
  registrado em `docs/decisoes/plataforma.md` na Task 13)
- Test: `crates/hangar-server/tests/it/groups_federation_exit.rs` (+ `mod`)

**Fecha:** desenho-federacao §3 "Sair/Morte/Renomear", PAIR-45 (morte avisa a outra máquina,
agora pela fila).

- [ ] **Step 1: Testes**: `leave_never_waits_for_the_owner` (dona fora: sai na hora, `Leave` na
  fila); `dead_member_leaves_through_the_queue`; `rename_reaches_the_owner`;
  `dissolve_keeps_a_local_group_with_outside_pairs`; `leave_ends_outside_pairs_as_today`;
  `push_before_rename_keeps_new_name` (o `Push` com o nome velho chega antes do `Rename`: o membro
  novo continua no grupo); `owner_without_own_members_stays_owner`;
  `old_peer_unpair_after_owner_converted` (com a Task 11).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** — `feat(groups): leave, death and rename of members across machines`.

---

### Task 10: Aviso de grupo e contrato pela dona

Status: ready-for-agent
Revisão: risco — motivo: limite anti-tempestade, salto único para terceiros e escrita concorrente do
contrato.

**Files:**
- Modify: `crates/hangar-server/src/groups/routes.rs` (`group_message`, `:338`: em `fed` pede
  `op: message` à dona; `storm`, `:330-336`, contado só na dona; `pulados` qualificado;
  `GET /pair/contract` (`fn contract`, `:386`) repassa à dona e devolve `path: ""`, `owner`, `mtime`;
  `PUT /api/sessions/{name}/pair/contract {content, mtime}` → `{mtime}` ou 409
  `erro_contrato_mudou`; `POST /api/groups/{gid}/deliver`; `GET|PUT /api/groups/{gid}/contract`)
- Modify: `crates/hangar-server/src/share/pair_routes.rs` (`notify_outside`, `:554`: usa o `notice`
  gerado na dona; aviso vindo de fora em sidecar `fed` sobe à dona com `from_outside: true` e
  nenhuma máquina reenvia a terceiro, `:836-858`; a chave de deduplicação do aviso a quem é de
  fora (`:844`) passa a ser `notice` + destino, **sem** o endereço da máquina que manda: duas
  máquinas próprias com par para a mesma máquina de fora entregam uma vez só)
- Modify: `backend/app/bastao.py` (`:572-590`): com `fed` cuja dona é outra máquina, o dossiê cita
  "contrato na máquina `<owner>`" em vez de caminho local inexistente — **saldo de linhas ≤ 0**
- Test: `crates/hangar-server/tests/it/groups_federation_notice.rs` (+ `mod`)

**Regras (decisões):** I-7A — cabeçalho nas outras máquinas `[de fora: alias::x via <máquina>]`,
resposta a quem é de fora só por aviso de grupo; I-6A — o aviso chega ao membro de fora uma vez,
pela máquina do par; I-4A — contrato só na dona, sem réplica, pela tool `contract` /
`hangar-send --contrato` (nome fixo); dona fora → contrato responde 503
`erro_grupo_dono_indisponivel`.

**Aviso sem fila** (Task 7): a dona tenta cada máquina direto, uma vez, com `text`, `sender`,
`notice`, `from_outside`; quem falha volta em `pulados` qualificado. **Dona fora do ar:** a máquina
de quem manda entrega aos membros dela mesma (e aos pares de fora dela) e devolve as outras
máquinas em `pulados` — dois membros na mesma `lab` continuam se avisando. O limite de tempestade
contado na dona também conta aviso que veio de fora: limite aceito, registrado na Task 13. `orq_context.py` não muda (grupo `orq` nunca é entre máquinas,
`erro_grupo_orq_entre_maquinas`). `/api/pair/task-suggestion` (BRG-33) continua local: membros de
outra máquina ficam de fora da sugestão — registrar como limite na `docs/decisoes/plataforma.md`
(Task 13).

**Fecha:** I-4A, I-6A, I-7A, BRG-31, BRG-32 (sem mudança, motivo registrado), BRG-33 (limite),
Review Focus 6.

- [ ] **Step 1: Testes**: `notice_reaches_every_machine`; `notice_reaches_outside_once`;
  `storm_counts_only_at_the_owner`; `outside_notice_never_leaves_to_third_parties`;
  `contract_put_conflict_is_409`; `owner_down_contract_is_503`;
  `owner_down_same_machine_still_delivers` (membros da mesma máquina recebem, as outras vêm em
  `pulados`); `outside_notice_deduped_across_own_machines`; e em Python
  `test_bastao_cites_remote_owner_contract`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** — `feat(groups): group notices and the shared contract through the owner machine`.

---

### Task 11: Par 1:1 antigo vira grupo sozinho

Status: ready-for-agent
Revisão: risco — motivo: as duas máquinas decidem sem conversar; erro aqui cria dois grupos.

**Files:**
- Create: `crates/hangar-server/src/groups/convert.rs`
- Modify: `crates/hangar-server/src/groups/mod.rs` (dispara na subida e quando um `/pair` toca
  sessão em par antigo)
- Modify: `crates/hangar-server/src/groups/federation.rs` (`PUT /api/groups/{gid}` aceita
  `convert_from_legacy: "<srv>::<nome>"` só se o sidecar local tem exatamente esse par antigo)
- Test: `crates/hangar-server/tests/it/groups_convert.rs` (+ `mod`)

**Regra (I-8B):**
1. **Par antigo** = sidecar com exatamente um peer `srv::x`, sem `fed`, em que `srv` **existe no
   `peers.json`** e **não** coincide com nenhum apelido de `external_pairs.json` nem com par de fora
   cujo registro sumiu (`pair_routes.rs:603-610`). Ambíguo → não converte, diário
   `grupos.conversao_ambigua`.
2. **Identidade conferida antes:** `GET {srv}/api/peers/identificador` (rota que já existe e que
   os clientes usam) devolve o `server_id` real da outra máquina, pelo mesmo `PeerClient` da Task 7. Chave do `peers.json` ≠ `server_id`
   reportado → `IdentityMismatch`, nada gravado, diário `erro_grupo_identificador_divergente`. O
   lado que recebeu o par antigo guarda o `CP_SERVER_ID` (`legacy.rs:117`) e o que iniciou guarda a
   chave do `peers.json` (`legacy.rs:68`): **dona e `gid` só são calculados com os dois
   `server_id` conferidos**, nunca com a chave.
3. Dona = a máquina de menor `server_id` (ordem de bytes). `gid` = primeiros 12 hex do
   `sha1("<srvA>::<a>\n<srvB>::<b>")` com os dois nomes qualificados pelos `server_id` conferidos,
   em ordem de bytes.
4. **A dona só converte o próprio sidecar depois do `Confirmed`:** monta o `GroupRecord` (versão 1,
   tarefa do sidecar dela, sem contrato) e o `Push` com `convert_from_legacy`; grava registro e
   `fed` no sidecar só quando a participante confirma. `OldVersion` ou recusa → desfaz registro e
   item, sidecar segue 1:1 (`legacy.rs` receptor), nova tentativa na próxima subida.
5. A participante converte quando recebe o `Push` com `convert_from_legacy` (não cria registro).
6. `unpair_remote` vindo de máquina antiga num sidecar já com `fed` passa pelo `remove_member` da
   dona (Task 9), nunca saída local solta.
7. Idempotente: mesma entrada, mesmo `gid`, mesmo registro. Nenhum protocolo novo é entregue (as
   sessões já estavam pareadas); a próxima reinjeção traz o texto novo.

**Fecha:** I-8B, Review Focus 5.

- [ ] **Step 1: Testes**: `both_sides_convert_to_the_same_group` (subida simultânea);
  `conversion_is_idempotent`; `old_version_peer_stays_legacy` (dona sem registro nem `fed` depois
  do `OldVersion`); `outside_pair_is_never_converted`; `alias_colliding_with_peer_is_not_converted`;
  `peers_key_differs_from_server_id_converts_once`; `old_peer_unpair_after_owner_converted`;
  `gid_is_deterministic` (valor literal esperado calculado à mão no teste a partir da regra acima).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** — `feat(groups): convert old one-to-one pairs into groups across machines`.

---

### Task 12: `pair_owner` na lista

Status: ready-for-agent
Revisão: base — motivo: contrato da lista que os três clientes consomem (Task 14).

**Files:**
- Modify: `crates/hangar-api/src/session.rs` (`:126-138`: `pair_owner: Option<String>`)
- Modify: `crates/hangar-server/src/list/links.rs` (`fill_links`, `:191`, a partir de `fed.owner`)
- Modify: `crates/hangar-server/src/list/sig.rs` (`:103`: entra na assinatura)
- Modify: `crates/hangar-server/src/groups/service.rs` (toda escrita da fila e do `PUT` passa por
  `changed()`, `:90`, para a lista reemitir) — entra antes da Task 9, que mexe no mesmo arquivo
- Test: `crates/hangar-server/tests/it/list_routes.rs` (estender; `it/main.rs:156`)

**Invariante:** convidado não recebe `pair_owner` (a lista do convidado é Python e não produz o
campo; conferir que `guest_header.py` não precisa de mudança).

- [ ] **Step 1: Testes**: `row_carries_pair_owner`; `list_reemits_when_only_the_owner_changes`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** — `feat(list): carry the group owner machine in session rows`.

---

### Task 13: Textos aos agentes, `hangar-send`, MCP e documentação

Status: ready-for-agent

**Files:**
- Modify: `scripts/hangar-send` (`--help`: `--pair srv::x` cria grupo entre máquinas, `--group`
  alcança todas as máquinas; trocar `:108-110` "--group cross-server ainda não existe"; flag
  `--contrato [--gravar <arquivo>]`, o nome que a Task 2 cita)
- Modify: `scripts/install-hangar-send.sh` (heredoc, `:111` "pareamento 1:1… `--group` continua
  local")
- Modify: `crates/hangar-server/src/mcp/catalog.json` e `tools.rs` (`pair`: `alvo` aceita
  `servidor::sessao` e forma grupo; `sessions` mostra a máquina dos membros; tool nova `contract`
  — ler e gravar o contrato do grupo, o nome que a Task 2 cita)
- Modify: `CLAUDE.md` (regra em "Plataforma": grupo entre máquinas próprias, dona, fila,
  `groups_need_rust_server`), `docs/decisoes/plataforma.md` (atualizar a entrada "Grupos: o Rust
  grava" em vez de criar outra; limites aceitos: BRG-33, dona sem membro próprio continua dona,
  limite de tempestade conta aviso vindo de fora), `docs/decisoes/harnesses.md` (reinjeção pelo
  binário), `docs/migracao-rust/README.md`
- Modify: `scripts/omniroute-statusline.js:305-311` (conferir se o chip 🤝 lê algo que mudou)

**Fecha:** desenho-federacao §8, D-TXT-5 (registrado como limite: só Claude reinjeta).

- [ ] **Step 1: Atualizar** os textos; conferir que a tool `contract` e a flag `--contrato` são
  exatamente as citadas nas Tasks 2 e 10.
- [ ] **Step 2: Prova**: `scripts/hangar-send --help | grep -n "group"` mostra o texto novo;
  `cd crates && … cargo test -p hangar-server --lib mcp::` verde.
- [ ] **Step 3: Commit** — `docs(groups): tell agents and docs that groups cross machines`.

---

## Parte C — clientes (2A, I-9A)

### Task 14: Modelo global de grupos (duas cópias, uma fixture)

Status: ready-for-agent
Revisão: base — motivo: regra pura que as Tasks 15–17 consomem.

**Files:**
- Modify: `packages/core/src/pairGroups.ts` (generaliza `groupRemotePairs` para
  `groupGlobal(rows, identities)`), `packages/core/src/pairDrop.ts` (`canPair`, `:25-36`),
  `packages/core/src/types.ts` (`pair_owner`)
- Create: `packages/core/src/pairGroups.fixtures.json`
- Modify: `desktop-native/src/app/grouping.rs` (`can_pair`, `:79-87`; modelo global), 
  `desktop-native/src/api/dto.rs` (`pair_owner`)
- Test: `packages/core/src/pairGroups.test.ts`, `pairDrop.test.ts`, `#[cfg(test)]` de `grouping.rs`

**Contrato (produz):** grupos `{ key, label, members }`; membro `Here { server, name }`,
`Missing { server_id, name }`, `Outside { alias, session }`. Chave `(pair_owner, pair_gid)`; sem
`pair_owner`, `(máquina, pair_gid)`. Par 1:1 antigo recíproco continua juntado. Identidade ausente
ou repetida não se adivinha. Rótulo = primeira `pair_task` não vazia, senão nomes. `canPair`, na
mesma ordem nas duas cópias: `same`, `orq`, `dead`, `invite`, `same_group` (pela chave), `no_identity`,
`other_owner`; **saem** `other_server` e `cross_server`; membro de fora não impede (1A). O motivo
`invite` hoje só existe no nativo (`grouping.rs:15` `Refusal::Invite`; `pairDrop.ts:22`
`DropReason` não o tem): a cópia TS **ganha** `invite` nesta Task, e a fixture cobre o caso nas
duas.
Identificador de cada máquina lido sob demanda por `GET /api/peers/identificador` (como
`frontend/src/lib/sessionsStore.svelte.ts:198-217`).

- [ ] **Step 1: Fixture** com os casos: dois servidores mesma dona, donas diferentes, identidade
  ausente, identidade repetida, par antigo, membro de fora, `same_name_two_servers`, `orq`, morto.
- [ ] **Step 2: Testes** das duas cópias lendo a fixture.
- [ ] **Step 3: Rodar e ver falhar.**
- [ ] **Step 4: Implementar** as duas cópias.
- [ ] **Step 5: Rodar.** Esperado: `cd packages/core && npx vitest run src/pairGroups.test.ts src/pairDrop.test.ts`
  e `cd desktop-native && cargo test grouping::` verdes.
- [ ] **Step 6: Commit** — `feat(clients): one group model across machines for core and native`.

---

### Task 15: Nativo — selo, cabeçalho, arrastar, painel e abas

Status: ready-for-agent

**Files:**
- Modify: `desktop-native/src/app/grouping.rs` (`cluster`, `:103-122`; `pair_header_label`, `:53`,
  cita membros de outras máquinas; selo com `glyph`, `:220`, e `split_code`, `:126`; candidatas,
  `:236-241`, de todas as máquinas)
- Modify: `desktop-native/src/app/sidebar.rs` (`layout` `:365`, `remote_layout` `:482`,
  `visible_order` `:523`: selo em todo modo `SidebarGroup`, inclusive linha puxada para
  aguardando/trabalhando no modo Máquina)
- Modify: `desktop-native/src/app/session_tabs.rs` (`:28-52`: chave do modelo global; máquinas
  diferentes dividem a faixa)
- Modify: `desktop-native/src/app/group_sheet.rs` (`members_list`, `:101`: membros e candidatas de
  todas as máquinas, quatro estados)
- Modify: diálogo de soltar (pedido ao servidor do alvo com origem qualificada
  `"<id da origem>::<nome>"`)

**Regra 2A:** sem seção "Grupos" no topo; o grupo aparece dentro do modo escolhido, e clicar no
selo abre o painel do grupo. Nunca um SSE por card.

- [ ] **Step 1: Testes** de unidade das regras novas (`grouping`, `session_tabs`).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: verificação manual na tela**: build otimizado com `nice`, print do nativo nos três
  modos com um grupo de duas máquinas; caminho absoluto do print no relato.
- [ ] **Step 6: Commit** — `feat(native): show and build groups across machines in every sidebar mode`.

---

### Task 16: PWA — lista, arrastar e painel

Status: ready-for-agent

**Files:**
- Modify: `frontend/src/lib/sessionListModel.svelte.ts` (`:131-159`: sai o bloco do topo; membro na
  máquina dele com selo — I-9A)
- Modify: `frontend/src/lib/arrastarGrupo.svelte.ts` (`:66-67`: motivos novos)
- Modify: `frontend/src/components/GrupoDropDialog.svelte` (`:39,88,135-142`: origem qualificada)
- Modify: `frontend/src/components/PairSheet.svelte` (`:131-145, 197-202`: membros de todas as
  máquinas, "Ver em grade" com o `serverId` de cada membro, quatro estados)
- Test: `frontend/src/lib/sessionListModel.test.svelte.ts` (estender)

**Invariante:** a agregação continua uma SSE por servidor (`sessionsStore`); a vista desktop web
não ganha recurso (só o que é compartilhado com o celular).

- [ ] **Step 1: Testes**: posição do grupo no modo escolhido; diálogo com origem qualificada.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: `npm --prefix frontend run check` e os vitest tocados verdes.
- [ ] **Step 5: verificação manual na tela** na vista celular (820 px ou menos) com duas máquinas.
- [ ] **Step 6: Commit** — `feat(pwa): groups across machines inside the session list`.

---

### Task 17: App Expo — seletor, membros e selo

Status: ready-for-agent

**Files:**
- Modify: `mobile/app/s/[server]/[name]/pair.tsx` (`:144,176`: candidatas de todas as máquinas)
- Modify: `mobile/src/features/pair/PairPicker.tsx`, `PairMembers.tsx`, `groupPairs.ts`
- Modify: `mobile/src/features/sessions/SessionRow.tsx` (`:123-125`: selo com glifo; alvo 44 pt ou
  `hitSlop`)
- Test: `mobile/src/features/pair/pairActions.test.tsx` (pedido qualificado)

**Invariante:** visual copia o nativo (Task 15); regras de iOS do CLAUDE.md; sem `npm install`
fora de `--prefix`.

- [ ] **Step 1: Testes.**
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar.** Esperado: testes tocados verdes; `npm run check` na raiz verde.
- [ ] **Step 5: Commit** — `feat(mobile): pick and show group members from every machine`.

---

### Task 18: Textos de tela e códigos de erro

Status: ready-for-agent

**Files:** `messages/pt.json`, `messages/en.json`, `packages/core/src/errosApi.ts`

**Entram:** `grupo_recusa_sem_identificador`, `grupo_recusa_outra_dona`,
`grupo_membro_maquina_desconectada`, `grupo_selo_maquinas`; códigos `groups_need_rust_server`,
`erro_grupo_peer_versao_antiga`, `erro_grupo_dono_indisponivel`, `erro_grupo_fusao_entre_donos`,
`erro_grupo_membro_nao_confirmado`, `erro_grupo_identificador_igual`,
`erro_grupo_identificador_divergente`, `erro_grupo_identificador_trocado`,
`erro_grupo_peer_nao_registrado`, `erro_grupo_orq_entre_maquinas`, `erro_grupo_mudou`,
`erro_grupo_inexistente`, `erro_grupo_entre_maquinas_sem_rust`, `erro_contrato_mudou` (conferir se já
existe da 1a), `erro_corpo_invalido` (se ainda não tiver frase), e `erro_link_remoto` (já existe no
Rust, `routes.rs:221`, sem frase em `messages/pt.json` nem entrada em `errosApi.ts`). **Saem:** `grupo_recusa_other_server`, `grupo_recusa_cross_server`;
`erro_pareamento_mistura_cross` e `erro_pareamento_cross_1_1` ficam só enquanto o receptor antigo
puder devolvê-los.

- [ ] **Step 1: Chaves** entram no commit de cada Task que as usa (8, 10, 14–17); este Step confere
  que nenhuma ficou sem par pt/en.
- [ ] **Step 2: Prova**: `cd frontend && npx vitest run src/lib/i18nGuard.test.ts` verde;
  `grep -rn "grupo_recusa_other_server\|grupo_recusa_cross_server" frontend/src desktop-native/src mobile/src packages/core/src --exclude-dir=paraglide` → nada.
- [ ] **Step 3: Commit** (se sobrou ajuste) — `i18n(groups): texts for groups across machines`.

---

## Parte D

### Task 19: Verificação manual com o dono

Status: ready-for-human

- [ ] **Step 1: verificação manual — grupo local** (do antigo Task 9): `hangar-send --pair`,
  `--group`, `--unpair`, renomear e matar membro; telas mudando na hora.
- [ ] **Step 2: verificação manual — três locais + uma sessão da VM**: grupo local de três sessões no notebook +
  sessão na DELPHI-02 entra pelo `--pair delphi-02::<sessão>`; aviso de grupo chega nas quatro;
  contrato lido e gravado da VM.
- [ ] **Step 3: verificação manual — membro de fora** num grupo entre máquinas: acesso só na
  máquina do par; aviso de grupo chega a ele uma vez.
- [ ] **Step 4: verificação manual — filha ligada** num grupo entre máquinas: volta da resposta ao
  pai funciona; `--link` para outra máquina recusado.
- [ ] **Step 5: verificação manual — par 1:1 antigo** feito na `main` antes da atualização: depois
  de atualizar as duas máquinas, vira grupo sozinho, mesmo `gid` nas duas.
- [ ] **Step 6: verificação manual — orquestração**: `orquestrar-auto` curta; grupo `orq` nasce,
  árbitro sozinho entre Tasks, dissolve no fim.
- [ ] **Step 7: verificação manual — Rust fora**: `CP_RUST_SERVER=0` com o binário presente;
  `--pair` responde `groups_need_rust_server`; `/clear` numa sessão em grupo ainda reinjeta o
  protocolo (o hook chama o binário, não o servidor). Sem binário instalado: o instalador não deixa
  entrada de hook de grupo e o diário mostra `grupos.hook_sem_binario`.
- [ ] **Step 8: verificação manual — Rust caindo com grupo vivo**: matar o `hangar-server` no meio
  de uma troca de conta de sessão em grupo; quando volta, a sessão segue no grupo e a fila entrega
  o que ficou.
- [ ] **Step 9: verificação manual — Windows e celular**: DELPHI-02 como dona e como participante;
  PWA e app Expo mostrando o grupo de duas máquinas.
- [ ] **Step 10: verificação manual — dona fora**: desligar a máquina dona com dois membros na
  mesma outra máquina; o aviso entre esses dois chega, as demais aparecem em `pulados`; quando a
  dona volta, a fila entrega saída e renomeação pendentes.

---

## Autorrevisão

**Decisões → Tasks:** 1A → 8, 10; 2A → 15; I-1A → 4 (PAIR-12), 6 (registro dos demais); I-2A → 3;
I-3A → 2, 3; I-4A → 2, 10; I-5A → 4; I-6A → 8, 10; I-7A → 10; I-8B → 11; I-9A → 16; D2 → 8;
decisões técnicas (identificador sob demanda → 14; env do Supervisor → 7; `outside` informativo → 7,
8; modo `python` → 5, 7).

**Inventário (diferenças e itens b/c) → Tasks:** PAIR-07, 22, 34, 35, 37, 38, 41, 45 → 6
(`muda`, registro em `decisoes.md`); PAIR-12 → 4; PAIR-14 → 5; PAIR-32 → 6; D-TXT-1..4 → 2, 3;
D-TXT-5 → 13; BRG-10, 20, 25 → 4; BRG-21..23 → 4 (ficam num sentido); BRG-24 → 5 (fica a ponte do
rename), 9 (rename pela dona); BRG-28 → 7; BRG-29, 30 → 5 (leitores que ficam); BRG-31 → 10;
BRG-32 → 10 (sem mudança, motivo); BRG-33 → 10, 13 (limite); BRG-34 → 3; classe c → 5.

**Nomes conferidos entre Tasks:** `TextArgs`/`ContractLine` (2 → 3, 8); `OutboxItem`/`Outbox::wait`/
`Outbox::cancel_joining`/`OutsideOp` (7 → 8, 9, 10, 11); `OutsideRef` (7 → 8, 10); `pair_owner`
(12 → 14–17); `groups_need_rust_server` (5, 7, 18); motivos `no_identity`/`other_owner`/`invite`
(14 → 15–17, 18); contrato remoto: tool `contract` e `hangar-send --contrato` (Global, 2, 10, 13);
`self.json` (7 → 11); `erro_grupo_peer_nao_registrado` (8, 18).

**Correções da revisão adversarial (19/10), aplicadas:**
1. Travamento no `/pair`: passe de entrada solto antes de chamar a dona; `PUT` da participante fora
   do `enter()` (Task 8, `join_from_participant_does_not_deadlock`).
2. Renomear pendente vence `Push` com nome velho (Task 8; teste na Task 9).
3. Versão menor ignorada; `remove_member` cancela o `joining` pendente (Tasks 7, 8).
4. Conversão: dona só grava depois do `Confirmed`; `OldVersion` desfaz; `unpair_remote` em `fed`
   pela dona (Tasks 9, 11).
5. Conversão com identidade conferida; dona/`gid` só de `server_id` conferido (Task 11).
6. `peers.json` assimétrico recusado no `PUT`; `Unknown` tentado de novo com aviso (Global, 8).
7. Itens da fila com `origin`; aviso fora da fila, falhas em `pulados` (Tasks 7, 10).
8. Lista explícita de retentativa; `OldVersion` só de sinal específico (Global, 7).
9. `enqueue` acorda o trabalhador e zera a escada (Task 7).
10. Par de fora em grupo `fed`: `external_link_refusal` e operação `Outside` na dona (Tasks 7, 8).
11. Dona fora: entrega na mesma máquina e `pulados`; dona sem membro próprio continua dona, limite
    registrado (Tasks 9, 10, 13, 19).
12. `conferencia.md` nasce na Task 1; nome do contrato fixo; conflitos de `mod.rs` (2→7) e
    `service.rs` (12→9) serializados; instalador sem binário (Tasks 1, 3, Lotes, 19).
13. `self.json` guarda o id da própria máquina; `Fed` sem campo novo (Task 7).
14. Deduplicação do aviso a quem é de fora sem o endereço de quem manda; tempestade contando aviso
    de fora como limite aceito (Task 10).
15. Par antigo exige `srv` no `peers.json` e sem colisão com par de fora (Task 11).
16. 8768 repassa `/api/groups/*` (nunca 404 sem código); 8766 recusa com código (Task 8).

**Correções de referência (19/10), aplicadas:** testes Rust em `tests/it/<x>.rs` com `--test it
<x>`; `tests/it/proxy.rs:36`; `desktop-native/src/app/sidebar.rs`; `frontend/src/lib/i18nGuard.test.ts`;
`mobile` com vitest; `registry.py:170` e `_pair_ausencias` como atributo (`:989`); `local.rs:120`;
`routes.rs:386`; `service.rs:90`; `exit.rs:24`; `sweep.rs:162-163`; `gate.rs:87`; título certo da
entrada de `plataforma.md`; flag `--only` criada na Task 1; `invite` acrescentado à cópia TS;
`erro_link_remoto` na Task 18; `omniroute-statusline.js:305-311`.

**Bloqueios e o que não foi lido:**
- `link_return::renamed` não lido: a Task 4 confere se faz volta ao Python.
- `share/gate.rs` além de `is_open` (`:87`): a Task 8 confere como limitar `GET …/group` por sessão.
- `erro_contrato_mudou` pode já existir da 1a: conferir na Task 18.
- Forma do repasse Python da 8768 para `/api/groups/*`: a Task 8 confere o arquivo do repasse.
