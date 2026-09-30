<script lang="ts">
  // Chip "N no Hangar" + lista. Expandido: chip ao lado da marca; trilho: ponto na marca.
  // Some com zero terminais No Hangar (e enquanto o stream da lista não trouxe nada).
  import { closeHangarTerminal, focusHangarTerminal, restartHangarTerminal } from '@hangar/core';
  import { listServers } from '../lib/auth';
  import { allHangar, openQuestion, requestHangarTab, runningFor } from '../lib/hangarTerminals.svelte';
  import * as m from '../paraglide/messages';

  // No celular nada consome o pedido de aba sozinho: quem monta passa como abrir o terminal.
  interface Props { rail?: boolean; onOpenTerminal?: (serverId: string, owner: string, id: string) => void }
  let { rail = false, onOpenTerminal }: Props = $props();
  let open = $state(false);
  let error = $state('');
  let now = $state(Date.now());
  let root = $state<HTMLDivElement | null>(null);
  const items = $derived(allHangar());
  const asking = $derived(items.some(({ t }) => t.alive && t.question));
  const multi = $derived(new Set(items.map((i) => i.serverId)).size > 1);

  $effect(() => {
    if (!open) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    const outside = (e: PointerEvent) => { if (root && !root.contains(e.target as Node)) open = false; };
    document.addEventListener('pointerdown', outside, true);
    return () => { clearInterval(timer); document.removeEventListener('pointerdown', outside, true); };
  });

  function serverOf(id: string) { return listServers().find((s) => s.id === id) ?? null; }
  function elapsed(created: number | undefined) {
    const r = runningFor(created ?? 0, now);
    return 'minutes' in r ? m.hangar_min({ n: r.minutes }) : m.hangar_h({ n: r.hours });
  }
  async function act(serverId: string, fn: (srv: NonNullable<ReturnType<typeof serverOf>>) => Promise<unknown>) {
    const srv = serverOf(serverId);
    if (!srv) return;
    error = '';
    try { await fn(srv); } catch (e) { error = m.hangar_erro({ msg: e instanceof Error ? e.message : String(e) }); }
  }
  function showTerminal(serverId: string, id: string) {
    open = false;
    requestHangarTab(serverId, id);
    onOpenTerminal?.(serverId, '', id);
  }
  const goToWindow = (serverId: string, id: string) => act(serverId, async (srv) => {
    const r = await focusHangarTerminal(srv, id);
    if (r.focused) { open = false; return; }
    error = m.hangar_sem_janela();
    showTerminal(serverId, id);
  });
</script>

{#if items.length}
  <div class="hr" class:rail bind:this={root}>
    <button type="button" class="hr-chip" class:rail class:asking aria-expanded={open}
            aria-label={m.hangar_chip({ n: items.length })} title={m.hangar_chip({ n: items.length })}
            onclick={() => (open = !open)}>
      <span class="hr-dot" aria-hidden="true"></span>
      {#if !rail}{m.hangar_chip({ n: items.length })}{/if}
    </button>
    {#if open}
      <div class="hr-menu" role="dialog" aria-label={m.hangar_lista_titulo()} tabindex="-1"
           onkeydown={(e) => { if (e.key === 'Escape') open = false; }}>
        <p class="hr-head">{m.hangar_lista_titulo()}</p>
        {#each items as { serverId, t } (serverId + t.id)}
          {@const origin = t.origin ? (multi ? `${serverOf(serverId)?.label ?? serverId}::${t.origin}` : t.origin) : ''}
          <div class="hr-item" class:asking={t.alive && t.question}>
            <div class="hr-row">
              <span class="hr-state" class:live={t.alive && !t.question} class:asking={t.alive && t.question}></span>
              <span class="hr-name" class:dead={!t.alive}>{t.label}</span>
              <span class="hr-meta" class:failed={!t.alive}>
                {#if !t.alive}{m.hangar_caiu({ codigo: String(t.exit_code ?? '?') })}
                {:else if t.question}{m.hangar_esperando()}
                {:else}{elapsed(t.created)}{#if origin} · {m.hangar_aberto_em({ sessao: origin })}{/if}{/if}
              </span>
            </div>
            {#if t.alive && t.question}<p class="hr-question">{t.question.text}</p>{/if}
            <div class="hr-actions">
              {#if !t.alive}
                <button type="button" onclick={() => showTerminal(serverId, t.id)}>{m.hangar_ver_saida()}</button>
                <button type="button" onclick={() => act(serverId, (srv) => restartHangarTerminal(srv, t.id))}>{m.hangar_rodar_de_novo()}</button>
                <button type="button" class="quiet" onclick={() => act(serverId, (srv) => closeHangarTerminal(srv, t.id))}>{m.hangar_dispensar()}</button>
              {:else}
                {#if t.question}
                  <button type="button" class="alert" onclick={() => { open = false; openQuestion(serverId, '', t.id); }}>{m.hangar_responder()}</button>
                {:else}
                  <button type="button" class="primary" onclick={() => goToWindow(serverId, t.id)}>{m.hangar_ir_janela()}</button>
                {/if}
                <button type="button" onclick={() => showTerminal(serverId, t.id)}>{m.hangar_terminal()}</button>
                <button type="button" class="danger" onclick={() => act(serverId, (srv) => closeHangarTerminal(srv, t.id))}>{m.hangar_parar()}</button>
              {/if}
            </div>
          </div>
        {/each}
        {#if error}<p class="hr-error" role="alert">{error}</p>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .hr { position: relative; margin-left: auto; }
  .hr.rail { position: absolute; top: -2px; right: -2px; margin: 0; }
  .hr-chip {
    height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: var(--radius-full);
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); background: var(--accent-dim);
    color: var(--text-primary); font-size: var(--text-xs); cursor: pointer; white-space: nowrap;
  }
  .hr-chip.rail { width: 12px; height: 12px; padding: 0; border: 2px solid var(--bg-base); background: var(--success); }
  .hr-chip.rail.asking { background: var(--warning); }
  .hr-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hr-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
  .hr-chip.asking .hr-dot { background: var(--warning); }
  .hr-chip.rail .hr-dot { display: none; }
  /* Menu flutuante: fundo sólido, nunca --surface-raised (regra do repo). */
  .hr-menu {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; width: min(400px, calc(100vw - 32px));
    max-height: 70vh; overflow: auto; border-radius: var(--radius-lg); background: var(--bg-elevated);
    border: 1px solid var(--border-default); box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
  }
  .hr.rail .hr-menu { left: 20px; top: 0; }
  .hr-head { margin: 0; padding: 10px 14px 6px; font-size: var(--text-xs); color: var(--text-muted); }
  .hr-item { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border-subtle); }
  .hr-item.asking { background: color-mix(in srgb, var(--warning) 7%, transparent); }
  .hr-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .hr-state { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--text-muted); }
  .hr-state.live { border: 0; background: var(--success); }
  .hr-state.asking { border: 0; background: var(--warning); }
  .hr-name { font-weight: 500; color: var(--text-primary); }
  .hr-name.dead { color: var(--text-secondary); }
  .hr-meta { font-size: var(--text-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hr-meta.failed { color: var(--error); }
  .hr-item.asking .hr-meta { color: var(--warning); }
  .hr-question { margin: 0 0 0 16px; font-size: var(--text-sm); color: var(--text-secondary); }
  .hr-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 16px; }
  .hr-actions button {
    height: 30px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-default);
    background: transparent; color: var(--text-primary); font-size: var(--text-xs); cursor: pointer;
  }
  .hr-actions button.primary { border: 0; background: var(--accent-press); color: #fff; }
  .hr-actions button.alert { border: 0; background: color-mix(in srgb, var(--warning) 75%, black); color: #fff; }
  .hr-actions button.danger { color: var(--error); }
  .hr-actions button.quiet { border: 0; color: var(--text-muted); }
  .hr-error { margin: 0; padding: 8px 14px; color: var(--error); font-size: var(--text-sm); }
</style>
