# Contabilidade de tokens e cache no Claude e no Codex

Pesquisa feita em 18/09/2026 com documentação oficial da Anthropic, documentação oficial da
OpenAI e código oficial do Codex. O objetivo é definir o que cada contador significa antes de
exibi-lo nas telas de custos e uso.

## Conclusão

Separar `input`, `output`, `cache_write` e `cache_read` está correto, mas `input` precisa
significar **entrada comum, sem os tokens lidos ou escritos no cache**. A conversão depende da
fonte:

- No Claude, os três contadores de entrada já são parcelas separadas. A própria Anthropic define
  o total como `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` e explica
  que `input_tokens` contém somente o trecho que não foi lido nem criado no cache
  ([Prompt caching — Tracking cache performance](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)).
- Na OpenAI, `usage.input_tokens` é o total de entrada e os campos `cached_tokens` e
  `cache_write_tokens` são parcelas desse total. O exemplo oficial de custo calcula entrada
  comum como `input_tokens - cached_tokens - cache_write_tokens`
  ([Prompt caching — Calculate input cost](https://developers.openai.com/api/docs/guides/prompt-caching#calculate-input-cost)).

Portanto, depois de normalizar cada fonte, estes totais não duplicam tokens:

```text
input_processado = input_sem_cache + cache_write + cache_read
total_processado = input_processado + output
```

O código atual segue essa regra. Não encontrei dupla contagem na fórmula nem na agregação.
Existe, porém, risco de **subcontagem de escrita de cache do Codex** quando o rollout antigo ou o
provedor não informa `cache_write_input_tokens`: hoje ausência e zero viram a mesma coisa.

## Semântica oficial por provedor

| Campo normalizado | Claude/Anthropic | OpenAI/Codex |
|---|---|---|
| `input` | `usage.input_tokens`, já sem cache | `usage.input_tokens - cached_input_tokens - cache_write_input_tokens` |
| `cache_read` | `usage.cache_read_input_tokens`, parcela própria | `usage.input_tokens_details.cached_tokens`, subconjunto de `input_tokens` |
| `cache_write` | `usage.cache_creation_input_tokens`, parcela própria | `usage.input_tokens_details.cache_write_tokens`, subconjunto de `input_tokens` |
| `output` | `usage.output_tokens`, total de saída inclusive raciocínio | `usage.output_tokens`, total de saída inclusive raciocínio |

### Claude/Anthropic

A Anthropic documenta que:

- `cache_creation_input_tokens` é o que foi escrito no cache;
- `cache_read_input_tokens` é o que foi recuperado do cache;
- `input_tokens` é somente o que ficou depois do último ponto de cache;
- os três somados formam a entrada total
  ([documentação oficial](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)).

As tarifas também são categorias separadas: escrita de 5 minutos custa 1,25 vez a entrada
comum, escrita de 1 hora custa 2 vezes e leitura normalmente custa 0,1 vez. Há exceções por
modelo, então a tarifa deve vir do modelo efetivamente usado
([Prompt caching — pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing)).

`cache_creation_input_tokens` é o total das escritas. O objeto `cache_creation` detalha esse
total entre `ephemeral_5m_input_tokens` e `ephemeral_1h_input_tokens`
([Prompt caching — resposta de uso](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)).

Tokens de raciocínio já estão dentro de `output_tokens`; `output_tokens_details.thinking_tokens`
é apenas uma decomposição e não pode ser somado novamente
([Steering thinking — Pricing](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost#pricing)).

### OpenAI/Codex

A documentação da OpenAI diz explicitamente que a tarifa de escrita não é adicional: cada token
de entrada recebe **uma** das tarifas — comum, leitura de cache ou escrita de cache
([Prompt caching — Why prompt caching matters](https://developers.openai.com/api/docs/guides/prompt-caching#why-prompt-caching-matters)).
O cálculo oficial usa:

```text
ordinary_input = input_tokens - cached_tokens - cache_write_tokens
input_cost = ordinary_input * input_rate
           + cached_tokens * cache_read_rate
           + cache_write_tokens * cache_write_rate
```

([exemplo oficial completo](https://developers.openai.com/api/docs/guides/prompt-caching#calculate-input-cost)).

No GPT-5.6 e posteriores, a documentação atual informa 1,25 vez para escrita e 0,1 vez para
leitura, ressalvando que os preços variam por modelo
([Prompt caching — GPT-5.6 and later](https://developers.openai.com/api/docs/guides/prompt-caching#gpt-56-and-later)).

O Codex atual expõe no uso do turno `input_tokens`, `cached_input_tokens`,
`cache_write_input_tokens`, `output_tokens` e `reasoning_output_tokens`
([código oficial do Codex](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)).
Os tokens de raciocínio já pertencem à saída: a documentação oficial da Responses API define
que eles são cobrados como saída, e seu exemplo mostra `75 + 1186 = 1261` mesmo com 1024 tokens
de raciocínio dentro dos 1186 de saída
([Reasoning models — Controlling costs](https://developers.openai.com/api/docs/guides/reasoning#controlling-costs)).

## Comparação com o código atual

### Claude

`backend/app/costs_claude_transcript.py:132-145` copia diretamente as quatro parcelas do bloco
`usage`. Isso está correto porque, no formato Anthropic, `input_tokens` já exclui leitura e
criação de cache.

O leitor também:

- substitui blocos repetidos da mesma resposta pela identidade `(requestId, message.id)`, em vez
  de somá-los (`backend/app/costs_claude_transcript.py:135-146`);
- soma respostas distintas por dia, modelo, projeto e modo rápido
  (`backend/app/costs_claude_transcript.py:147-157`);
- guarda a parcela de escrita de 1 hora separadamente, limitada ao total de criação
  (`backend/app/costs_claude_transcript.py:137-145`).

Isso evita dupla contagem dos blocos repetidos e permite aplicar a diferença da tarifa de 1 hora.

### Codex

`backend/app/costs_sources.py:247-255` faz exatamente a normalização exigida pela OpenAI:

```text
cache_read = min(input_tokens, cached_input_tokens)
cache_write = min(input_tokens - cache_read, cache_write_input_tokens)
input = input_tokens - cache_read - cache_write
```

Os limites impedem valor negativo ou soma das parcelas acima da entrada total. O leitor ainda:

- elimina registros modernos repetidos por `response_id`
  (`backend/app/costs_sources.py:215-229`);
- transforma os snapshots cumulativos antigos em deltas
  (`backend/app/costs_sources.py:230-244`);
- reconcilia o registro moderno por resposta com o snapshot legado para não somar ambos
  (`backend/app/costs_sources.py:257-290`).

Para o formato esperado do Codex atual, isso evita dupla contagem. A implementação oficial do
Codex também trata `cache_write_input_tokens` como campo próprio do uso do turno
([código oficial](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)).

### Agregação e custo

`backend/app/costs.py:53-64` soma as quatro categorias normalizadas uma vez cada. Como `input` já
é entrada sem cache, a soma não repete cache.

`backend/app/costs.py:42-50` aplica uma tarifa a cada categoria. Para Anthropic, a escrita de 1
hora recebe o complemento entre a tarifa normal de criação e 2 vezes a tarifa de entrada. Isso
corresponde à regra oficial de 1,25 vez para 5 minutos e 2 vezes para 1 hora.

`backend/app/costs.py:161-175` também está coerente:

- `custo_sem_cache` reprecifica `input + cache_write + cache_read` como entrada comum;
- `equivalente_cobrado` pesa cada parcela pela tarifa correspondente;
- `output` não recebe `reasoning_output_tokens` novamente.

## Riscos que permanecem

1. **Escrita de cache ausente vira zero no Codex.** `backend/app/costs_sources.py:247-249` usa
   zero quando `cache_write_input_tokens` não existe. O Codex só passou a transportar esse campo
   pelo protocolo, SDK e rollout depois de uma correção recente; rollouts produzidos antes dela
   não permitem reconstruir a escrita. O histórico oficial do problema está em
   [openai/codex#32479](https://github.com/openai/codex/issues/32479), e o código atual já contém
   o campo. Consequência: histórico antigo pode **subestimar**, mas não duplicar, o custo.

2. **Zero informado pelo provedor não prova ausência de cobrança.** O parser só conhece o que o
   rollout preservou. Se um gateway ou uma resposta de assinatura omitir a decomposição, não há
   como inferir escrita a partir do total sem inventar dado. A tela deve distinguir “0 informado”
   de “detalhe indisponível” quando o formato de origem permitir essa distinção.

3. **Preço e volume são fatos diferentes.** Os contadores podem estar corretos enquanto a tarifa
   está desatualizada ou estimada. `costs.py` calcula a partir do catálogo de `pricing.py`; a tela
   já recebe `origin` e `cache_estimado` e deve deixar essa condição visível. Os preços oficiais
   variam por modelo e modalidade, como alertam as páginas de cache da
   [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing) e da
   [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching#why-prompt-caching-matters).

4. **Tokens locais não são a unidade da cota de assinatura.** Eles servem para volume e custo
   estimado por tarifa de API. Não provam diretamente quanto uma conta Pro/Plus consumiu da sua
   janela, porque essa conversão é mantida pelo provedor e não aparece nos campos de uso do
   rollout.

## Como a tela deve apresentar

Para não esconder custo nem misturar grandezas:

- mostrar separadamente **Entrada sem cache**, **Saída**, **Escrita no cache** e **Leitura do
  cache**, com tokens e custo de cada uma;
- chamar a soma das três parcelas de entrada de **Entrada processada**, não de “entrada sem
  cache” nem simplesmente “input”;
- manter **Total processado** como `entrada processada + saída`;
- mostrar a economia estimada como comparação com os mesmos tokens de entrada todos cobrados à
  tarifa comum;
- ordenar agentes e plugins por custo, mas conservar a decomposição para deixar claro quando um
  volume enorme é leitura barata de cache;
- não apresentar presença estimada de uma skill no contexto como gasto medido. Skills sem uso
  próprio no transcript devem continuar em uma seção de carga/contexto, separada do custo real
  dos agentes.
