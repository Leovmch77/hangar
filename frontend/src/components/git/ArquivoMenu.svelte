<script lang="ts">
  // Menu de contexto de um arquivo alterado (clique direito na lista da coluna de git). O MonoCode
  // não tem este menu — lá o clique direito cai no menu do webview; aqui ele existe porque a coluna
  // é estreita e não cabe uma fileira de ações por linha.
  import * as m from '../../paraglide/messages';
  import { portal } from '../../lib/portal';
  import type { GitStore } from '../../lib/gitStore.svelte';

  interface Props {
    path: string;
    x: number;
    y: number;
    git: GitStore;
    onAbrir: (path: string) => void;
    onClose: () => void;
  }
  let { path, x, y, git, onAbrir, onClose }: Props = $props();

  let confirmarDescarte = $state(false);
  let menuEl = $state<HTMLElement | null>(null);

  // Nasce dentro da janela: perto da borda de baixo/direita o menu subiria pra fora da tela.
  const pos = $derived.by(() => {
    const larg = 210, alt = confirmarDescarte ? 150 : 120;
    return {
      left: Math.min(x, window.innerWidth - larg - 8),
      top: Math.min(y, window.innerHeight - alt - 8),
    };
  });

  $effect(() => { menuEl?.querySelector('button')?.focus(); });

  async function copiar() {
    try { await navigator.clipboard.writeText(path); } catch { /* sem clipboard: nada a fazer */ }
    onClose();
  }
  async function descartar() {
    if (await git.discard(path)) onClose();
  }
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && onClose()} />

<div use:portal>
  <!-- Fundo só pra fechar no clique fora; o Esc já fecha pelo teclado (svelte:window acima).
       É um <div>, não <button>: o estilo global de botão pinta fundo próprio, e um botão de tela
       inteira transparente virava uma chapa cinza cobrindo o app. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="fundo" role="presentation" onclick={onClose}
       oncontextmenu={(e) => { e.preventDefault(); onClose(); }}></div>
  <div class="menu" bind:this={menuEl} role="menu" style="left: {pos.left}px; top: {pos.top}px">
    <p class="cam" title={path}>{path}</p>
    <button role="menuitem" onclick={() => { onAbrir(path); onClose(); }}>{m.git_ver_diff()}</button>
    <button role="menuitem" onclick={copiar}>{m.git_menu_copiar_caminho()}</button>
    {#if confirmarDescarte}
      <button role="menuitem" class="perigo" onclick={descartar} disabled={!!git.busy}>
        {m.comum_confirmar()}
      </button>
    {:else}
      <button role="menuitem" class="perigo" onclick={() => (confirmarDescarte = true)}>
        {m.git_descartar()}
      </button>
    {/if}
  </div>
</div>

<style>
  .fundo { position: fixed; inset: 0; z-index: 130; background: transparent; }
  .menu {
    position: fixed; z-index: 131; width: 210px;
    display: flex; flex-direction: column; gap: 2px; padding: var(--space-2);
    /* Fundo SÓLIDO: o menu cobre a lista e o texto de trás atravessaria um material translúcido. */
    background: var(--bg-elevated);
    border: 1px solid var(--border-default); border-radius: var(--radius-md);
    box-shadow: 0 8px 30px rgb(0 0 0 / 0.35);
  }
  .cam {
    margin: 0 0 var(--space-1); padding: 0 var(--space-2);
    font-family: var(--font-mono); font-size: 10px; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Raio concêntrico: o card é 12 com 8 de padding, então o item é 12 − 8 = 4. */
  button {
    text-align: left; padding: 6px var(--space-2); border-radius: 4px;
    border: 1px solid transparent; background: transparent; color: var(--text-secondary);
    font: inherit; font-size: var(--text-xs); cursor: pointer;
    transition-property: background-color, color;
    transition-duration: 120ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  button:hover { background: var(--bg-hover); color: var(--text-primary); }
  button:active { scale: 0.96; }
  button:disabled { opacity: .5; cursor: default; }
  .perigo { color: var(--danger); }
</style>
