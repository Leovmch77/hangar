<script lang="ts">
  import { untrack } from 'svelte';
  import type { CodexAccount, ConfigDirInfo, Provider } from '@hangar/core';
  import BottomSheet from '../BottomSheet.svelte';
  import QuietPill from './QuietPill.svelte';
  import { quotaFeed } from '../../lib/quotaFeed.svelte';
  import { faixaDeCota, faltaPara, exhaustedWindow, type ContaCota } from '../../lib/cota';
  import * as m from '../../paraglide/messages';

  // Conta da conversa: Claude (pastas de config) ou Codex. Outros providers não têm pílula.
  // As listas vêm de quem chama; a cota de cada conta vem do feed compartilhado do servidor ativo.
  interface Props {
    server: string;
    provider: Provider;
    configs: ConfigDirInfo[];
    codexAccounts: CodexAccount[];
    /** config_dir (Claude) ou id da conta (Codex). */
    selected: string | null;
    loading?: boolean;
    disabled?: boolean;
    onchange: (id: string) => void;
    /** Liga a trava de conta sem limite: `blocked` passa a trazer o aviso quando a escolhida está em 100%. */
    blockExhausted?: boolean;
    blocked?: string | null;
  }
  let { server, provider, configs, codexAccounts, selected, loading = false, disabled = false, onchange,
        blockExhausted = false, blocked = $bindable(null) }: Props = $props();

  let open = $state(false);

  $effect(() => {
    quotaFeed.retain();
    return () => quotaFeed.release();
  });
  $effect(() => { quotaFeed.setServidor(server); });

  const linha = $derived(faixaDeCota(quotaFeed.contas) ?? []);
  const rows = $derived(provider === 'claude'
    ? configs.map((c) => ({ id: c.path, label: c.label, hint: c.active ? m.native_create_current() : '', quotaId: `claude:${c.path}` }))
    : codexAccounts.map((a) => ({ id: a.id, label: a.name, hint: a.is_default ? m.native_create_default() : '', quotaId: a.credential_id })));
  const current = $derived(rows.find((r) => r.id === selected) ?? null);
  const quotaOf = (quotaId: string): ContaCota | null => linha.find((c) => c.id === quotaId) ?? null;

  const exhausted = $derived.by(() => {
    if (!blockExhausted || !current) return null;
    const janela = exhaustedWindow(quotaOf(current.quotaId));
    if (!janela) return null;
    const quando = faltaPara(janela.resetTs, quotaFeed.agora);
    return quando ? m.newchat_conta_sem_limite({ conta: current.label, quando })
      : m.newchat_conta_sem_limite_sem_hora({ conta: current.label });
  });
  $effect(() => {
    const v = exhausted;
    untrack(() => { if (blocked !== v) blocked = v; });
  });

  const aria = $derived(provider === 'claude' ? m.native_create_claude_account() : m.native_create_codex_account());

  function pick(id: string) {
    open = false;
    if (id !== selected) onchange(id);
  }
</script>

{#if provider === 'claude' || provider === 'codex'}
  {#if loading || rows.length > 0}
    <QuietPill label={loading ? m.comum_carregando() : (current?.label ?? m.native_create_default())} ariaLabel={aria}
      {loading} {disabled} onclick={() => (open = true)}>
      {#snippet icon()}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><circle cx="12" cy="10" r="3" /><path d="M7 20.7a6 6 0 0 1 10 0" />
        </svg>
      {/snippet}
    </QuietPill>
  {/if}

  <BottomSheet {open} onClose={() => (open = false)} ariaLabel={aria}>
    <div class="sheet">
      <h2 class="title">{aria}</h2>
      <ul class="list">
        {#each rows as r (r.id)}
          {@const q = quotaOf(r.quotaId)}
          <li>
            <button type="button" class="row" class:on={r.id === selected} aria-pressed={r.id === selected} onclick={() => pick(r.id)}>
              <span class="main">
                <span class="label">{r.label}</span>
                {#if r.hint}<span class="hint">{r.hint}</span>{/if}
              </span>
              {#if q?.estado === 'lida'}
                <span class="quota">
                  {#each q.janelas as j, i (j.rotulo)}
                    {#if i > 0}<span class="sep">·</span>{/if}
                    <span class="jan" data-nivel={j.nivel}>{j.rotulo} {Math.round(j.pct)}%</span>
                    {#if j.pct >= 100 && faltaPara(j.resetTs, quotaFeed.agora)}
                      <span class="reset">{m.rate_reseta({ quando: faltaPara(j.resetTs, quotaFeed.agora) })}</span>
                    {/if}
                  {/each}
                </span>
              {:else if q}
                <span class="quota">{m.cota_sem_cota()}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </BottomSheet>
{/if}

<style>
  .sheet { padding: var(--space-2) var(--space-4) calc(env(safe-area-inset-bottom) + var(--space-4)); }
  .title { margin: 0 0 var(--space-2); font-size: var(--text-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .row {
    width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 44px;
    padding: 8px 12px; border: 0; border-radius: var(--radius-md); background: transparent;
    color: var(--text-primary); text-align: left; cursor: pointer;
  }
  .row.on { background: var(--accent-dim); }
  .main { display: flex; gap: 8px; align-items: baseline; }
  .label { font-size: var(--text-sm); font-weight: var(--fw-medium); }
  .hint, .quota { font-size: var(--text-xs); color: var(--text-muted); }
  .quota { display: flex; flex-wrap: wrap; gap: 4px; }
  .jan[data-nivel='alerta'] { color: var(--warning-text); }
  .jan[data-nivel='cheio'] { color: var(--error); }
</style>
