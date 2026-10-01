<script lang="ts">
  import { providerName, SESSION_PROVIDERS } from '@hangar/core';
  import BottomSheet from '../BottomSheet.svelte';
  import ProviderGlyph from '../icons/ProviderGlyph.svelte';
  import { valorModelo } from '../../lib/modelosPorConta';
  import type { NewChatDraft } from '../../lib/newChatDraft.svelte';
  import * as m from '../../paraglide/messages';

  // Pílula de modelo dentro do compositor (glifo do provider + modelo + esforço) e a folha dela:
  // provider em abas, a lista de modelos com "Padrão" primeiro, o esforço no rodapé.
  let { draft, disabled = false }: { draft: NewChatDraft; disabled?: boolean } = $props();
  let open = $state(false);

  const models = $derived(draft.models.filter((mod) => mod.id !== 'default'));
  const label = $derived(models.find((mod) => valorModelo(mod) === draft.model)?.name
    ?? (draft.model || providerName(draft.provider)));
</script>

<button type="button" class="pill" aria-label={`${m.native_create_model()}: ${label}`} {disabled} onclick={() => (open = true)}>
  <ProviderGlyph provider={draft.provider} size={16} />
  <span class="name">{label}</span>
  {#if draft.effort}<span class="effort">{draft.effort}</span>{/if}
</button>

<BottomSheet {open} onClose={() => (open = false)} ariaLabel={m.native_create_model()}>
  <div class="sheet">
    <div class="tabs" role="group" aria-label={m.native_create_provider_aria()}>
      {#each SESSION_PROVIDERS as p (p)}
        <button type="button" class="tab" class:on={draft.provider === p} aria-pressed={draft.provider === p}
          aria-label={providerName(p)} title={providerName(p)}
          disabled={draft.providers[p]?.disponivel === false} onclick={() => draft.setProvider(p)}>
          <ProviderGlyph provider={p} size={18} />
        </button>
      {/each}
    </div>

    {#if draft.modelsLoading}
      <p class="muted" role="status">{m.comum_carregando()}</p>
    {:else if draft.modelsError}
      <p class="muted" role="alert">{m.native_create_models_failed()}: {draft.modelsError}</p>
      <button type="button" class="retry" onclick={() => draft.loadModels()}>{m.sync_retry()}</button>
    {:else}
      <ul class="list">
        <li>
          <button type="button" class="row" class:on={draft.model === ''} aria-pressed={draft.model === ''}
            onclick={() => draft.setModel('')}>{m.native_create_default()}</button>
        </li>
        {#each models as mod (valorModelo(mod))}
          {@const v = valorModelo(mod)}
          <li>
            <button type="button" class="row" class:on={draft.model === v} aria-pressed={draft.model === v}
              onclick={() => draft.setModel(v)}>
              <span>{mod.name ?? mod.id}</span>
              {#if mod.context}<span class="muted">{mod.context}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if draft.levels.length > 0}
      <div class="effort-row" role="group" aria-label={m.native_create_effort()}>
        <span class="muted">{m.native_create_effort()}</span>
        <button type="button" class="chip" class:on={draft.effort === ''} aria-pressed={draft.effort === ''}
          onclick={() => (draft.effort = '')}>{m.native_create_default()}</button>
        {#each draft.levels as lvl (lvl)}
          <button type="button" class="chip" class:on={draft.effort === lvl} aria-pressed={draft.effort === lvl}
            onclick={() => (draft.effort = lvl)}>{lvl}</button>
        {/each}
      </div>
    {/if}
  </div>
</BottomSheet>

<style>
  .pill {
    display: inline-flex; align-items: center; gap: 6px; min-height: 32px; max-width: 100%; padding: 4px 10px;
    border: 0; border-radius: var(--radius-full); background: transparent; color: var(--text-primary); cursor: pointer;
  }
  .pill:not(:disabled):active { background: var(--fill-subtle); }
  .pill:disabled { opacity: 0.6; cursor: default; }
  .name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); font-weight: var(--fw-semibold); }
  .effort { font-size: var(--text-xs); color: var(--text-muted); }
  .sheet { padding: var(--space-2) var(--space-4) calc(env(safe-area-inset-bottom) + var(--space-4)); display: flex; flex-direction: column; gap: var(--space-2); }
  .tabs { display: flex; gap: 2px; }
  .tab {
    width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text-secondary); cursor: pointer;
  }
  .tab.on { background: var(--accent-dim); color: var(--text-primary); }
  .tab:disabled { opacity: 0.35; cursor: default; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 45vh; overflow-y: auto; }
  .row {
    width: 100%; min-height: 44px; display: flex; justify-content: space-between; align-items: center; gap: 8px;
    padding: 8px 12px; border: 0; border-radius: var(--radius-md); background: transparent;
    color: var(--text-primary); font-size: var(--text-sm); text-align: left; cursor: pointer;
  }
  .row.on { background: var(--accent-dim); }
  .muted { margin: 0; font-size: var(--text-xs); color: var(--text-muted); }
  .retry { align-self: flex-start; border: 0; background: transparent; color: var(--accent); cursor: pointer; }
  .effort-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-top: var(--space-2); border-top: 1px solid var(--border-subtle); }
  .chip {
    min-height: 32px; padding: 4px 10px; border: 0; border-radius: var(--radius-full);
    background: transparent; color: var(--text-secondary); font-size: var(--text-xs); cursor: pointer;
  }
  .chip.on { background: var(--accent-dim); color: var(--text-primary); }
</style>
