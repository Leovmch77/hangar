<script lang="ts">
  import { onMount } from 'svelte';
  import { buildQuoteRef, quoteTooLong } from '@hangar/core';
  import * as m from '../paraglide/messages';
  import { captureQuote, type CapturedQuote } from '../lib/citeSelection';
  import { citeDialog } from '../lib/citeDialog.svelte';
  import { rafThrottle } from '../lib/rafThrottle';

  // "Citar" para o texto selecionado dentro de UMA resposta do assistente. Mesmo lugar da pílula do
  // Ouvir trecho (rente ao campo de mensagem), empilhada acima dela quando as duas aparecem.
  interface Props {
    /** Chave da bandeja (`contextRefsKey`): a citação entra na sessão desta conversa. */
    draftKey: string;
  }
  let { draftKey }: Props = $props();

  let cap = $state<CapturedQuote | null>(null);

  function sameQuote(a: CapturedQuote, b: CapturedQuote | null): boolean {
    return !!b && a.source === b.source && a.text === b.text && a.before === b.before && a.after === b.after;
  }
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    // A seleção que some não esconde na hora: no toque, o próprio botão pode colapsá-la antes do
    // clique chegar, e a captura já guardada é o que vale.
    const process = () => {
      // Com o modal aberto a seleção que sobrou não oferece outro Citar por trás dele.
      if (citeDialog.request) { cap = null; return; }
      const c = captureQuote(document.getSelection());
      clearTimeout(hideTimer);
      // A mesma seleção não troca o estado: `selectionchange` dispara a cada passo do arrasto.
      if (c) { if (!sameQuote(c, cap)) cap = c; }
      else if (cap) hideTimer = setTimeout(() => (cap = null), 400);
    };
    const { agendar, cancelar } = rafThrottle(process);
    document.addEventListener('selectionchange', agendar);
    return () => {
      document.removeEventListener('selectionchange', agendar);
      cancelar();
      clearTimeout(hideTimer);
    };
  });

  const tooLong = $derived(!!cap && quoteTooLong(cap.text));

  function dismiss() {
    clearTimeout(hideTimer);
    cap = null;
  }

  function cite() {
    if (!cap || tooLong) return;
    const ref = buildQuoteRef(cap);
    if (!ref) return;
    // A citação só entra na bandeja quando a pessoa confirma no modal; a seleção fica até lá.
    dismiss();
    citeDialog.open(draftKey, ref);
  }
</script>

{#if cap}
  <button
    type="button"
    class="cite-pill"
    disabled={tooLong}
    aria-label={tooLong ? m.cite_too_long_aria() : m.cite_selection_aria()}
    onpointerdown={(e) => e.preventDefault()}
    onclick={cite}
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } }}
  >
    <span class="cite-ico" aria-hidden="true">❝</span>{tooLong ? m.cite_shorten() : m.cite_action()}
  </button>
{/if}

<style>
  /* Pílula igual à do Ouvir trecho (TtsSelectionPill): raio total, contorno de destaque. Sem
     backdrop-filter nem transform em barra fixa (WebKit pinta preto na rolagem por inércia). */
  .cite-pill {
    position: fixed;
    z-index: 39;
    left: 0;
    right: 0;
    margin: 0 auto;
    width: fit-content;
    /* Com a pílula do Ouvir na tela (--cp-tts-h > 0), 8px de folga acima dela; sem ela, nada. */
    bottom: calc(var(--cp-dock-h, 150px) + 10px + var(--cp-tts-h, 0px) + min(var(--cp-tts-h, 0px), 8px));
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-full);
    border: 1px solid var(--accent);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .cite-pill:active:not(:disabled) { color: var(--accent); }
  .cite-pill:disabled { cursor: default; border-color: var(--border-subtle); color: var(--text-secondary); }
  .cite-ico { color: var(--accent); font-size: 1.1em; line-height: 1; }
  .cite-pill:disabled .cite-ico { color: var(--text-muted); }
</style>
