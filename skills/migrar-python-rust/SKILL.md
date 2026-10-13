---
name: migrar-python-rust
description: |
  Use quando o pedido é migrar, portar ou "levar para o Rust" uma responsabilidade que hoje mora
  no backend Python do Hangar (backend/app) para o hangar-server (crates/): rota, ponte, poller,
  fila, estado ou integração que já existe no Python. NÃO use para recurso novo sem equivalente
  Python (nasce direto no Rust) nem para correção pontual de bug em código já migrado.
---

# Migrar do Python para o Rust

O que o Python aprendeu fica, sem exceção; o jeito Python de fazer não precisa ficar. Nenhuma
linha de Rust antes do inventário e dos contratos aprovados pelo usuário. Cada fase grava um
arquivo em `.superpowers/sdd/<data>-<assunto>/`: `escopo.md`, `inventario-<area>.md`,
`decisoes.md`, `conferencia.md`, `medicao.md`.

Toda diferença entre Python e Rust é classificada pelo usuário (aceitável, bug do Python, fora de
escopo), nunca pelo agente: registre e pergunte, uma pergunta por vez, opções letradas.

## 1. Delimitar o caminho inteiro → `escopo.md`

1. Escreva a responsabilidade numa frase ("quem responde GET /api/X e lê as fontes Y").
2. Liste todo chamador dos dois lados: rotas FastAPI, `/internal/*`, pontes `*_bridge`,
   `to_thread`/pool que esperam o Rust, chamadas do Rust ao Python, clientes (`packages/core`,
   `desktop-native/`, `mobile/`), `scripts/`, hooks e plugins. Busca sem filtro de pasta; com
   busca parcial, nunca afirme "ninguém mais chama". Cada chamador vira um item do plano.
   Leia antes uma migração já feita no repo (a da lista do dono ou a de custos, em
   `docs/decisoes/plataforma.md`) como molde de rota, ponte e repasse.
3. Marque toda volta Rust → Python → Rust e Python → Rust → Python: todas somem.
4. O caminho Python sai no mesmo trabalho. Nas portas 8766 e 8768 fica só o repasse ao Rust, num
   sentido. No modo `python` do Supervisor a rota responde um código de erro próprio, sem reserva.
5. Divida em rotas. Cada rota migra inteira, uma por vez, atrás do Supervisor; nunca tudo junto.
6. **Contrato por rota**, aprovado antes do Rust: o que se compara (status, corpo JSON, eventos
   SSE, efeitos em disco, no tmux e em processos) e a lista fechada de diferenças aceitas, cada
   uma com a regra de comparação e o porquê. O que não está na lista sai igual.

## 2. Inventário do que o Python aprendeu → `inventario-<area>.md`

Um subagente só de leitura por arquivo ou área, todos em paralelo. Cada um lista comportamentos
observáveis, não funções. Fontes, todas obrigatórias:

- **Código:** cada ramo, `except`, valor padrão, prazo, repetição, cache, trava, ordem de chamadas.
- **Comentário de porquê:** cada um vira item.
- **Testes Python:** cada teste é um comportamento; nome e asserções são a especificação.
- **Histórico:** `git log --follow` e `git blame`; cada commit `fix(...)` vira item com hash, e o
  diff dele diz o caso exato.
- **Regras:** entradas de `docs/decisoes/*.md` e do `CLAUDE.md` sobre a área.
- **Uso real:** diário e logs (`log_paths.base()`; no Windows `%LOCALAPPDATA%\hangar\logs\diario`):
  códigos de erro da área, `pool.espera`, `loop.atraso`, rotas com 1 s ou mais.
- **Plataforma:** ramos `os.name`, Windows, psmux, encoding, conexão recusada.

Linha: `ID | comportamento que precisa ficar | mecanismo do Python | fonte (arquivo:linha, teste,
commit, decisão) | plataforma`. Mostre a contagem por área e peça a aprovação do inventário.

## 3. Requisito, mecanismo e bug → `decisoes.md`

1. **Comportamento** é requisito: entra no Rust como está. Caso que o Python aprendeu não se reabre.
2. **Mecanismo do Python** (pool/`to_thread`, polling com `sleep`, captura repetida, cache com
   prazo, subprocesso por chamada, volta Python↔Rust) é redesenhado. Grave o equivalente Rust e o
   porquê: evento em vez de polling, async sem pool, estado compartilhado, uma fonte por chave.
   Contorno que só existia por limite do Python não é copiado.
3. **Bug do Python** achado no caminho: registre e pergunte. Sem outra resposta, o Rust reproduz o
   bug e a correção vem em commit próprio, depois da paridade.
4. Diferença aprovada entra no registro (item, antes, depois, motivo, resposta do usuário) e na
   lista fechada do contrato da rota.
5. Sinal do Claude Code ou do Codex vence adivinhação por transcript ou pane: hook, evento do
   stream-json, campo da statusline, pedido de controle. Confirme no binário instalado e numa
   sessão `cx-*` descartável antes de usar.

## 4. Prender o comportamento antes de portar

1. **Caracterização:** valor esperado só vem de executar o Python, nunca de ler o código. Fixture
   de contrato em `backend/tests/fixtures/contract/` grava o commit de origem e o comando que a
   gerou; nunca é editada à mão.
2. **Diferencial:** enquanto o Python existe, as mesmas entradas vão aos dois lados. Cada lado roda
   isolado, partindo do mesmo estado inicial restaurado (config dir temporário, sidecars; nunca o
   Rust sobre o estado que o Python já alterou), com o mesmo relógio e os mesmos ids injetados. Compara saída e efeitos (arquivos escritos, teclas enviadas ao tmux,
   processos abertos) pela regra do contrato.
3. **Entradas** cruzam cada armadilha abaixo e cada ramo de erro do inventário.
4. **Teste não é ajustado para passar:** sem truncar saída, sem comparar mais frouxo que o
   contrato, sem gravar a saída do Rust como esperada; Python ausente faz o teste falhar dizendo o
   que não rodou, nunca pular calado.
5. **Armadilhas de semântica**, conferidas em cada item que as toca:
   - inteiro sem limite no Python × largura fixa no Rust;
   - `//` e `%` arredondam para baixo (`div_euclid`/`rem_euclid`), `round()` é meio-par;
   - `float()` aceita `"1e3"`, `"nan"`, `"inf"`, espaços; `json.dumps` escreve `1.0` e
     `NaN`/`Infinity`, que o serde recusa;
   - ordem de chave de `dict`/JSON (o `HashMap` não preserva);
   - `re.match` é ancorado no início, `Regex::is_match` não;
   - `set`/`frozenset` são iguais sem ordem, `Vec` não;
   - `len` e fatia contam code points, não bytes; surrogates soltos de `surrogateescape` e de
     JSON que o serde recusa;
   - `None`, chave ausente e `null` são três casos; `""`, `0` e `[]` são falsos no Python;
   - entrada que o Python recusava e o Rust passa a aceitar.

## 5. Implementar item a item

1. Um teste Rust por item, pela interface pública (rota, ator, fila), com o esperado vindo da
   fixture, do teste Python ou do commit de fix. RED com falha de asserção, depois GREEN.
2. Diferença achada: primeiro um teste que falha por ela, depois o conserto; então varra a classe
   inteira (os casos irmãos) e acrescente ao inventário a linha que faltava, com o motivo de não
   ter sido pega.
3. Fixtures reais (pane capturado, JSONL real, payload medido), nunca inventadas.
4. Toda entrada externa (JSONL, texto de pane, payload HTTP, sidecar) passa por `proptest` ou
   fuzz sem pânico.
5. Falha visível com código; nunca sucesso falso; nunca reserva Python com o Rust de pé.
6. Um escritor por arquivo. Uma compilação pesada por vez: `nice -n 19 ionice -c 3`, `-j 3`,
   `CARGO_TARGET_DIR` próprio.
7. Contrato interno mudou (rota `/internal`, evento, variável do filho): suba `INTERNAL_PROTOCOL`
   (Rust) e `RUST_SERVER_PROTOCOL` (Python) no mesmo commit.

## 6. Portões de prova

Todos passam antes de dizer "migrado":

1. **Conferência item a item** (`conferencia.md`): cada ID com situação final, `igual` com o
   teste, `muda` com a linha do registro ou `sai` com a prova de que ninguém depende. Item sem
   situação = não pronto.
2. **Relatório do diferencial** (`conferencia.md`): entradas comparadas, diferenças duras (status,
   campo, código, efeito) e moles (texto) por tipo. Zero diferenças sobre poucas entradas não fecha.
3. **Revisão de falhas caladas:** um revisor independente (`ecc:silent-failure-hunter`) sobre o
   diff inteiro; correção volta ao portão 1.
4. **Caminho inteiro:** `grep` nos dois lados pelos chamadores do `escopo.md`; nenhum aponta para
   o Python, nenhuma volta entre os dois. Antes de apagar o Python, cada pytest da área tem par
   Rust no `conferencia.md`, e as entradas gravadas ficam congeladas e seguem lidas pelos testes
   Rust.
5. **Uso real:** release compilado de checkout limpo do commit, com o Python na mesma versão do
   contrato, no Linux e no Windows (DELPHI-02) quando a área tem ramo de plataforma.
6. **Desempenho** (`medicao.md`): o mesmo roteiro antes e depois, p50/p95 das rotas, CPU e
   memória, também numa máquina Windows fraca como a DELPHI-02 (4 vCPU), e os marcadores do
   diário (`pool.espera`, `loop.atraso`, rotas ≥ 1 s). Procure volta Python → Rust → Python
   prendendo o pool e fonte apontando para endereço recusado: o `GET /api/credenciais` fazia
   Python → Rust → Python, prendia o pool de 8 threads de uma VM de 4 vCPU e já fez um envio de
   mensagem esperar 67 s; uma fonte em `127.0.0.1` recusado custava 2 s por ciclo no Windows.
   Mais lento sem motivo registrado não fecha.

Done when: os arquivos de todas as fases existem, os seis portões passaram, `conferencia.md` não
tem item aberto e o caminho Python da responsabilidade foi apagado.
