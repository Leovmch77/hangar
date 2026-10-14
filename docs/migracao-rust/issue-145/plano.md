# Issue #145 — o Python sai do arquivo de estado da fila

Atualizado em 2026-10-14. Branch `fix/145-runtime-state-python-readers`.

## Problema

No Windows, o Rust troca o arquivo de estado da fila (`runtime/<chave>.json`) por `tmp+replace`
enquanto o Python o lê com `Path.read_bytes()`, que abre sem `FILE_SHARE_DELETE`. A leitura recebe
`PermissionError`, e um leitor Python com o arquivo aberto faz a troca do Rust falhar (medição na
issue). O `std::fs::read` do Rust não tem o problema.

Com o Rust de pé, cinco pontos do Python leem esse arquivo:

| Ponto | Quando | Destino neste trabalho |
|---|---|---|
| `runtime_policy.py` `session.patch_meta` | troca de modelo, esforço, janela, cano do Claude sem terminal | Rust |
| `internal_api.py` conferência do `native_message` | cada recado nativo de sessão sem terminal | Rust |
| `runtime_coordinator.native_receipt` | cada recibo `peer_message_status` | Rust |
| `runtime_adapter.binding()` (geração) | abrir, reabrir, renomear | fica: abertura de sessão |
| `runtime_coordinator._has_pending` | reabertura depois de queda do Rust | fica: abertura de sessão |

Os dois últimos só saem com a migração da abertura de sessão (trabalho próprio, ainda sem desenho)
e vão para uma issue nova, junto com a trava do orq no `/proc/locks` (item 2 da #145).

## Mudança no plano de migração

A 5B decidiu que o Rust não grava o sidecar do Claude, e por isso o `session.patch_meta` ficou no
Python. O #158 já desfez isso na prática (o Rust grava o sidecar do Codex e o do Claude no `/clear`).
Aqui o resto do `session.patch_meta` e do `session.clear_cano` do Claude e o `native_message` passam
ao Rust, e o Python deixa de atender esses serviços: sem cópia de reserva na política
(`/internal/runtime/policy`). A reserva do processo inteiro (modo `python`) não usa esses serviços e
continua como está.

## Partes

### 1. Sidecar do Claude com dois escritores coordenados

O Python continua gravando o sidecar do Claude na abertura, troca de conta, renomear e relançar.
Com o Rust gravando também, os dois passam a usar a mesma coordenação que o Codex já tem:

- trava `<nome>.lock` na pasta `claude-headless` (Python: `flock`/`msvcrt.locking` do byte 0, como
  o `_locked` do Codex; Rust: `File::lock`), segurada no ler-alterar-gravar dos dois lados;
- leitura que espera a troca terminar no Windows (Python e Rust), em vez de devolver "sem sidecar"
  quando cai no meio de um `replace`. Vale também para o `load` do sidecar do Codex.

### 2. `session.patch_meta` e `session.clear_cano` do Claude no Rust

Novo `runtime/claude_sidecar.rs`, escrito a partir do `run("session.patch_meta")` e do `clear_cano`
do `runtime_policy.py` como referência: catálogo de campos, recusa como velho do campo que difere da
vista salva, sidecar de outra vida é erro, `remember` das customizações quando a conversa muda (com
`problema` se falhar). O ator e o `launch_policy` usam o local, como já fazem com o Codex. O
`lifecycle::patch_sidecar` passa a gravar sob a mesma trava.

### 3. `native_message` sem terminal no Rust

O ator escreve o recado direto no socket do Claude, com o escritor e o envelope que o caminho com
terminal já usa (`terminal_input.rs`). O socket sai do registro do próprio Claude
(`<config>/sessions/<pid>.json` com `sessionId` da conversa, processo vivo, socket existente), como o
`socket_da_sessao` do Python. O `msg_id` continua `uuid5(URL, "hangar:<chave>:<operação>")`, o diário
da tentativa não muda e `unknown` nunca volta à fila. Fora do Unix a resposta é `not_written`.

### 4. Recibos no Rust

O Rust liga a própria caixa de entrada (`cc-socks/<pid>.sock`, ligada no primeiro recado) e a usa
como `from` dos recados que escreve, com e sem terminal. Hoje o caminho com terminal manda
`uds:hangar-<pid>`, endereço que não existe, e o recibo de recado retido ou recusado se perde. O
recibo encontra a sessão por um índice em memória `msg_id → sessão` e aplica o mesmo `finish` e o
`confirm` que o Python mandava pela operação `queue`. A caixa do Python continua para os recados que
nascem nele (grupo, par, broadcast); o `native_receipt` do coordenador fica só no modo `python`.

### 5. Contrato

Os serviços `session.patch_meta`/`session.clear_cano` do Claude e `native_message` saem da política
do Python, e com eles a rota `/internal/runtime/policy` inteira (nada mais a usava): o
`runtime_policy.py`, a chamada HTTP do `PolicyClient` e o ramo `launch_env` do Claude, que o Python já
recusava. Sobem `RUST_SERVER_PROTOCOL` e `INTERNAL_PROTOCOL` juntos (68).

## Verificação

- Testes Rust das recusas e resultados que os testes Python de `runtime_policy` conferiam,
  escritos antes da remoção (mesmas entradas, mesmas respostas).
- Teste de dois processos no sidecar do Claude: Python e Rust gravando campos diferentes em laço,
  nenhum campo perdido.
- VM Windows: o laço gravador × leitores da medição da issue, antes e depois, no arquivo de estado e
  no sidecar do Claude.
- Uso real: sessão Claude sem terminal trocando modelo e esforço, recado nativo entre sessões e
  recibo de recado retido.
