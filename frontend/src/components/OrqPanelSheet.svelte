<script lang="ts">
  import * as m from '../paraglide/messages';
  import type { Server } from '@hangar/core';
  import BottomSheet from './BottomSheet.svelte';
  import OrqPanel from './OrqPanel.svelte';

  // O mesmo conteúdo da aba "Orquestração", para onde o painel lateral não aparece.
  interface Props {
    open: boolean;
    onClose: () => void;
    server: Server;
    sessionName: string;
    arbiter: string | null;
    onOpenSession: (name: string) => void;
    onOpenFile: (path: string) => void;
  }
  let { open, onClose, server, sessionName, arbiter, onOpenSession, onOpenFile }: Props = $props();
</script>

<BottomSheet {open} {onClose} ariaLabel={m.orq_tab_title()}>
  <!-- Fechada a folha o painel desmonta: nenhum pedido a cada 10 s com ela escondida. -->
  {#if open}
    <div class="body">
      <h2>{m.orq_tab_title()}</h2>
      <OrqPanel {server} {sessionName} {arbiter}
                onOpenSession={(n) => { onClose(); onOpenSession(n); }}
                onOpenFile={(p) => { onClose(); onOpenFile(p); }} />
    </div>
  {/if}
</BottomSheet>

<style>
  .body { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4) var(--space-6); }
  h2 { margin: 0; font-size: var(--text-lg); }
</style>
