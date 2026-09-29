<script lang="ts">
  // Exportar e importar os atalhos. Quem tira as credenciais é o backend (/api/shortcuts/export):
  // o arquivo sai com `⟦SEGREDO:<nome>⟧` no lugar de cada senha, e a importação pede o valor de
  // cada marcador antes de gravar. Marcador em branco fica: o atalho é salvo, mas não roda.
  import { exportShortcuts, importShortcuts, type ShortcutImportResult } from '@hangar/core';
  import ModalDialog from './ModalDialog.svelte';
  import { reloadShortcuts } from '../lib/shortcuts.svelte';
  import { listServers, getActiveId } from '../lib/auth';
  import * as m from '../paraglide/messages';

  interface Props {
    serverId?: string | null;
    // Compacto: um "⋯" com menu (cabeçalho da seção Ações). Senão, dois botões (tela de config).
    compact?: boolean;
    onDone?: () => void;
  }
  let { serverId = null, compact = false, onDone }: Props = $props();

  let menuOpen = $state(false);
  let menuEl: HTMLElement | undefined = $state();

  function closeMenuOutside(e: PointerEvent) {
    if (menuOpen && menuEl && !menuEl.contains(e.target as Node)) menuOpen = false;
  }
  let input = $state<HTMLInputElement | null>(null);
  let note = $state<{ text: string; error: boolean } | null>(null);
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = $state<{ data: unknown; preview: ShortcutImportResult } | null>(null);
  let secrets = $state<Record<string, Record<string, string>>>({});
  let applying = $state(false);

  function server() {
    return serverId && serverId !== getActiveId() ? listServers().find((s) => s.id === serverId) ?? null : null;
  }

  function show(text: string, error = false) {
    clearTimeout(noteTimer);
    note = { text, error };
    noteTimer = setTimeout(() => (note = null), 8000);
  }

  function msg(e: unknown) { return e instanceof Error ? e.message : String(e); }

  async function doExport() {
    menuOpen = false;
    try {
      const r = await exportShortcuts(server());
      const blob = new Blob([JSON.stringify({ version: r.version, shortcuts: r.shortcuts }, null, 2) + '\n'],
                            { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hangar-atalhos.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      show(r.removed ? m.atalhos_exportado_segredos({ n: r.removed }) : m.atalhos_exportado());
    } catch (e) {
      show(msg(e), true);
    }
  }

  function pickFile() {
    menuOpen = false;
    input?.click();
  }

  async function onFile(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      show(m.atalhos_importar_invalido({ msg: msg(err) }), true);
      return;
    }
    try {
      const preview = await importShortcuts({ data }, server());
      secrets = Object.fromEntries(preview.placeholders.map((p) => [p.id, Object.fromEntries(p.names.map((n) => [n, '']))]));
      pending = { data, preview };
    } catch (err) {
      show(m.atalhos_importar_invalido({ msg: msg(err) }), true);
    }
  }

  async function apply() {
    if (!pending || applying) return;
    applying = true;
    try {
      await importShortcuts({ data: pending.data, apply: true, secrets }, server());
      pending = null;
      secrets = {};
      await reloadShortcuts(serverId).catch(() => {});
      show(m.atalhos_importado());
      onDone?.();
    } catch (err) {
      show(m.atalhos_importar_invalido({ msg: msg(err) }), true);
    } finally {
      applying = false;
    }
  }
</script>

<input bind:this={input} type="file" accept="application/json,.json" class="sr-only" onchange={onFile} tabindex="-1" aria-hidden="true" />

<!-- Captura: o BottomSheet engole o Esc na bolha; aqui ele fecha só o menu, não a sheet. -->
<svelte:window onpointerdown={closeMenuOutside} onkeydowncapture={(e) => {
  if (menuOpen && e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); menuOpen = false; }
}} />

{#if compact}
  <span class="tr-menu" bind:this={menuEl}>
    <button type="button" class="tr-mais" onclick={() => (menuOpen = !menuOpen)} aria-haspopup="menu"
            aria-expanded={menuOpen} aria-label={m.atalhos_transferir()} title={m.atalhos_transferir()}>⋯</button>
    {#if menuOpen}
      <span class="tr-lista" role="menu">
        <button type="button" role="menuitem" onclick={pickFile}>{m.atalhos_importar()}</button>
        <button type="button" role="menuitem" onclick={() => void doExport()}>{m.atalhos_exportar()}</button>
        <span class="tr-escopo">{m.atalhos_transferir_so_globais()}</span>
      </span>
    {/if}
  </span>
{:else}
  <button type="button" class="btn" onclick={pickFile}>{m.atalhos_importar()}</button>
  <button type="button" class="btn" onclick={() => void doExport()}>{m.atalhos_exportar()}</button>
  <span class="tr-escopo">{m.atalhos_transferir_so_globais()}</span>
{/if}

{#if note}
  <span class="tr-nota" class:flutua={compact} class:erro={note.error} role={note.error ? 'alert' : 'status'}>{note.text}</span>
{/if}

<ModalDialog open={pending !== null} ariaLabel={m.atalhos_importar_titulo()} onClose={() => (pending = null)}>
  {#if pending}
    <div class="tr-dialogo">
      <h2>{m.atalhos_importar_titulo()}</h2>
      <p>{m.atalhos_importar_resumo({ novos: pending.preview.added, substituidos: pending.preview.replaced })}</p>
      {#if pending.preview.placeholders.length}
        <p class="tr-ajuda">{m.atalhos_importar_segredos()}</p>
        {#each pending.preview.placeholders as p (p.id)}
          {#each p.names as name (name)}
            <label class="tr-campo">
              <span>{m.atalhos_segredo_campo({ atalho: p.label, nome: name })}</span>
              <input type="password" autocomplete="off" bind:value={secrets[p.id][name]} />
            </label>
          {/each}
        {/each}
      {/if}
      <div class="tr-acoes">
        <button type="button" class="btn" onclick={() => (pending = null)}>{m.comum_cancelar()}</button>
        <button type="button" class="btn primario" onclick={() => void apply()} disabled={applying}>{m.atalhos_importar()}</button>
      </div>
    </div>
  {/if}
</ModalDialog>

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .tr-menu { position: relative; display: inline-flex; }
  .tr-mais {
    width: 24px; height: 24px; border: 0; border-radius: var(--radius-sm); background: transparent;
    color: var(--text-muted); cursor: pointer; font-size: 14px; line-height: 1;
  }
  .tr-mais:hover { background: var(--surface-raised); color: var(--text-primary); }
  .tr-lista {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 20; min-width: 140px;
    display: flex; flex-direction: column; padding: 4px; border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); background: var(--surface-raised); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
  }
  .tr-lista button {
    text-align: left; padding: 6px 10px; border: 0; border-radius: var(--radius-sm); background: transparent;
    color: var(--text-primary); font-size: var(--text-sm); cursor: pointer;
  }
  .tr-lista button:hover { background: var(--bg-hover); }
  .tr-escopo { font-size: var(--text-xs); color: var(--text-muted); }
  .tr-lista .tr-escopo { padding: 4px 10px 2px; border-top: 1px solid var(--border-subtle); margin-top: 2px; }
  .tr-nota { font-size: var(--text-xs); color: var(--text-muted); }
  /* No cabeçalho da seção não há linha sobrando: o aviso flutua embaixo do "⋯". */
  .tr-nota.flutua {
    position: absolute; right: 0; top: 28px; z-index: 20; width: min(260px, 80vw); padding: 6px 10px;
    border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised);
  }
  .btn {
    padding: 6px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    background: transparent; color: var(--text-primary); font-size: var(--text-sm); cursor: pointer;
  }
  .btn:hover { background: var(--bg-hover); }
  .btn:disabled { opacity: 0.45; }
  .btn.primario { background: var(--accent); border-color: var(--accent); color: var(--bg-base); }
  .tr-nota.erro { color: var(--error); }
  .tr-dialogo { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); max-width: 480px; }
  .tr-dialogo h2 { margin: 0; font-size: var(--text-lg); }
  .tr-dialogo p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); }
  .tr-ajuda { color: var(--text-muted); }
  .tr-campo { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); }
  .tr-campo input {
    padding: 6px 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    background: var(--surface-inset); color: var(--text-primary);
  }
  .tr-acoes { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
