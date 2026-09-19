<script lang="ts" module>
  import type { SessionInfo } from '@hangar/core';
  import * as m from '../paraglide/messages';
  // Linha do quadro: sessão + servidor dono (pro card falar com o backend certo).
  export interface BoardRow extends SessionInfo { serverId: string }
  // Eco otimista de uma msg mandada do card. `ackAt` = instante em que o /input respondeu 200 (0 =
  // ainda em voo) — é o que deixa retirar o eco por TEMPO, sem casar texto, quando a cauda seguinte
  // chega (ver retirePending no BoardCard).
  export interface PendingMsg { id: string; text: string; ackAt: number }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import BoardCard from '../components/BoardCard.svelte';
  import RateStrip from '../components/RateStrip.svelte';
  import { serverColor } from '../lib/auth';
  import { type State, type DropResult, canPair, canLeave } from '@hangar/core';
  import { stateColors } from '@hangar/core';
  import { sessionsStore } from '../lib/sessionsStore.svelte';
  import { arrastarGrupo, mensagemRecusa, type ChaveSessao } from '../lib/arrastarGrupo.svelte';

  interface Props { onOpenSession: (name: string, serverId: string) => void }
  let { onOpenSession }: Props = $props();

  // Agregação multi-servidor içada pro store único (era a cópia local slots/recompute/connect):
  // 1 SSE por servidor, refcount compartilhado com a Sidebar. retain/release pareados EXATAMENTE 1x.
  onMount(() => {
    sessionsStore.retain();
    return () => sessionsStore.release();
  });

  // AggSession ⊇ BoardRow — o card só precisa de serverId a mais que SessionInfo (o store já enriquece).
  const rows = $derived<BoardRow[]>(sessionsStore.rows);
  const loading = $derived(sessionsStore.loading);
  // Banner de offline mesmo com lista stale: filtra por error SEM gate de loaded.
  const offline = $derived(sessionsStore.byServer.filter((b) => b.error).map((b) => b.server.label));
  const servers = $derived(sessionsStore.servers);

  // Colunas fixas por estado; dentro, atividade recente primeiro (desempate por nome = estável).
  // SEM coluna "dead": esta lista nunca recebe esse estado — o classify() do backend só devolve
  // working/idle/awaiting_input (state.py:168) e `dead` só existe no SSE por-sessão do Chat
  // (state.py:228). Matar uma sessão REMOVE a linha, o card não migra: verificado ao vivo (o card
  // sumiu e a coluna seguiu em 0). A coluna era código morto ocupando largura.
  const COLS: { state: State; title: string }[] = [
    { state: 'awaiting_input', title: m.board_precisa_de_voce() },
    { state: 'working', title: m.board_trabalhando() },
    { state: 'idle', title: m.board_pronto() },
  ];
  function byRecency(a: BoardRow, b: BoardRow): number {
    return (b.last_activity ?? 0) - (a.last_activity ?? 0) || a.name.localeCompare(b.name);
  }
  const cols = $derived(
    COLS.map((c) => ({ ...c, rows: rows.filter((r) => r.state === c.state).sort(byRecency) })),
  );
  function emptyCopy(state: State): { icon: string; title: string; description: string } {
    if (state === 'awaiting_input') return {
      icon: '✓', title: m.board_vazio_atencao_titulo(), description: m.board_vazio_atencao_desc(),
    };
    if (state === 'working') return {
      icon: '◌', title: m.board_vazio_trabalho_titulo(), description: m.board_vazio_trabalho_desc(),
    };
    return { icon: '○', title: m.board_vazio_pronto_titulo(), description: m.board_vazio_pronto_desc() };
  }

  // Chave do estado içado: a MESMA pros rascunhos, ecos e erros.
  const rowKey = (r: BoardRow) => `${r.serverId}::${r.name}`;

  // ── Arrastar card sobre card -> pedido de grupo (Task 4, mesmo gesto da Sidebar/Task 3) ──
  // O wrapper draggable fica AQUI, fora do BoardCard: o mesmo componente serve o Canvas, onde o
  // arrasto move o card no lugar (Task 5) em vez de pedir grupo.
  function sessionByKey(c: ChaveSessao | null): BoardRow | null {
    if (!c) return null;
    return rows.find((x) => x.serverId === c.serverId && x.name === c.name) ?? null;
  }
  function avaliarDrop(alvo: BoardRow): DropResult | null {
    const origem = sessionByKey(arrastarGrupo.origem);
    return origem ? canPair(origem, alvo) : null;
  }
  function onCardDragStart(e: DragEvent, row: BoardRow) {
    arrastarGrupo.comecar({ serverId: row.serverId, name: row.name });
    e.dataTransfer?.setData('text/plain', row.name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function onCardDragEnd() {
    // soltar()/pedirSaida() já abriram o pedido; só limpa quando o drop saiu fora de qualquer alvo.
    if (!arrastarGrupo.pedido) arrastarGrupo.cancelar();
  }
  function onCardDragEnter(e: DragEvent, row: BoardRow) {
    arrastarGrupo.entrarEm(rowKey(row));
    if (avaliarDrop(row)?.ok) e.preventDefault();
  }
  function onCardDragLeave(e: DragEvent, row: BoardRow) {
    arrastarGrupo.sairDe(rowKey(row));
  }
  function onCardDragOver(e: DragEvent, row: BoardRow) {
    if (!avaliarDrop(row)?.ok) return; // sem preventDefault o navegador já mostra o cursor de recusa
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function onCardDrop(e: DragEvent, row: BoardRow) {
    e.preventDefault();
    if (!avaliarDrop(row)?.ok) return; // dragover já filtrou; reconfere pra não confiar cego no SO
    arrastarGrupo.soltar(rowKey(row));
  }
  // Fundo da coluna (fora de qualquer card): soltar aqui pede saída do grupo da origem — a coluna
  // é consequência do estado, nunca destino do drop.
  function isFundoAlvo(e: DragEvent): boolean {
    return !(e.target as HTMLElement | null)?.closest('.board-card-wrap');
  }
  function onColDragOver(e: DragEvent) {
    if (!isFundoAlvo(e)) return;
    const origem = sessionByKey(arrastarGrupo.origem);
    if (!origem || !canLeave(origem)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function onColDrop(e: DragEvent) {
    if (!isFundoAlvo(e)) return;
    const chave = arrastarGrupo.origem;
    const origem = sessionByKey(chave);
    if (!chave || !origem || !canLeave(origem)) return;
    e.preventDefault();
    arrastarGrupo.pedirSaida(chave);
  }

  // Rascunhos IÇADOS: o card troca de coluna (remonta) justamente quando o Claude termina —
  // o texto que você estava digitando não pode morrer com o card.
  const drafts = new Map<string, string>();

  // Ecos e erro de envio IÇADOS pelo MESMO motivo, agravado: mandar msg de um card `idle` faz o
  // Claude virar `working`, ou seja, o próprio envio MOVE o card de coluna e destrói a instância no
  // meio do await. Guardados aqui, o eco sobrevive à remontagem e o erro sobrevive até ao SUMIÇO da
  // linha. SvelteMap (e não Map, como os drafts): estes o quadro precisa LER de forma reativa — o
  // card re-renderiza com eles e o banner de órfão depende deles (o draft só é semeado no mount).
  const pendings = new SvelteMap<string, PendingMsg[]>();
  const sendErrors = new SvelteMap<string, string>();
  function updatePending(key: string, fn: (prev: PendingMsg[]) => PendingMsg[]) {
    const next = fn(pendings.get(key) ?? []);
    // Apaga a chave vazia: sem isto o Map só cresce (uma entrada morta por sessão já vista).
    if (next.length) pendings.set(key, next);
    else pendings.delete(key);
  }
  function setSendError(key: string, msg: string) {
    if (msg) sendErrors.set(key, msg);
    else sendErrors.delete(key);
  }
  // Erro de envio cuja sessão SUMIU da lista: matar uma sessão REMOVE a linha (o backend nunca emite
  // `dead` nesta lista — classify() só devolve working/idle/awaiting_input, e o marcador dos hooks
  // não emite dead; `dead` só existe no SSE por-sessão do Chat, state.py:228). Ou seja, o 404 do
  // /input chega ~1.5s antes da linha evaporar e levar o card — e o erro junto. Verificado ao vivo.
  // Estes órfãos não têm mais card pra renderizá-los: o quadro guarda o recibo, nomeado e dispensável,
  // senão a msg some calada e você redigita (entrega dobrada — memória `queue-never-retype`).
  const orphanErrors = $derived(
    [...sendErrors].filter(([k]) => !rows.some((r) => rowKey(r) === k)),
  );
</script>

<div class="board">
  <!-- ⚡5h/📅7d por servidor — compartilhado pela conta, então acima de todas as sessões. -->
  <RateStrip buckets={sessionsStore.byServer} />
  {#if offline.length}
    <p class="board-offline">{m.board_sem_conexao()}: {offline.join(', ')}</p>
  {/if}
  <!-- Recibo de msg não entregue a uma sessão que sumiu (o card que mostraria o erro já não existe).
       Clique dispensa. -->
  {#each orphanErrors as [key, msg] (key)}
    <button class="board-senderr" onclick={() => sendErrors.delete(key)} title={m.board_dispensar()}>
      {key.split('::')[1]}: {msg} — {m.board_msg_nao_entregue()}
    </button>
  {/each}
  <div class="board-cols">
    {#each cols as col (col.state)}
      <section class="board-col" style="--col-color: {stateColors[col.state]}">
        <header class="col-head">
          <span class="col-dot" class:pulse={col.state === 'awaiting_input'} aria-hidden="true"></span>
          <span class="col-title">{col.title}</span>
          <span class="col-count">{col.rows.length}</span>
        </header>
        <div class="col-cards" ondragover={onColDragOver} ondrop={onColDrop}>
          {#each col.rows as row (rowKey(row))}
            {@const dropAlvoAtual = arrastarGrupo.alvo === rowKey(row)}
            {@const dropResultado = dropAlvoAtual ? avaliarDrop(row) : null}
            {@const dropRecusa = dropResultado && !dropResultado.ok ? dropResultado.reason : null}
            <div class="board-card-wrap"
                 class:drop-alvo={dropResultado?.ok === true}
                 class:drop-recusado={dropRecusa !== null}
                 title={dropRecusa !== null ? mensagemRecusa(dropRecusa) : undefined}
                 draggable="true"
                 ondragstart={(e) => onCardDragStart(e, row)}
                 ondragend={onCardDragEnd}
                 ondragenter={(e) => onCardDragEnter(e, row)}
                 ondragleave={(e) => onCardDragLeave(e, row)}
                 ondragover={(e) => onCardDragOver(e, row)}
                 ondrop={(e) => onCardDrop(e, row)}>
              <BoardCard
                session={row}
                server={servers.find((s) => s.id === row.serverId)!}
                color={serverColor(row.serverId)}
                draft={drafts.get(rowKey(row)) ?? ''}
                onDraftChange={(t) => drafts.set(rowKey(row), t)}
                pending={pendings.get(rowKey(row)) ?? []}
                updatePending={(fn) => updatePending(rowKey(row), fn)}
                sendError={sendErrors.get(rowKey(row)) ?? ''}
                onSendError={(m) => setSendError(rowKey(row), m)}
                onOpen={() => onOpenSession(row.name, row.serverId)}
              />
            </div>
          {/each}
          {#if col.rows.length === 0}
            {#if loading}
              <div class="col-skeleton" role="status" aria-label={m.comum_carregando()}>
                <span></span><span></span><span></span><span></span>
              </div>
            {:else}
              {@const empty = emptyCopy(col.state)}
              <div class="col-empty">
                <span class="col-empty-icon" aria-hidden="true">{empty.icon}</span>
                <strong>{empty.title}</strong>
                <p>{empty.description}</p>
              </div>
            {/if}
          {/if}
        </div>
      </section>
    {/each}
  </div>
</div>

<style>
  /* Board: colunas de largura FIXA + scroll horizontal. 3×320 + 2×16 de gap + 48 de padding =
     1040px: cabe folgado na tela comum. O scroll fica pra faixa 820–1040px (o desktop começa em
     820px), onde ainda é melhor scrollar que espremer coluna. */
  .board { height: 100%; overflow-x: auto; overflow-y: hidden; padding: 24px; }
  .board-offline { color: var(--warning); font-size: var(--text-xs); margin: 0 0 var(--space-2); }
  /* Mesmo lugar/peso do banner de offline (é a mesma classe de aviso: "isto não chegou"), na cor de
     erro. min-* zerados = escape do alvo global de 44px (o quadro é desktop-only). */
  .board-senderr {
    display: block; text-align: left; padding: 0; margin: 0 0 var(--space-2);
    background: none; border: 0; cursor: pointer; min-height: 0; min-width: 0;
    color: var(--error); font-family: inherit; font-size: var(--text-xs);
  }
  .board-cols { display: flex; gap: 16px; height: 100%; align-items: stretch; }
  /* Coluna NÃO tem fundo próprio nem borda: em dark, tingir fundo por estado mata a hierarquia de
     luminância (o card é que é a superfície). Estado vive só no header. */
  .board-col { flex: 0 0 320px; display: flex; flex-direction: column; min-width: 0; }
  .col-head {
    display: flex; align-items: center; gap: var(--space-2);
    padding: 0 2px var(--space-2);
    border-bottom: 2px solid var(--col-color);   /* única marca de cor da coluna */
  }
  .col-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--col-color); flex-shrink: 0; }
  /* A ÚNICA animação do board: o dot de "Precisa de você". Nada mais pulsa. */
  .col-dot.pulse { animation: dot-pulse 2s var(--ease-in-out) infinite; }
  @keyframes dot-pulse { 50% { opacity: 0.35; transform: scale(0.85); } }
  /* Título da coluna na receita unificada de rótulo de seção (tokens --label-* do app.css): o
     header é ESTRUTURA, não conteúdo — em 14px/510 ele competia com o nome das sessões nos cards.
     Caixa alta miúda recua o header e deixa o card ser o herói. */
  .col-title { font-size: var(--label-size); font-weight: var(--label-weight); letter-spacing: var(--label-tracking); text-transform: uppercase; color: var(--text-muted); }
  /* Contagem em pílula: numero solto ao lado do rótulo lia como mais uma palavra do título. */
  .col-count {
    font-size: var(--label-size); font-weight: var(--label-weight); color: var(--text-secondary);
    background: var(--surface-raised); padding: 1px 7px; border-radius: var(--radius-full);
    font-variant-numeric: tabular-nums;
  }
  .col-cards { flex: 1; overflow-y: auto; padding: var(--space-2) 2px; display: flex; flex-direction: column; gap: var(--space-2); }
  /* O wrapper de arrasto (Task 4) virou o flex item da coluna no lugar do .bcard — herda o
     flex-shrink: 0 que evitava a coluna espremer os cards pra caber. */
  .board-card-wrap { flex-shrink: 0; border-radius: var(--radius-lg); }
  /* Alvo do arrasto: válido acende a borda de accent; recusado avisa sem travar o drop (o
     navegador já nega sozinho por falta de preventDefault) — só o motivo, no title do wrapper.
     Mesma receita da Sidebar (Task 3); sem tingir o fundo aqui porque o .bcard é opaco por cima. */
  .board-card-wrap.drop-alvo { outline: 2px solid var(--accent); outline-offset: -2px; }
  .board-card-wrap.drop-recusado { cursor: not-allowed; outline: 2px dashed var(--text-muted); outline-offset: -2px; }
  .col-empty { color: var(--text-muted); text-align: center; padding: var(--space-8) var(--space-4); }
  .col-empty-icon {
    display: grid; place-items: center; width: 40px; height: 40px; margin: 0 auto var(--space-3);
    border-radius: var(--radius-md); background: var(--fill-subtle); color: var(--col-color);
    font-size: var(--text-lg);
  }
  .col-empty strong { display: block; color: var(--text-primary); font-size: var(--text-sm); font-weight: 600; }
  .col-empty p { margin: var(--space-2) 0 0; font-size: var(--text-xs); line-height: 1.45; }
  .col-skeleton {
    display: flex; flex-direction: column; gap: 9px; padding: var(--space-4);
    border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-card);
  }
  .col-skeleton span { height: 10px; border-radius: var(--radius-full); background: var(--fill-subtle); }
  .col-skeleton span:nth-child(1) { width: 42%; }
  .col-skeleton span:nth-child(2) { width: 72%; }
  .col-skeleton span:nth-child(3) { width: 92%; }
  .col-skeleton span:nth-child(4) { width: 61%; }
</style>
