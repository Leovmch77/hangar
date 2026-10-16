<script lang="ts">
  import { onDestroy } from 'svelte';
  import { mermaidFailureText, renderMermaid, type MermaidResult, type MermaidTheme, type Server } from '@hangar/core';
  import * as m from '../paraglide/messages';
  import { readScheme } from '../lib/pageHost';
  import { abrirVisor } from '../lib/visor';

  // Diagrama Mermaid de uma resposta já terminada, desenhado pelo servidor. Montado pelo
  // lib/mermaidMount.ts antes do bloco de código que veio do {@html}; o bloco continua no DOM
  // (busca, cópia) e só sai da vista enquanto a imagem está na tela.
  interface Props {
    source: string;
    block: HTMLElement;
    server?: Server;
  }
  let { source, block, server }: Props = $props();

  let theme = $state<MermaidTheme>(readScheme());
  let result = $state<MermaidResult | null>(null);
  // Linha da falha; `null` com falha = rota que não existe para quem pede (404, convidado): só o código.
  const failureText = $derived(result && result.kind !== 'image' ? mermaidFailureText(result) : null);
  let url = $state('');
  let imgEl = $state<HTMLImageElement | undefined>();
  let generation = 0;
  // Cópia com fundo sólido para o visor: o PNG é transparente e, em tela cheia, a conversa
  // apareceria por trás das linhas. Feita no primeiro toque, guardada até trocar a imagem.
  let opaqueUrl = '';

  // O tema vem do atributo do <html>; trocou, o diagrama é pedido de novo no tema novo.
  const obs = new MutationObserver(() => { theme = readScheme(); });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  async function draw(retry = false) {
    const g = ++generation;
    result = null;
    const r = await renderMermaid(source, theme, server, retry);
    if (g !== generation) return;
    if (url) URL.revokeObjectURL(url);
    if (opaqueUrl) URL.revokeObjectURL(opaqueUrl);
    opaqueUrl = '';
    url = r.kind === 'image' ? URL.createObjectURL(new Blob([r.png as BlobPart], { type: 'image/png' })) : '';
    result = r;
  }

  $effect(() => {
    void theme;
    void draw();
  });

  // Com a imagem na tela, o bloco escondido sai do foco e da árvore de acessibilidade (os botões
  // Copiar e Expandir dele) sem sair do DOM, para a busca da página ainda achar a fonte. Não é
  // `inert` de propósito: o Chrome tira conteúdo inerte da busca da página.
  function hideBlock(hide: boolean) {
    block.classList.toggle('mermaid-src-hidden', hide);
    if (hide) block.setAttribute('aria-hidden', 'true'); else block.removeAttribute('aria-hidden');
    for (const el of block.querySelectorAll<HTMLElement>('button, a[href], [tabindex]')) {
      if (hide) {
        if (!el.hasAttribute('data-mermaid-tab')) el.setAttribute('data-mermaid-tab', el.getAttribute('tabindex') ?? '');
        el.tabIndex = -1;
      } else if (el.hasAttribute('data-mermaid-tab')) {
        const antes = el.getAttribute('data-mermaid-tab');
        if (antes) el.setAttribute('tabindex', antes); else el.removeAttribute('tabindex');
        el.removeAttribute('data-mermaid-tab');
      }
    }
  }

  $effect(() => {
    hideBlock(result?.kind === 'image');
  });

  onDestroy(() => {
    generation++;
    obs.disconnect();
    if (url) URL.revokeObjectURL(url);
    if (opaqueUrl) URL.revokeObjectURL(opaqueUrl);
    hideBlock(false);
  });

  async function withBackground(src: string): Promise<string> {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return src;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
      || (theme === 'light' ? '#ffffff' : '#000000');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    return blob ? URL.createObjectURL(blob) : src;
  }

  async function openViewer() {
    if (!url) return;
    const current = url;
    if (!opaqueUrl) {
      const done = await withBackground(current).catch(() => current);
      if (url !== current) { if (done !== current) URL.revokeObjectURL(done); return; }
      opaqueUrl = done === current ? '' : done;
    }
    void abrirVisor([{ url: opaqueUrl || current, nome: m.mermaid_file(), tipo: 'image', element: imgEl }], 0);
  }
</script>

{#if !result || result.kind === 'image' || failureText}
<div class="mermaid">
  {#if !result}
    <p class="mermaid-status" role="status">{m.mermaid_drawing()}</p>
  {:else if result.kind === 'image'}
    <button type="button" class="mermaid-open" onclick={openViewer} aria-label={m.mermaid_open()} title={m.mermaid_open()}>
      <img bind:this={imgEl} src={url} width={result.width} height={result.height} alt={m.mermaid_alt()} />
    </button>
  {:else}
    <div class="mermaid-erro" role="alert">
      <p>{failureText}</p>
      {#if result.kind === 'unavailable'}
        <button type="button" class="mermaid-retry" onclick={() => void draw(true)}>{m.mermaid_retry()}</button>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .mermaid { margin: var(--space-2) 0; max-width: 100%; }
  .mermaid-status { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .mermaid-open {
    display: block;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: zoom-in;
    -webkit-tap-highlight-color: transparent;
  }
  .mermaid-open img { display: block; max-width: 100%; height: auto; }
  .mermaid-erro { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .mermaid-erro p { margin: 0; font-size: var(--text-sm); color: var(--error); }
  .mermaid-retry {
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-primary);
    border-radius: var(--radius-full);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
    min-height: 32px;
    cursor: pointer;
  }
</style>
