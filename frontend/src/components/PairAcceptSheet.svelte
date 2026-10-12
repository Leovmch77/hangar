<script lang="ts">
  // Aceitar um convite de par: o link /par/ liga uma sessão minha à da outra pessoa, com o nível
  // que eu dou a ela nas sessões do meu grupo.
  import * as m from '../paraglide/messages';
  import ModalDialog from './ModalDialog.svelte';
  import { acceptPair, parsePairLink, type AggSession, type PairAccepted, type PairLevel } from '@hangar/core';
  import { sessionServerFor } from '../lib/sessionServer';

  // `sessions` nulo = a lista ainda não chegou.
  interface Props {
    sessions: AggSession[] | null;
    initial?: { serverId: string; name: string } | null;
    fallbackFocus?: HTMLElement | null;
    onFechar: () => void;
  }
  let { sessions, initial = null, fallbackFocus = null, onFechar }: Props = $props();

  let link = $state('');
  // svelte-ignore state_referenced_locally
  let alvo = $state<{ serverId: string; name: string } | null>(initial);
  let nivel = $state<PairLevel>('view');
  let ocupado = $state(false);
  let erro = $state('');
  let aceito = $state<PairAccepted | null>(null);

  const escolhida = $derived(alvo ? sessions?.find((s) => s.serverId === alvo!.serverId && s.name === alvo!.name) ?? null : null);
  // O acesso completo vale para o grupo inteiro da sessão escolhida.
  const abertas = $derived(escolhida?.pair_gid
    ? (sessions ?? []).filter((s) => s.serverId === escolhida.serverId && s.pair_gid === escolhida.pair_gid).map((s) => s.name)
    : alvo ? [alvo.name] : []);

  async function aceitar() {
    if (ocupado || !alvo || !link.trim()) return;
    if (!parsePairLink(link)) { erro = m.erro_par_link_invalido(); return; }
    ocupado = true;
    erro = '';
    try {
      aceito = await acceptPair(alvo.name, link, nivel, sessionServerFor(alvo.serverId)());
    } catch (e) {
      erro = e instanceof Error ? e.message : m.erro_desconhecido();
    } finally {
      ocupado = false;
    }
  }
</script>

<ModalDialog open={true} ariaLabel={m.native_par_titulo()} onClose={onFechar} {fallbackFocus} className="sd-dialogo">
  <div class="pa">
    <h2 class="pa-titulo">{alvo && initial ? m.native_par_titulo_sessao({ sessao: alvo.name }) : m.native_par_titulo()}</h2>
    {#if aceito}
      <p class="pa-ok" role="status">{m.native_par_aceito({ dono: aceito.owner, sessao: aceito.session })}</p>
      <p class="pa-ajuda">{aceito.level === 'full' ? m.pair_level_received_full({ dono: aceito.owner }) : m.pair_level_received_view({ dono: aceito.owner })}</p>
      <div class="pa-acoes">
        <button type="button" class="pa-btn primario" onclick={onFechar}>{m.sessao_fechar()}</button>
      </div>
    {:else if sessions === null}
      <p class="pa-ajuda" role="status">{m.comum_carregando()}</p>
    {:else if sessions.length === 0}
      <p class="pa-ajuda">{m.native_par_sem_sessao()}</p>
    {:else}
      <p class="pa-ajuda">{m.native_par_aceitar_ajuda()}</p>
      <input class="pa-campo" type="url" bind:value={link} aria-label={m.native_par_campo_aria()}
             placeholder={m.native_par_placeholder()} autocomplete="off" spellcheck="false"
             oninput={() => (erro = '')}
             onkeydown={(e) => { if (e.key === 'Enter') void aceitar(); }} />
      {#if !initial}
        <span class="pa-rotulo">{m.native_par_qual_sessao()}</span>
        <div class="pa-lista" role="radiogroup" aria-label={m.native_par_qual_sessao()}>
          {#each sessions as s (`${s.serverId}:${s.name}`)}
            {@const marcada = alvo?.serverId === s.serverId && alvo?.name === s.name}
            <button type="button" class="pa-btn" class:marcada role="radio" aria-checked={marcada}
                    onclick={() => (alvo = { serverId: s.serverId, name: s.name })}>{s.name}</button>
          {/each}
        </div>
      {/if}
      <span class="pa-rotulo">{m.pair_level_title()}</span>
      <div class="pa-lista" role="radiogroup" aria-label={m.pair_level_title()}>
        <button type="button" class="pa-btn" class:marcada={nivel === 'full'} role="radio" aria-checked={nivel === 'full'}
                onclick={() => (nivel = 'full')}>{m.pair_level_full()}</button>
        <span class="pa-ajuda">{m.pair_level_full_hint()}</span>
        <button type="button" class="pa-btn" class:marcada={nivel === 'view'} role="radio" aria-checked={nivel === 'view'}
                onclick={() => (nivel = 'view')}>{m.pair_level_view()}</button>
        <span class="pa-ajuda">{m.pair_level_view_hint()}</span>
      </div>
      {#if nivel === 'full' && abertas.length}
        <p class="pa-aviso" role="note">{m.pair_opens_sessions({ sessoes: abertas.join(', ') })}</p>
      {/if}
      {#if erro}<p class="pa-erro" role="alert">{erro}</p>{/if}
      <div class="pa-acoes">
        <button type="button" class="pa-btn" onclick={onFechar}>{m.comum_cancelar()}</button>
        <button type="button" class="pa-btn primario" onclick={aceitar} disabled={ocupado || !alvo || !link.trim()}>
          {ocupado ? m.native_par_aceitando() : m.native_par_aceitar()}
        </button>
      </div>
    {/if}
  </div>
</ModalDialog>

<style>
  .pa { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); background: transparent; }
  .pa-titulo { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
  .pa-ajuda, .pa-ok { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .pa-ok { color: var(--text-primary); }
  .pa-aviso { margin: 0; font-size: var(--text-sm); color: var(--warning); }
  .pa-rotulo { font-size: var(--text-sm); font-weight: 600; color: var(--text-secondary); }
  .pa-campo {
    height: 36px; padding: 0 var(--space-3); font-size: var(--text-sm); color: var(--text-primary);
    background: var(--surface-inset); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  }
  .pa-lista { display: flex; flex-direction: column; gap: var(--space-1); }
  .pa-erro { margin: 0; font-size: var(--text-sm); color: var(--error); }
  .pa-acoes { display: flex; justify-content: flex-end; gap: var(--space-2); }
  .pa-btn {
    min-height: 32px; padding: 0 var(--space-3); font-size: var(--text-sm); color: var(--text-primary); text-align: left;
    background: transparent; border: 1px solid var(--border-default); border-radius: var(--radius-sm); cursor: pointer;
  }
  .pa-btn.marcada { border-color: var(--accent); background: var(--accent-dim); }
  .pa-btn.primario { color: var(--accent); background: var(--accent-dim); border-color: transparent; font-weight: 600; }
  .pa-btn:disabled { opacity: 0.5; cursor: default; }
</style>
