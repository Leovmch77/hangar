<script lang="ts">
  import { linkedChildren, linkedChildrenDone, providerName, rotuloModelo, type SessionInfo } from '@hangar/core';
  import * as m from '../paraglide/messages';
  import StateChip from './StateChip.svelte';

  interface Props {
    serverId: string;
    sessionName: string;
    /** A lista que o Chat já tem: o store no desktop, o poll local no celular (lá ninguém retém o store). */
    sessions: SessionInfo[];
  }
  let { serverId, sessionName, sessions }: Props = $props();

  // A lista já é só deste servidor: sem `serverId` no pai, o core não confere servidor.
  const children = $derived(linkedChildren(sessions, { name: sessionName }));
  const done = $derived(linkedChildrenDone(children));
  let open = $state(false);

  function openChild(name: string) {
    location.hash = `#/chat/${serverId}/${encodeURIComponent(name)}`;
  }
</script>

{#if children.length > 0}
  <div class="linked-band">
    <button type="button" class="head" aria-expanded={open} title={m.linked_children_toggle()}
            onclick={() => (open = !open)}>
      <span class="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span class="title"><span aria-hidden="true">⑃</span> <b>{children.length === 1 ? m.linked_children_count_one() : m.linked_children_count({ count: children.length })}</b></span>
      <span class="chips">
        {#each children as c (c.name)}<span class="chip">{c.name}</span>{/each}
      </span>
      <span class="right">
        <span class="dots">
          {#each children as c (c.name)}<StateChip state={c.state} dot />{/each}
        </span>
        {m.linked_children_done({ done, total: children.length })}
      </span>
    </button>
    {#if open}
      <ul class="list">
        {#each children as c (c.name)}
          <li class="row">
            <StateChip state={c.state} dot />
            <span class="name">{c.name}</span>
            <span class="meta">{providerName(c.provider)}{c.model ? ` · ${rotuloModelo(c.model)}` : ''}</span>
            <span class="meta"><StateChip state={c.state} /></span>
            <span class="last">{c.last_reply ?? ''}</span>
            <button type="button" class="open" onclick={() => openChild(c.name)}>{m.linked_children_open()}</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .linked-band {
    margin: 0 var(--space-3) var(--space-1);
    padding: var(--space-1) 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.45;
    color: var(--text-muted);
    background: var(--surface-inset);
    border-radius: var(--radius-md);
  }
  .head {
    display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 32px;
    padding: 2px var(--space-2); font: inherit; color: inherit; text-align: left;
    background: transparent; border: 0; cursor: pointer;
  }
  .head:hover { background: var(--accent-dim); }
  .caret { width: 10px; color: var(--text-primary); }
  .title { white-space: nowrap; }
  b { color: var(--text-primary); font-weight: 700; }
  .chips { display: flex; gap: 6px; min-width: 0; overflow: hidden; }
  .chip {
    font-family: var(--font-ui); color: var(--text-primary); white-space: nowrap;
    background: var(--surface-raised); border-radius: 5px; padding: 0 6px;
  }
  .right { margin-left: auto; display: flex; gap: var(--space-2); align-items: center; white-space: nowrap; }
  .dots { display: flex; gap: 6px; }
  .list {
    list-style: none; margin: 4px 0 0; padding: 4px 0 0; border-top: 1px solid var(--border-subtle);
    max-height: 96px; overflow-y: auto;
  }
  .row {
    display: grid; grid-template-columns: 10px auto auto auto minmax(0, 1fr) auto; gap: var(--space-2);
    align-items: center; padding: 2px var(--space-2) 2px calc(var(--space-2) + 18px);
  }
  .name { color: var(--text-primary); font-weight: 700; white-space: nowrap; }
  .meta { white-space: nowrap; }
  .last { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .open {
    font-family: var(--font-ui); font-size: inherit; color: var(--accent-text); white-space: nowrap;
    background: transparent; border: 0; padding: 4px 0; min-height: 32px; cursor: pointer;
  }
  .open:hover { text-decoration: underline; }
  /* Celular: a linha não cabe em seis colunas; o nome e o botão ficam, o resto desce. */
  @media (max-width: 820px) {
    .chips { display: none; }
    .row { grid-template-columns: 10px minmax(0, 1fr) auto; }
    .row .meta, .row .last { grid-column: 2 / -1; }
    .row .open { grid-column: 3; grid-row: 1; }
  }
</style>
