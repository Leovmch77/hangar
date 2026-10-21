<script lang="ts">
  // Painel "Na fila" acima do composer (estilo do T3): o que espera a vez no Hangar, com reordenar, editar,
  // orientar e apagar por linha. Sem ações (Pi, omp, Kimi, modo python), só a lista.
  import * as m from '../paraglide/messages';
  import { contextRefsPlainText, dropTarget, moveTarget, type QueuePanel } from '@hangar/core';
  import IconListOrdered from './icons/IconListOrdered.svelte';
  import IconGripVertical from './icons/IconGripVertical.svelte';
  import IconPencil from './icons/IconPencil.svelte';
  import IconCornerUpRight from './icons/IconCornerUpRight.svelte';
  import IconX from './icons/IconX.svelte';
  import IconChevronDown from './icons/IconChevronDown.svelte';

  let { panel, editingId = null, busy = false, stalled = false, onEdit, onCancelEdit, onSteer, onRemove, onReorder, onReopen }: {
    panel: QueuePanel; editingId?: string | null; busy?: boolean;
    /** `headless_delivery_stalled`: a sessão sem terminal está viva e surda, e o servidor não a reabre sozinho. */
    stalled?: boolean;
    onEdit: (id: string) => void; onCancelEdit: () => void; onSteer: (id: string) => void;
    onRemove: (id: string) => void; onReorder: (id: string, beforeId: string | null) => void;
    /** Ausente (quem só lê) = só o aviso. A promessa diz quando o pedido acabou. */
    onReopen?: () => Promise<void>;
  } = $props();

  let expanded = $state(true);
  let reopening = $state(false);
  async function reopen() {
    if (!onReopen || reopening) return;
    reopening = true;
    try { await onReopen(); } finally { reopening = false; }
  }
  // Linha com o texto inteiro à mostra: no toque não existe `title`, então tocar no texto abre e fecha.
  let fullId = $state<string | null>(null);
  let listEl = $state<HTMLOListElement>();
  // Arrasto por ponteiro, não o HTML5: o arrasto nativo não anda com o dedo no celular, e só a alça arma.
  let drag = $state<{ id: string; pointer: number; startY: number; moved: boolean } | null>(null);
  let dropAt = $state<{ id: string; after: boolean } | null>(null);
  const listId = $props.id();

  const order = () => panel.entries.map((e) => e.id).join('\n');
  // Mover o nó da linha tira o foco da alça; quem moveu pelas setas continua com o foco nela.
  let keyboardMove: { id: string; order: string } | null = null;
  $effect(() => {
    const now = order();
    if (!keyboardMove || keyboardMove.order === now) return;
    const id = keyboardMove.id;
    keyboardMove = null;
    listEl?.querySelector<HTMLElement>(`.qp-row[data-id="${CSS.escape(id)}"] .qp-grip`)?.focus();
  });

  function gripKey(e: KeyboardEvent, id: string) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (busy) return;
    const before = moveTarget(panel.entries, id, e.key === 'ArrowUp' ? -1 : 1);
    if (before === undefined) return;
    keyboardMove = { id, order: order() };
    onReorder(id, before);
  }

  function gripDown(e: PointerEvent, id: string) {
    if (busy || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag = { id, pointer: e.pointerId, startY: e.clientY, moved: false };
  }
  function gripMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    // Um toque parado na alça é foco (para as setas), não arrasto.
    if (!drag.moved && Math.abs(e.clientY - drag.startY) < 4) return;
    drag.moved = true;
    const next = rowAt(e.clientY);
    if (next?.id !== dropAt?.id || next?.after !== dropAt?.after) dropAt = next;
  }
  function gripUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const from = drag.id, at = drag.moved ? dropAt : null;
    dragEnd();
    if (!at || busy) return;
    const before = dropTarget(panel.entries, from, at.id, at.after);
    if (before !== undefined) onReorder(from, before);
  }
  function dragEnd() { drag = null; dropAt = null; boxes = null; }

  // Caixas das linhas lidas uma vez por arrasto: a lista que rola ou muda de ordem as relê.
  let boxes: { order: string; rows: { id: string; top: number; bottom: number }[] } | null = null;

  // A linha sob o ponteiro e a metade dela; acima da primeira ou abaixo da última prende nas pontas.
  function rowAt(y: number): { id: string; after: boolean } | null {
    const now = order();
    if (boxes?.order !== now) {
      const rows = [...(listEl?.querySelectorAll<HTMLElement>('.qp-row[data-id]') ?? [])].map((row) => {
        const box = row.getBoundingClientRect();
        return { id: row.dataset.id!, top: box.top, bottom: box.bottom };
      });
      boxes = { order: now, rows };
    }
    const rows = boxes.rows;
    if (!rows.length) return null;
    for (const row of rows) {
      if (y < row.bottom) return { id: row.id, after: y > (row.top + row.bottom) / 2 };
    }
    return { id: rows[rows.length - 1].id, after: true };
  }
</script>

{#if panel.entries.length > 0}
  <section class="qp" aria-label={m.composer_fila_contagem({ n: panel.entries.length })}>
    <button type="button" class="qp-header" aria-expanded={expanded} aria-controls={listId}
            aria-label={expanded ? m.queue_panel_collapse() : m.queue_panel_expand()}
            onpointerdown={(e) => e.preventDefault()} onclick={() => (expanded = !expanded)}>
      <IconListOrdered size={14} />
      <span class="qp-title">{m.queue_panel_title()}</span>
      <span class="qp-count">{panel.entries.length}</span>
      <span class="qp-chevron" class:closed={!expanded}><IconChevronDown size={14} /></span>
    </button>
    {#if stalled}
      <!-- Fora da lista: o painel recolhido ainda mostra o bloqueio. -->
      <div class="qp-stalled">
        <p role="status">{m.problema_headless_delivery_stalled()}</p>
        {#if onReopen}
          <button type="button" disabled={reopening} onclick={reopen}>{m.reabrir_sessao_presa()}</button>
        {/if}
      </div>
    {/if}
    <ol class="qp-list" id={listId} hidden={!expanded} bind:this={listEl} onscroll={() => (boxes = null)}>
      {#each panel.entries as entry (entry.id)}
        {@const editing = editingId === entry.id}
        <li class="qp-row" data-id={entry.id} class:editing class:full={fullId === entry.id}
            class:lifted={drag?.moved && drag.id === entry.id} aria-current={editing ? 'true' : undefined}
            class:drop-before={dropAt?.id === entry.id && !dropAt.after}
            class:drop-after={dropAt?.id === entry.id && dropAt.after}>
          {#if panel.actions}
            <button type="button" class="qp-grip" aria-label={m.queue_panel_reorder()} title={m.queue_panel_reorder()} disabled={busy}
                    onpointerdown={(e) => gripDown(e, entry.id)} onpointermove={gripMove} onpointerup={gripUp}
                    onpointercancel={dragEnd} onkeydown={(e) => gripKey(e, entry.id)}>
              <IconGripVertical size={14} />
            </button>
          {/if}
          <!-- Botão com cara de texto: toque, clique e teclado mostram a mensagem inteira; o `title` serve ao ponteiro. -->
          <!-- Citação vira rótulo curto: o bloco <hangar-ref> inteiro não cabe numa linha de fila. -->
          <button type="button" class="qp-text" title={contextRefsPlainText(entry.text)} aria-expanded={fullId === entry.id}
                  onclick={() => (fullId = fullId === entry.id ? null : entry.id)}>{#if editing}<span class="sr-only">{m.queue_panel_editing()}: </span>{/if}{contextRefsPlainText(entry.text)}</button>
          {#if panel.actions}
            {#if editing}
              <button type="button" class="qp-cancel" disabled={busy} onclick={onCancelEdit}>{m.comum_cancelar()}</button>
            {:else}
              <button type="button" class="qp-edit" aria-label={m.queue_panel_edit()} title={m.queue_panel_edit()} disabled={busy}
                      onclick={() => onEdit(entry.id)}><IconPencil size={14} /></button>
              <button type="button" class="qp-steer" disabled={busy} title={m.codex_orientar_ajuda()}
                      onclick={() => onSteer(entry.id)}><IconCornerUpRight size={14} /><span>{m.codex_orientar()}</span></button>
              <button type="button" class="qp-remove" aria-label={m.queue_panel_remove()} title={m.queue_panel_remove()} disabled={busy}
                      onclick={() => onRemove(entry.id)}><IconX size={14} /></button>
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  /* Vidro como a aba de status do composer: o material vem do ::before, nunca um fundo opaco próprio. */
  .qp {
    position: relative;
    isolation: isolate;
    margin: 0 var(--space-4) -1px;
    border: 1px solid var(--glass-border);
    border-bottom: 0;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    box-shadow: inset 0 1px 1px var(--glass-specular);
    overflow: hidden;
    background: transparent;
  }
  .qp::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    pointer-events: none;
    background: var(--chrome-bg);
  }
  :global(html[data-liquid]) .qp::before {
    background: var(--glass-bg);
    backdrop-filter: url(#liquid-glass) blur(16px) saturate(180%);
  }
  .qp-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-height: 32px;
    padding: 0 12px;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-size: 12.5px;
    cursor: pointer;
  }
  .qp-title { font-weight: 600; }
  .qp-count { margin-left: auto; font-variant-numeric: tabular-nums; }
  .qp-chevron { display: inline-flex; transition: transform 150ms ease; }
  .qp-chevron.closed { transform: rotate(180deg); }
  /* Overflow próprio: `relative` segura o `.sr-only` absoluto aqui dentro (regra do CLAUDE.md). */
  .qp-list {
    position: relative;
    list-style: none;
    margin: 0;
    padding: 0 6px 6px;
    max-height: 8.5rem;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .qp-list[hidden] { display: none; }
  .qp-stalled {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 12px 6px;
    font-size: var(--text-xs);
    color: var(--error);
  }
  .qp-stalled p { margin: 0; flex: 1; min-width: 0; }
  .qp-stalled button {
    flex-shrink: 0;
    min-height: 28px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    color: var(--text-primary);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    cursor: pointer;
  }
  .qp-stalled button:disabled { opacity: 0.4; cursor: default; }
  @media (pointer: coarse) { .qp-stalled button { min-height: 40px; } }
  .qp-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 32px;
    padding: 0 2px;
    border-radius: 8px;
  }
  .qp-row.editing { background: var(--accent-dim); }
  .qp-row.lifted { opacity: 0.5; }
  .qp-row.drop-before::before,
  .qp-row.drop-after::after {
    content: '';
    position: absolute;
    left: 4px;
    right: 4px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
    pointer-events: none;
  }
  .qp-row.drop-before::before { top: 0; }
  .qp-row.drop-after::after { bottom: 0; }
  .qp-text {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--text-primary);
    opacity: 0.85;
    cursor: default;
  }
  .qp-row.full .qp-text { white-space: pre-wrap; overflow-wrap: anywhere; padding-block: 6px; }
  .qp-row button:not(.qp-text) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    gap: 4px;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .qp-row button:disabled { opacity: 0.4; cursor: default; }
  .qp-grip { cursor: grab; touch-action: none; padding: 0 2px; }
  .qp-steer { color: var(--accent); }
  .qp-cancel { color: var(--text-primary); }
  /* Dedo: alvo de 40 px de altura. O botão é transparente sem hover, então o ícone continua do mesmo tamanho; só a
     linha ganha altura (área invisível transbordando a linha cairia na vizinha). */
  @media (pointer: coarse) {
    .qp-row { min-height: 40px; }
    .qp-row button:not(.qp-text) { height: 40px; min-width: 36px; }
  }
  @media (hover: hover) {
    .qp-row button:not(:disabled):not(.qp-text):hover { color: var(--text-primary); background: var(--glass-border); }
    .qp-steer:not(:disabled):hover { color: var(--accent); }
  }
</style>
