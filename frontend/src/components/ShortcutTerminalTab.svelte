<script lang="ts">
  // Uma aba de terminal de atalho no painel do desktop: o mesmo cano do attach (TermSocket +
  // xterm), mirando `?shortcut=<id>` — o backend confere que o terminal e DESTA sessao antes de
  // anexar. O pane fica depois que o comando sai, entao anexar num terminal encerrado mostra a
  // saida final e o "Pane is dead (status N)".
  import { TermSocket, termUrlForServer } from '../lib/term';
  import { novoTerminal, temaDe } from '../lib/xterm';
  import type { Server } from '../lib/auth';
  import type { Terminal } from '@xterm/xterm';
  import * as m from '../paraglide/messages';

  // `hangar`: terminal No Hangar (sem sessão dona). O backend guarda UM cliente por alvo, então
  // ele só conecta enquanto a aba está visível — senão painel, celular e nativo se derrubariam.
  interface Props { srv: Server; sessionName: string; id: string; visible: boolean; hangar?: boolean }
  let { srv, sessionName, id, visible, hangar = false }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let caiu = $state(false);
  let motivo = $state<string | null>(null);
  let geracao = $state(0);
  let term: Terminal | null = null;

  $effect(() => { if (visible) term?.focus(); });

  $effect(() => {
    const hostEl = host;
    const alvo = sessionName, ident = id, server = srv;
    void geracao;
    if (!hostEl) return;
    if (hangar && !visible) return;
    let vivo = true;
    let sock: TermSocket | null = null;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    caiu = false;
    motivo = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (!vivo) return;
      const r = novoTerminal(hostEl, Terminal, FitAddon);
      term = r.term;
      const t = r.term;
      mo = new MutationObserver(() => { t.options.theme = temaDe(hostEl); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const enc = new TextEncoder();
      sock = new TermSocket(termUrlForServer(server, alvo, t.cols, t.rows, hangar ? { hangar: ident } : { shortcut: ident }), {
        data: (b) => t.write(b),
        close: (why) => { if (vivo) { caiu = true; motivo = why ?? null; } },
      });
      t.onData((d: string) => sock?.send(enc.encode(d)));
      ro = new ResizeObserver(() => { r.fit.fit(); sock?.resize(t.cols, t.rows); });
      ro.observe(hostEl);
      if (visible) t.focus();
    })().catch((e) => {
      if (!vivo) return;
      caiu = true;
      motivo = e instanceof Error ? m.term_falha_carregar_msg({ msg: e.message }) : m.term_falha_carregar();
    });

    return () => {
      vivo = false;
      ro?.disconnect();
      mo?.disconnect();
      sock?.close();
      term?.dispose(); term = null;
    };
  });
</script>

<div class="tp-screen" class:hidden={!visible} bind:this={host}></div>
{#if caiu && visible}
  <button class="sc-recon" title={motivo ?? undefined} onclick={() => geracao++}>
    {motivo ?? m.term_desconectado()} {m.term_reconectar()}
  </button>
{/if}

<style>
  /* Mesmo vidro das telas irmas do TerminalPanel (o fundo do xterm e rgba(0,0,0,0)). */
  .tp-screen { position: absolute; inset: 0; background: var(--glass-panel); }
  .tp-screen.hidden { visibility: hidden; }
  .tp-screen :global(.xterm-viewport) { background-color: transparent; }
  .sc-recon {
    position: absolute; top: var(--space-1); right: var(--space-2); z-index: 2; max-width: 60%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 2px var(--space-2); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);
    background: var(--surface-raised); color: var(--text-muted); font-size: var(--text-xs); cursor: pointer;
  }
</style>
