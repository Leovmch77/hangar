# Contrato da abertura de sessão

Fixtures geradas executando o Python do commit `601bc62a0`. Elas prendem o que ele faz ao abrir e
reabrir sessão, e o Rust da migração (plano `docs/superpowers/plans/2026-10-15-unified-session-open.md`)
precisa reproduzir isso. **Nunca edite uma fixture à mão: só a regeneração muda uma fixture.**

## Arquivos

- `../session_open_scenarios.py`: as entradas (cenários). Cada um tem o estado inicial (`state`), as
  respostas das bordas (`fakes`) e os passos (`steps`: pedido HTTP ou `{"call": "launch_headless"}`).
- `../session_open_contract.py`: harness com geração, normalização, comparação e os dois lados.
- `<cenário>.json`: `{"_meta", "scenario", "result"}`. O `_meta` traz o commit de origem e o comando
  que gerou a fixture.
- `../../../test_session_open_contract.py`: autoteste. Cobre a normalização, a comparação, a falha
  explícita do lado Rust e a coerência entre cenários e fixtures.

Grupos: `a-create` (`POST /api/sessions`), `b-reopen-claude` (`modo-execucao`, `recarregar`,
`conta`, `permission-mode`), `c-codex` (troca de modo e reinício pelo adapter Python), `d-resume`
(`/resume`, retomar do Arquivo e bastão).

## Comandos (de `backend/`)

```bash
uv run python tests/fixtures/contract/session_open_contract.py generate              # regenera todas
uv run python tests/fixtures/contract/session_open_contract.py generate --group b    # um grupo
uv run python tests/fixtures/contract/session_open_contract.py generate <cenário>    # uma
uv run python tests/fixtures/contract/session_open_contract.py diff --side python    # Python × fixtures
uv run python tests/fixtures/contract/session_open_contract.py diff --side rust      # Rust × fixtures
uv run pytest tests/test_session_open_contract.py                                     # autoteste
```

O lado Python roda sobre o `git archive 601bc62a0` de `backend/app`, `plugins`, `skills`,
`resources` e `scripts`, exportado em `/tmp/hso/src-601bc62a0`. Assim ele continua rodando depois
que as Tasks seguintes apagarem o Python da árvore. Num clone raso (o checkout do job `backend` do CI)
o commit não existe e o `diff --side python` falha dizendo isso. Por esse motivo a reexecução
completa fica no comando acima e não no pytest.

O lado Rust roda o exemplo `session_open_contract` do `hangar-server` (compile antes com `cargo build
-p hangar-server --example session_open_contract`; o binário é procurado em `$CARGO_TARGET_DIR` ou
em `HSO_RUST_BIN`). Ele monta o mesmo cenário, prepara o que o Rust lê do disco (os panes do cenário,
o `plugin-dir` publicado, o `hangar-conta` desta árvore) antes do instantâneo e abre pela mesma
biblioteca do servidor, com o tmux em memória e as pontes gravadas na forma do lado Python. Rota que o
Rust ainda não atende falha dizendo a rota. Cada conserto (`suspeitas.md`) ou decisão que muda o que a
fixture prende é uma regra em `RUST_DIFFERENCES`: ela desfaz a diferença e acusa quando o conserto falta.

## Como um cenário roda

Cada cenário roda num processo filho próprio, com `cwd`, `HOME`, `XDG_RUNTIME_DIR` e `TMPDIR`
dentro de `/tmp/hso/<6 hex do nome>`. A raiz é fixa por cenário, então os hashes que o Python tira
do caminho (pasta de projeto do Claude, trust do Kimi) saem iguais nos dois lados. O filho chama a
app FastAPI pelo `TestClient`, sem `lifespan`: nada de `matar_orfaos` nem de canos reais.

Nada é lançado. Na borda:

| Borda | O que o harness faz |
|---|---|
| `subprocess.Popen` | `tmux` responde de um tmux em memória; `systemd-run` só tem o comando de dentro atendido, sem escopo real; os demais programas são gravados e respondem pelas regras de `fakes.programs`. Só `git` roda de verdade, e só dentro da raiz. |
| `asyncio.create_subprocess_exec` | gravado (argv, cwd e ambiente); devolve um processo falso vivo. |
| `os.kill` / `os.killpg` | só em pid falso, e gravado em `signals`; sinal a processo real é recusado. |
| `socket.connect` | recusado e gravado em `network`, um por endereço. |
| `/proc/<pid falso>` | lido de um `/proc` de mentira com o `cmdline`, o `environ` e o `stat` do estado. |
| Pontes para o Rust | `share`, `groups`, `list`, `claude_customizations`, `dictation` e `accounts.quotas` são gravadas em `rust_bridge` e respondem `fakes.rust_bridge`. Sem resposta dada, as de estado devolvem ok vazio, o catálogo do Codex responde como com o Rust fora e as cotas vêm de `fakes.quotas`. |
| Runtime sem terminal | `acordar`, `ensure_running`, `recarregar`, `parar` e `set_permission_mode` do adapter Claude sem terminal e o aquecimento do Codex sem terminal são gravados em `runtime_requests`, sem subir nada. `set_permission_mode` falha, como sem processo vivo. |

## O que a fixture grava (`result`)

`steps` (status e corpo de cada pedido, ou a exceção não tratada), `subprocesses` (tmux que muda
estado, com `new-session` completo e todos os `-e`, e todo processo lançado, com argv, cwd e o
ambiente diferente do do backend), `probes` (sondas como `claude --version`), `rust_bridge`,
`runtime_requests`, `signals`, `network`, `tmux_sessions` (estado final), `records` (o que mudou sob
`~/.hangar`: sidecars, travas), `files` (o resto que mudou na raiz) e `diary` (eventos do diário).

## Normalização

A comparação é igualdade exata depois destas trocas, aplicadas igualmente aos dois lados:

1. Caminho da raiz → `<ROOT>`; a forma `sanitize_cwd` dela → `<ROOT_SANITIZED>`; a árvore exportada
   → `<REPO>`; o Python do harness → `<PYTHON>`.
2. UUID e hex de 32 que não aparecem no cenário → `<uuid:N>` / `<hex:N>`, numerados pela primeira
   aparição na ordem fixa da fixture. Prefixo de 16 de uma chave já vista → `<hex:N>[:16]`.
3. Sufixo sorteado do socket do cano (`cano-<chave>-XXXX.sock`) → `<rand4>`.
4. Hex de 64 (HMAC do token do plugin, nome de trava) → `<sha256>`.
5. Data ISO → `<iso>`; data em nome de arquivo do omp → `<iso-file>`.
6. Valor de chave de tempo (`ts`, `created`, `trustedAt`, …) → `<time>`; `ms` → `<ms>`; pid real
   (abaixo de 9 000 000) → `<pid:N>`; `operacao` do diário → `<op:N>`.
7. Diário sem `ts`, `backend`, `pid_backend`, `inicio_backend`, `req`, `origem` e os recursos da
   máquina.
8. Ambiente de processo: só o que difere do ambiente do backend, sem `PWD`, `OLDPWD`, `SHLVL` e `_`.
9. `tmux` de consulta (`has-session`, `list-*`, `display`, `capture-pane`, `show-*`) fora da lista.
   Arquivos internos do git (objetos, reflog, índice) fora do instantâneo.

## Limites

- Relógio e ids não foram injetados: o Python chama `uuid.uuid4`, `secrets.token_hex` e
  `time.time` direto, e o Rust não tem ponto de injeção. A normalização acima faz esse papel.
- O processo real nunca sobe. O argv e o ambiente gravados são os que o Python passaria ao
  `tmux new-session` e ao cano, não os de um processo vivo. O que o CLI faz ao nascer se prova
  depois, numa sessão `cx-*` descartável.
- A troca de modo e o reinício do Codex pelo adapter Python param no cano sem app-server: as
  fixtures do grupo `c` prendem o argv do app-server e o caminho de falha, não o de sucesso.
- O coordenador do runtime não existe no filho (`runtime_coordinator.current()` é `None`): vale o
  ramo Python de cada rota, não o repasse ao Rust do modo `rust`.
- Windows/psmux (`os.name == "nt"`) não roda aqui.
