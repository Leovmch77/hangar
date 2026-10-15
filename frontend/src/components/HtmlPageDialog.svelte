<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as m from '../paraglide/messages';
  import ModalDialog from './ModalDialog.svelte';
  import { PAGE_ZOOM_MAX, PAGE_ZOOM_MIN, pageZoomKey, pageZoomLabel, parseHostMessage, stepPageZoom, wheelZoom,
    themedPageDocument, type PageZoomAction } from '@hangar/core';
  import { pageVariables, postTheme, readFullscreenMessage, withZoomBridge, type Scheme } from '../lib/pageHost';

  let { title, doc, ownTheme, scheme, onClose }:
    { title: string; doc: string; ownTheme: boolean; scheme: Scheme; onClose: () => void } = $props();

  let zoom = $state(1);
  let pending = 0;
  let frame: HTMLIFrameElement | undefined = $state();
  let stage: HTMLDivElement | undefined = $state();
  let closeButton: HTMLButtonElement | null = $state(null);
  // O documento do cartão leva o tema da carga dele: a cópia nasce no tema de agora, que pode ter mudado até abrir.
  const src = untrack(() => withZoomBridge(ownTheme ? doc : themedPageDocument(doc, scheme, pageVariables())));

  function apply(action: PageZoomAction) { zoom = stepPageZoom(zoom, action); }

  function wheel(deltaY: number) {
    const r = wheelZoom(pending, deltaY);
    pending = r.pending;
    if (r.action) apply(r.action);
  }

  function onStageWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    wheel(e.deltaY);
  }

  function onKey(e: KeyboardEvent) {
    const action = pageZoomKey(e);
    if (!action) return;
    e.preventDefault();
    apply(action);
  }

  function onMessage(e: MessageEvent) {
    if (!frame || e.source !== frame.contentWindow) return;
    const z = readFullscreenMessage(e.data);
    if (z?.kind === 'wheel') wheel(z.deltaY);
    else if (z?.kind === 'key') apply(z.action);
    else if (z?.kind === 'escape') onClose();
    else {
      const msg = parseHostMessage(e.data);
      // Só com gesto real: a página não abre aba sozinha.
      if (msg?.kind === 'link' && (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive) {
        window.open(msg.url, '_blank', 'noopener,noreferrer');
      }
    }
  }

  // Tema trocado entre abrir e o documento carregar: a mensagem do efeito chega antes da página ouvir.
  function onFrameLoad() {
    if (!ownTheme) postTheme(frame, scheme, pageVariables());
  }

  $effect(() => {
    // Tema do app mudou com o diálogo aberto: a cópia recebe as variáveis novas sem recarregar.
    const theme = scheme;
    if (!ownTheme) postTheme(frame, theme, pageVariables());
  });

  onMount(() => {
    // Ctrl+roda na sobra do palco (zoom abaixo de 100%): o ouvinte não pode ser passivo para segurar o zoom do navegador.
    stage?.addEventListener('wheel', onStageWheel, { passive: false });
    return () => stage?.removeEventListener('wheel', onStageWheel);
  });
</script>

<svelte:window onmessage={onMessage} onkeydown={onKey} />

<ModalDialog open={true} ariaLabel={m.page_fullscreen_title({ title })} {onClose} className="page-dialog" initialFocus={closeButton}>
  <div class="page-full">
    <div class="bar">
      <span class="title">{title}</span>
      <div class="zoom">
        <button type="button" class="btn" aria-label={m.page_zoom_out()} title={m.page_zoom_out()}
          disabled={zoom <= PAGE_ZOOM_MIN} onclick={() => apply('out')}>−</button>
        <button type="button" class="btn pct" aria-label={m.page_zoom_reset()} title={m.page_zoom_reset()}
          onclick={() => apply('reset')}>{pageZoomLabel(zoom)}</button>
        <button type="button" class="btn" aria-label={m.page_zoom_in()} title={m.page_zoom_in()}
          disabled={zoom >= PAGE_ZOOM_MAX} onclick={() => apply('in')}>+</button>
      </div>
      <button type="button" class="btn" bind:this={closeButton} aria-label={m.page_close()} title={m.page_close()}
        onclick={onClose}>✕</button>
    </div>
    <div class="stage" bind:this={stage}>
      <div class="zoomed" style:zoom={zoom}>
        <!-- Mesmo isolamento do cartão: sem allow-same-origin e sem allow-popups. -->
        <iframe bind:this={frame} {title} srcdoc={src} sandbox="allow-scripts" referrerpolicy="no-referrer"
          onload={onFrameLoad} style:color-scheme={ownTheme ? 'normal' : scheme}></iframe>
      </div>
    </div>
  </div>
</ModalDialog>

<style>
  :global(.modal-dialog.page-dialog) { width: 92vw; max-width: 92vw; max-height: none; overflow: hidden; }
  .page-full { display: flex; flex-direction: column; min-width: 0; }
  .bar {
    display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
  }
  .title {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-secondary); font-size: var(--text-sm);
  }
  .zoom { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .btn {
    min-width: 32px; height: 32px; padding: 0 var(--space-2); display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); font: inherit;
    font-size: var(--text-sm); cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--bg-hover); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  /* Largura fixa: o número mudando não empurra os botões. */
  .pct { width: 56px; font-variant-numeric: tabular-nums; }
  .stage {
    height: min(86dvh, calc(100dvh - 160px)); overflow: auto; overscroll-behavior: contain;
    container-type: size; background: var(--surface-inset);
  }
  .zoomed { width: 100cqw; height: 100cqh; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
</style>
