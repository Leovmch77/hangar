<script lang="ts">
  import { useSessionServer } from '../lib/sessionServer';
  import * as m from '../paraglide/messages';
  import { getSessionPlanPreview, planTitle, type SessionPlanPreview } from '@hangar/core';
  import { renderMarkdown } from '../lib/markdown';
  import BottomSheet from './BottomSheet.svelte';

  type ClaudePlanPreview = SessionPlanPreview & { anchor_id?: string | null };

  interface Props {
    sessionName: string;
    serverId?: string;
    provider: string;
    revision: string;
    desktop: boolean;
    codexPlan: string | null;
    disabled: boolean;
    onImplement: (plan: string) => Promise<void>;
    discovery?: ClaudePlanPreview | null;
    discoveryLoading?: boolean;
    discoveryError?: string;
    onRetryDiscovery?: () => void;
    /** Plano aguardando aprovação no seletor da sessão: o card só mostra, não implementa. */
    aprovacaoPendente?: boolean;
    /** Arquivo do plano quando ele não veio da descoberta. */
    caminho?: string | null;
  }
  let {
    sessionName, serverId = '', provider, revision, desktop, codexPlan, disabled, onImplement,
    discovery = undefined, discoveryLoading = false, discoveryError = '', onRetryDiscovery,
    aprovacaoPendente = false, caminho = null,
  }: Props = $props();
  const sessionServer = useSessionServer();
  let metadata = $state<ClaudePlanPreview | null>(null);
  let modalMetadata = $state<ClaudePlanPreview | null>(null);
  let open = $state(false);
  let markdown = $state('');
  let loading = $state(false);
  let error = $state('');
  let sending = $state(false);
  let actionError = $state('');
  let discoveryErrorInterno = $state('');
  let discoveryLoadingInterno = $state(false);
  let retriesInterno = $state(0);
  let dismissed = $state<string | null>(null);
  let implemented = $state<string | null>(null);
  let generation = 0;
  let identidadeInterna = '';
  let ultimoEstado: string | null = null;
  let ultimaBusca = '';
  const discoveryControlada = $derived(discovery !== undefined);
  const metadataAtual = $derived(discoveryControlada ? discovery : metadata);
  const discoveryLoadingAtual = $derived(discoveryControlada ? discoveryLoading : discoveryLoadingInterno);
  const discoveryErrorAtual = $derived(discoveryControlada ? discoveryError : discoveryErrorInterno);
  const metadataModal = $derived(modalMetadata ?? metadataAtual);
  const titleText = $derived(codexPlan ?? (markdown || metadataModal?.markdown || ''));
  const title = $derived(planTitle(titleText) ?? m.chat_plan_proposto());
  const html = $derived(renderMarkdown(semTituloRepetido(markdown, title), { joinWrapped: true }));

  // Plano esperando a decisão: aberto acima das opções, porque escolher sem ler era o problema.
  // Sem terminal o texto vem no estado; com terminal ele é buscado pela prévia. Só no celular: a
  // vista desktop da web não ganha recurso novo.
  const emAprovacao = $derived(aprovacaoPendente && !desktop);
  let inlineMarkdown = $state('');
  let inlineLoading = $state(false);
  let inlineError = $state('');
  let inlineRetry = $state(0);
  let inlineKey = '';
  let inlineGeneration = 0;
  const inlineTexto = $derived(aprovacaoPendente && codexPlan ? codexPlan : inlineMarkdown);
  const inlineTitulo = $derived(planTitle(inlineTexto) ?? metadataAtual?.name ?? m.chat_plan_proposto());
  // O título já está no cabeçalho do cartão: o `# título` do topo do texto sairia repetido.
  const inlineHtml = $derived(renderMarkdown(semTituloRepetido(inlineTexto, inlineTitulo), { joinWrapped: true }));
  const inlineCaminho = $derived(metadataAtual?.path ?? caminho ?? null);
  let corpo = $state<HTMLElement | null>(null);
  let temMais = $state(false);

  $effect(() => {
    if (!emAprovacao || (aprovacaoPendente && codexPlan)) return;
    const key = `${serverId}\0${sessionName}\0${metadataAtual?.path ?? ''}\0${inlineRetry}`;
    if (key === inlineKey) return;
    inlineKey = key;
    const request = ++inlineGeneration;
    inlineLoading = true;
    inlineError = '';
    getSessionPlanPreview(sessionName, true, sessionServer()).then((value) => {
      if (request !== inlineGeneration) return;
      inlineMarkdown = (value as ClaudePlanPreview | null)?.markdown ?? '';
      inlineError = value ? '' : m.chat_plan_ausente();
    }).catch((cause) => {
      if (request !== inlineGeneration) return;
      inlineError = (cause as { status?: number }).status === 404 ? m.chat_plan_ausente() : m.chat_plan_erro();
    }).finally(() => {
      if (request === inlineGeneration) inlineLoading = false;
    });
  });

  function semTituloRepetido(texto: string, titulo: string): string {
    const linhas = texto.split(/\r?\n/);
    const primeira = linhas.findIndex((linha) => linha.trim() !== '');
    const cabecalho = primeira >= 0 ? linhas[primeira].match(/^ {0,3}#\s+(.*?)\s*#*\s*$/) : null;
    if (!cabecalho || cabecalho[1] !== titulo) return texto;
    return linhas.slice(primeira + 1).join('\n');
  }

  // Esmaece o pé do texto enquanto houver mais plano abaixo da dobra.
  function medir() {
    if (!corpo) return;
    temMais = corpo.scrollHeight - corpo.scrollTop - corpo.clientHeight > 4;
  }
  $effect(() => {
    void inlineHtml;
    if (!corpo) return;
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(corpo);
    return () => observador.disconnect();
  });

  function telaCheia() {
    if (inlineTexto) {
      generation++;
      error = '';
      loading = false;
      modalMetadata = metadataAtual ?? null;
      markdown = inlineTexto;
      open = true;
    } else void show();
  }

  $effect(() => {
    const name = sessionName;
    const source = provider;
    const key = `${serverId}\0${name}`;
    if (discoveryControlada || source !== 'claude') {
      if (source !== 'claude') {
        metadata = null;
        discoveryErrorInterno = '';
        discoveryLoadingInterno = false;
        identidadeInterna = '';
        ultimoEstado = null;
        ultimaBusca = '';
      }
      return;
    }
    if (key !== identidadeInterna) {
      identidadeInterna = key;
      metadata = null;
      discoveryErrorInterno = '';
      ultimoEstado = null;
      ultimaBusca = '';
    }
    const previous = ultimoEstado;
    ultimoEstado = revision;
    const retry = retriesInterno > 0;
    const concluded = previous === 'working' && (revision === 'idle' || revision === 'awaiting_input');
    const requestKey = `${key}\0${revision}\0${retriesInterno}`;
    if (!retry && !concluded && previous !== null) return;
    if (requestKey === ultimaBusca) return;
    ultimaBusca = requestKey;
    discoveryErrorInterno = '';
    discoveryLoadingInterno = true;
    const request = ++generation;
    getSessionPlanPreview(name, true, sessionServer()).then((value) => {
      if (request !== generation) return;
      metadata = value as ClaudePlanPreview | null;
      discoveryLoadingInterno = false;
      discoveryErrorInterno = '';
    }).catch(() => {
      if (request !== generation) return;
      discoveryLoadingInterno = false;
      discoveryErrorInterno = m.chat_plan_erro();
    });
  });

  async function show() {
    const request = ++generation;
    open = true;
    error = '';
    markdown = '';
    modalMetadata = null;
    loading = true;
    try {
      // Sem arquivo descoberto o plano É o texto da resposta (Codex, Claude sem terminal sem
      // arquivo): nada a buscar no servidor.
      if (codexPlan !== null && !metadataAtual) markdown = codexPlan;
      else {
        const result = await getSessionPlanPreview(sessionName, true, sessionServer()) as ClaudePlanPreview | null;
        if (request !== generation) return;
        modalMetadata = result;
        if (!result) error = m.chat_plan_ausente();
        else markdown = result.markdown ?? '';
      }
    } catch (cause) {
      if (request !== generation) return;
      error = (cause as { status?: number }).status === 404 ? m.chat_plan_ausente() : m.chat_plan_erro();
    } finally {
      if (request === generation) loading = false;
    }
  }

  async function implement() {
    if (!codexPlan || disabled || sending) return;
    const plan = codexPlan;
    sending = true;
    actionError = '';
    try { await onImplement(plan); implemented = plan; open = false; }
    catch (cause) { actionError = cause instanceof Error ? cause.message : m.chat_plan_erro(); }
    finally { sending = false; }
  }

  function close() { open = false; generation++; }
</script>

{#if emAprovacao}
  <section class="plan-inline" aria-label={m.chat_plan_proposto()}>
    <header class="inline-head">
      <div class="inline-title">
        <h3>{inlineTitulo}</h3>
        <p>{m.chat_plan_aprovar_dica()}</p>
      </div>
      <button class="icon-btn" onclick={telaCheia} aria-label={m.chat_plan_tela_cheia()} title={m.chat_plan_tela_cheia()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>
    </header>
    {#if inlineTexto}
      <div class="inline-body prose" class:fade={temMais} bind:this={corpo} onscroll={medir} tabindex="0" role="region" aria-label={inlineTitulo}>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html inlineHtml}
      </div>
    {:else if inlineLoading}
      <p class="plan-status" role="status">{m.chat_plan_carregando()}</p>
    {:else if inlineError}
      <div class="inline-problem">
        <p class="error-msg" role="alert">{inlineError}</p>
        <button class="ghost-btn" onclick={() => { inlineRetry++; }}>{m.lista_tentar_novamente()}</button>
      </div>
    {:else}
      <p class="plan-status">{m.chat_plan_ausente()}</p>
    {/if}
    {#if inlineCaminho}<p class="inline-path">{inlineCaminho}</p>{/if}
  </section>
{:else if metadataAtual || (codexPlan && implemented !== codexPlan) || actionError || discoveryErrorAtual}
  <div class="plan-preview" role="group" aria-label={m.chat_plan_proposto()}>
    {#if metadataAtual || codexPlan}
      <button class="plan-open" onclick={show}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>
        <span class="plan-name">{title}</span>
        <span class="plan-label">{m.chat_plan_ver()}</span>
      </button>
    {/if}
    {#if discoveryLoadingAtual}<p class="plan-status" role="status">{m.chat_plan_carregando()}</p>{/if}
    {#if codexPlan && dismissed !== codexPlan && !aprovacaoPendente}
      <div class="plan-actions">
        <button class="primary-btn" onclick={implement} disabled={disabled || sending}>
          {sending ? m.chat_plan_iniciando() : m.chat_plan_implementar()}
        </button>
        <button class="ghost-btn" onclick={() => { dismissed = codexPlan; }} disabled={sending}>
          {m.chat_plan_continuar()}
        </button>
      </div>
    {/if}
    {#if actionError}<p class="error-msg" role="alert">{actionError}</p>{/if}
    {#if discoveryErrorAtual}
      <p class="error-msg" role="alert">{discoveryErrorAtual}</p>
      <button class="ghost-btn" onclick={() => onRetryDiscovery ? onRetryDiscovery() : retriesInterno++}>{m.lista_tentar_novamente()}</button>
    {/if}
  </div>
{/if}

<BottomSheet {open} onClose={close} wide={desktop} centered={desktop}
  ariaLabel={m.chat_plan_ver()}>
  <header class="preview-header">
    <h2>{title}</h2>
    <button class="ghost-btn" onclick={close}>{m.sessao_fechar()}</button>
  </header>
  {#if metadataModal}<p class="plan-path">{metadataModal.path}</p>
  {:else if caminho}<p class="plan-path">{caminho}</p>{/if}
  {#if loading}<p role="status">{m.chat_plan_carregando()}</p>
  {:else if error}
    <p class="error-msg" role="alert">{error}</p>
    <button class="ghost-btn" onclick={show}>{m.lista_tentar_novamente()}</button>
  {:else}<div class="prose">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html html}
  </div>{/if}
</BottomSheet>

<style>
  /* O trilho à esquerda é o sinal de "isto espera você"; o resto fica no material do painel. */
  .plan-inline { display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border: 1px solid var(--border-subtle); border-left: 3px solid var(--accent); border-radius: var(--radius-lg); background: var(--surface-raised); }
  .inline-head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
  .inline-title { flex: 1; min-width: 0; }
  .inline-title h3 { margin: 0; font-size: var(--text-base); font-weight: 650; line-height: 1.3; color: var(--text-primary); overflow-wrap: anywhere; }
  .inline-title p { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .icon-btn { flex-shrink: 0; display: grid; place-items: center; width: 44px; height: 44px; margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) 0 0;
    color: var(--text-secondary); border-radius: var(--radius-md); }
  .icon-btn:hover { color: var(--text-primary); background: var(--surface-inset); }
  .inline-body { max-height: clamp(160px, 44vh, 560px); overflow-y: auto; overscroll-behavior: contain; padding-right: var(--space-2);
    font-size: var(--text-sm); border-top: 1px solid var(--border-subtle); padding-top: var(--space-3); }
  .inline-body.fade { mask-image: linear-gradient(to bottom, #000 calc(100% - 48px), transparent); -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 48px), transparent); }
  .inline-body:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .inline-body.prose :global(> :first-child) { margin-top: 0; }
  /* Escala do cartão: os títulos do plano organizam o texto, não competem com o cabeçalho. */
  .inline-body.prose :global(h1), .inline-body.prose :global(h2) { font-size: var(--text-base); margin: var(--space-4) 0 var(--space-2); }
  .inline-body.prose :global(h3), .inline-body.prose :global(h4) { font-size: var(--text-sm); margin: var(--space-3) 0 var(--space-1); }
  .inline-problem { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .inline-path { margin: 0; font-size: var(--text-xs); color: var(--text-muted); overflow-wrap: anywhere; }
  .plan-preview { padding: var(--space-3); display: grid; gap: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); min-width: 0; }
  .preview-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .preview-header h2 { min-width: 0; overflow-wrap: anywhere; }
  .preview-header button { flex-shrink: 0; min-height: 44px; }
  .plan-open { display: flex; gap: var(--space-2); align-items: center; min-height: 44px; width: 100%; min-width: 0; color: var(--accent); text-align: left; border-radius: var(--radius-sm); }
  .plan-open svg { flex-shrink: 0; }
  .plan-name { flex: 1; min-width: 0; color: var(--text-primary); font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
  .plan-label { flex-shrink: 0; font-size: var(--text-sm); }
  .plan-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .plan-actions button { min-height: 44px; }
  .plan-status { color: var(--text-muted); font-size: var(--text-sm); margin: 0; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .primary-btn { padding: var(--space-2) var(--space-4); background: var(--accent); color: var(--bg-base); border-radius: var(--radius-md); font-weight: 650; }
  .primary-btn:disabled { opacity: .5; cursor: default; }
  .ghost-btn { padding: var(--space-2) var(--space-3); color: var(--text-secondary); border-radius: var(--radius-md); }
  .ghost-btn:hover { background: var(--surface-raised); }
  .error-msg { color: var(--error); font-size: var(--text-sm); }
  .plan-path { color: var(--text-muted); font-size: var(--text-sm); overflow-wrap: anywhere; margin: var(--space-2) 0 var(--space-4); }
  .prose { overflow-wrap: anywhere; line-height: 1.65; color: var(--text-primary); }
  .prose :global(h1) { font-size: var(--text-xl); margin: var(--space-5) 0 var(--space-3); }
  .prose :global(h2) { font-size: var(--text-lg); margin: var(--space-5) 0 var(--space-2); }
  .prose :global(h3) { font-size: var(--text-base); margin: var(--space-4) 0 var(--space-2); }
  .prose :global(p), .prose :global(ul), .prose :global(ol) { margin: 0 0 var(--space-3); }
  .prose :global(ul), .prose :global(ol) { padding-left: 1.4em; }
  .prose :global(li) { margin: var(--space-1) 0; }
  .prose :global(code) { background: var(--surface-raised); font-family: var(--font-mono); font-size: .9em; padding: 0 .2em; border-radius: var(--radius-sm); }
  .prose :global(pre) { overflow-x: auto; background: var(--surface-inset); padding: var(--space-3); }
  .prose :global(pre code) { background: transparent; padding: 0; }
  .prose :global(a) { color: var(--accent); text-decoration: underline; }
  .prose :global(blockquote) { margin: var(--space-3); color: var(--text-secondary); }
</style>
