<script lang="ts">
  // Entrar numa sessão que alguém compartilhou: o link vira um servidor de convite neste aparelho.
  import * as m from '../../paraglide/messages';
  import ModalDialog from '../ModalDialog.svelte';
  import { parseInviteLink, redeemInvite } from '@hangar/core';
  import { addInviteServer } from '../../lib/auth';
  import { sessionsStore } from '../../lib/sessionsStore.svelte';

  interface Props { fallbackFocus?: HTMLElement | null; onFechar: () => void }
  let { fallbackFocus = null, onFechar }: Props = $props();

  let link = $state('');
  let ocupado = $state(false);
  let erro = $state('');

  async function entrar() {
    if (ocupado || !link.trim()) return;
    if (!parseInviteLink(link)) { erro = m.convite_link_invalido(); return; }
    ocupado = true;
    erro = '';
    try {
      const r = await redeemInvite(link, m.convite_aparelho_web({ plataforma: navigator.platform || '?' }));
      addInviteServer(r);
      sessionsStore.refreshServers();
      onFechar();
    } catch (e) {
      // 'unavailable' (503) traz a mensagem de tentar de novo e o diálogo segue aberto: o código não foi gasto.
      erro = e instanceof Error ? e.message : m.erro_desconhecido();
    } finally {
      ocupado = false;
    }
  }
</script>

<ModalDialog open={true} ariaLabel={m.convite_colar_titulo()} onClose={onFechar} {fallbackFocus} className="sd-dialogo">
  <div class="cc">
    <h2 class="cc-titulo">{m.convite_colar_titulo()}</h2>
    <p class="cc-ajuda">{m.convite_colar_ajuda()}</p>
    <input class="cc-campo" type="url" bind:value={link} aria-label={m.convite_campo_aria()}
           placeholder={m.convite_placeholder()} autocomplete="off" spellcheck="false"
           onkeydown={(e) => { if (e.key === 'Enter') void entrar(); }} />
    {#if erro}<p class="cc-erro" role="alert">{erro}</p>{/if}
    <div class="cc-acoes">
      <button type="button" class="cc-btn" onclick={onFechar}>{m.comum_cancelar()}</button>
      <button type="button" class="cc-btn primario" onclick={entrar} disabled={ocupado || !link.trim()}>
        {ocupado ? m.convite_entrando() : m.convite_entrar()}
      </button>
    </div>
  </div>
</ModalDialog>

<style>
  .cc { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); background: transparent; }
  .cc-titulo { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
  .cc-ajuda { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .cc-campo {
    height: 36px; padding: 0 var(--space-3); font-size: var(--text-sm); color: var(--text-primary);
    background: var(--surface-inset); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  }
  .cc-erro { margin: 0; font-size: var(--text-sm); color: var(--error); }
  .cc-acoes { display: flex; justify-content: flex-end; gap: var(--space-2); }
  .cc-btn {
    height: 32px; padding: 0 var(--space-3); font-size: var(--text-sm); color: var(--text-primary);
    background: transparent; border: 1px solid var(--border-default); border-radius: var(--radius-sm); cursor: pointer;
  }
  .cc-btn.primario { color: var(--accent); background: var(--accent-dim); border-color: transparent; font-weight: 600; }
  .cc-btn:disabled { opacity: 0.5; cursor: default; }
</style>
