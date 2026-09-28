<script lang="ts">
  // Seção "Ações": os atalhos customizados como blocos (ícone em cima, rótulo embaixo), no desenho do
  // painel direito do app nativo. Grade que quebra linha em vez de rolar: com mais largura cabem mais
  // colunas, e cada bloco divide a linha por igual. Usada no painel do desktop e no "⋯" do celular.
  import ShortcutIcon from './icons/ShortcutIcon.svelte';
  import type { ShortcutSendText, ShortcutShell } from '@hangar/core';
  import type { Snippet } from 'svelte';
  import * as m from '../paraglide/messages';

  interface Props {
    shortcuts: (ShortcutSendText | ShortcutShell)[];
    onShortcut: (s: ShortcutSendText | ShortcutShell) => void;
    onAdd?: () => void;
    // Controles extras do cabeçalho (menu de importar/exportar), à direita do "+".
    extra?: Snippet;
  }
  let { shortcuts, onShortcut, onAdd, extra }: Props = $props();
</script>

<section class="acoes" aria-label={m.ctx_acoes()}>
  <div class="acoes-topo">
    <span class="acoes-titulo">{m.ctx_acoes()}</span>
    <span class="acoes-ctl">
      {@render extra?.()}
      {#if onAdd}
        <button type="button" class="acoes-add" onclick={onAdd} aria-label={m.atalhos_add()} title={m.atalhos_add()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      {/if}
    </span>
  </div>
  <div class="acoes-grade">
    {#each shortcuts as s (s.id)}
      <button type="button" class="acao-bloco" onclick={() => onShortcut(s)} aria-label={s.label} title={s.label}>
        <ShortcutIcon icon={s.icon} />
        <span class="acao-rotulo">{s.label}</span>
      </button>
    {/each}
  </div>
</section>

<style>
  .acoes { display: flex; flex-direction: column; gap: var(--space-2); }
  .acoes-topo { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 24px; }
  /* Mesma receita dos rótulos de seção do painel (tokens de app.css). */
  .acoes-titulo {
    color: var(--text-muted); font-size: var(--label-size); font-weight: var(--label-weight);
    letter-spacing: var(--label-tracking); text-transform: uppercase;
  }
  .acoes-ctl { display: inline-flex; align-items: center; gap: 2px; }
  .acoes-add {
    display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
    border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer;
  }
  .acoes-add:hover { background: var(--surface-raised); color: var(--text-primary); }
  .acoes-add:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* auto-fill + minmax: a quantidade de colunas sai da largura, e os blocos dividem a linha. */
  .acoes-grade { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; }
  .acao-bloco {
    min-width: 0; min-height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; padding: 8px 4px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
    background: transparent; color: var(--text-secondary); cursor: pointer;
    transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
  }
  .acao-bloco:hover { background: var(--surface-raised); color: var(--text-primary); }
  .acao-bloco:active { background: var(--bg-hover); }
  .acao-bloco:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .acao-bloco :global(svg) { flex-shrink: 0; width: 18px; height: 18px; }
  /* Duas linhas antes de cortar: rótulo curto demais escondia o que o atalho faz. */
  .acao-rotulo {
    max-width: 100%; font-size: 11px; font-weight: 600; line-height: 1.25; text-align: center;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }
</style>
