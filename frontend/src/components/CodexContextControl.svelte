<script lang="ts">
  import { codexOpcoes, type Server } from '@hangar/core';
  import * as m from '../paraglide/messages';

  let { server, busy = $bindable(false) }: { server: Server | null; busy?: boolean } = $props();
  let enabled = $state(false);
  // O valor que a pessoa ESCOLHEU enquanto a gravação não volta: o switch mostra ele na hora.
  // Desfazer a marca e esperar o servidor fazia o clique parecer não ter pegado.
  let pedido = $state<boolean | null>(null);
  let ready = $state(false);
  let error = $state('');
  let context: { server: Server | null; controller: AbortController };

  async function update(ctx: typeof context, value?: boolean) {
    busy = true;
    error = '';
    if (value !== undefined) pedido = value;
    try {
      const result = await codexOpcoes(ctx.server, ctx.controller.signal, value);
      if (context !== ctx || ctx.controller.signal.aborted) return;
      enabled = result.contexto_estendido;
      ready = true;
    } catch (e) {
      if (context === ctx && !ctx.controller.signal.aborted) {
        error = e instanceof Error ? e.message : m.comum_falha_aplicar();
      }
    } finally {
      // Falhou ou confirmou: quem manda de novo é o valor do servidor.
      if (context === ctx && !ctx.controller.signal.aborted) { busy = false; pedido = null; }
    }
  }

  $effect(() => {
    const ctx = { server, controller: new AbortController() };
    context = ctx;
    ready = false;
    pedido = null;
    void update(ctx);
    return () => { ctx.controller.abort(); busy = false; };
  });
</script>

<div class="context-control">
  <label class:carregando={!ready}>
    <input type="checkbox" role="switch" checked={pedido ?? enabled} disabled={busy || !ready}
      onchange={(e) => { e.currentTarget.checked = !enabled; void update(context, !enabled); }} />
    <span class="titulo">{m.codex_contexto_titulo()}</span>
    {#if busy && pedido !== null}<span class="estado" role="status">{m.codex_contexto_salvando()}</span>
    {:else if busy}<span class="estado" role="status">{m.comum_carregando()}</span>{/if}
  </label>
  <p>{m.codex_contexto_padrao()}</p>
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" disabled={busy} onclick={() => update(context)}>{m.config_server_tentar_de_novo()}</button>
  {/if}
</div>

<style>
  .context-control { display: grid; grid-column: 1 / -1; gap: var(--space-2); }
  /* A linha inteira é o alvo do toque, com o switch colado ao nome: a caixa de 20px no canto
     oposto da linha era difícil de acertar. */
  label { display: flex; align-items: center; gap: var(--space-3); min-height: 44px;
          padding: 0 var(--space-2); margin: 0 calc(-1 * var(--space-2));
          border-radius: var(--radius-md); font-size: var(--text-sm); cursor: pointer; }
  label:hover { background: var(--surface-raised); }
  label.carregando { cursor: progress; }
  input { flex: none; width: 22px; height: 22px; margin: 0; accent-color: var(--accent); cursor: inherit; }
  .titulo { flex: 1; }
  .estado { font-size: var(--text-xs); color: var(--text-secondary); }
  p { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); }
  [role="alert"] { color: var(--error); }
  button { min-height: 44px; background: var(--surface-raised); border-radius: var(--radius-md); }
</style>
