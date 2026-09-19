<script lang="ts">
  // Confirmação do gesto de arrastar sessão sobre sessão (agrupar) ou soltar do grupo (sair).
  // Montado UMA vez no shell (App.svelte), reagindo a arrastarGrupo.pedido — as quatro superfícies
  // que arrastam (Sidebar/Board/Canvas/celular, Task 3+) só chamam arrastarGrupo.soltar/pedirSaida.
  import { untrack } from 'svelte';
  import ModalDialog from './ModalDialog.svelte';
  import { arrastarGrupo, mensagemRecusa, type ChaveSessao } from '../lib/arrastarGrupo.svelte';
  import { sessionsStore } from '../lib/sessionsStore.svelte';
  import { withServer } from '../lib/auth';
  import { pairSession, unpairSession, formataErro, canPair } from '@hangar/core';
  import type { AggSession } from '@hangar/core';
  import * as m from '../paraglide/messages';

  const pedido = $derived(arrastarGrupo.pedido);

  // Relido do store a CADA render — nunca o objeto capturado no clique: se o SSE mudar o grupo (ou
  // a sessão morrer) durante a confirmação, é este dado vivo que decide.
  function porChave(chave: ChaveSessao | undefined): AggSession | null {
    if (!chave) return null;
    return sessionsStore.rows.find((s) => s.serverId === chave.serverId && s.name === chave.name) ?? null;
  }

  const origemSessao = $derived(porChave(pedido?.origem));
  const alvoSessao = $derived.by(() => {
    const p = pedido;
    return p && p.modo === 'agrupar' ? porChave(p.alvo) : null;
  });

  // join_group funde os grupos INTEIROS (api.py:3581): a lista é a união de origem, alvo e os
  // pares de cada um — mostrar só os dois nomes escondia quem mais o arrasto afeta.
  const afetados = $derived.by(() => {
    if (pedido?.modo !== 'agrupar') return [];
    const nomes = new Set<string>();
    if (origemSessao) {
      nomes.add(origemSessao.name);
      for (const p of origemSessao.pair_peers ?? []) nomes.add(p);
    }
    if (alvoSessao) {
      nomes.add(alvoSessao.name);
      for (const p of alvoSessao.pair_peers ?? []) nomes.add(p);
    }
    return [...nomes];
  });

  const quemFica = $derived(pedido?.modo === 'sair' ? (origemSessao?.pair_peers ?? []) : []);

  // Recheca canPair contra o dado VIVO — pode ter deixado de valer entre abrir o pedido e
  // confirmar (sessão morreu, grupo mudou por outro caminho). Sessão sumida da lista conta como
  // 'dead': não há mais o que mostrar dela.
  const bloqueio = $derived.by((): string | null => {
    if (!pedido) return null;
    if (pedido.modo === 'sair') return origemSessao ? null : mensagemRecusa('dead');
    if (!origemSessao || !alvoSessao) return mensagemRecusa('dead');
    const r = canPair(origemSessao, alvoSessao);
    return r.ok ? null : mensagemRecusa(r.reason);
  });

  let tarefa = $state('');
  let busy = $state(false);
  let erro = $state<string | null>(null);
  let conflito = $state<string | null>(null); // mensagem do 409 — presente ativa "Substituir a tarefa"

  // Reinicia o formulário só quando um PEDIDO NOVO abre (a referência de `pedido` muda uma vez por
  // arrasto) — nunca a cada recompute do sessionsStore: um poll no meio da digitação não pode
  // apagar o campo. `untrack` pelo mesmo motivo do chainOpen no SessionContextMenu.
  $effect(() => {
    const p = pedido;
    if (!p) return;
    untrack(() => {
      tarefa = p.modo === 'agrupar' ? (alvoSessao?.pair_task || origemSessao?.pair_task || '') : '';
      busy = false;
      erro = null;
      conflito = null;
    });
  });

  function fechar() { arrastarGrupo.cancelar(); }

  async function confirmarAgrupar(substituir: boolean) {
    if (pedido?.modo !== 'agrupar' || busy) return;
    const o = origemSessao;
    const a = alvoSessao;
    if (!o || !a) { erro = mensagemRecusa('dead'); return; }
    const checagem = canPair(o, a);
    if (!checagem.ok) { erro = mensagemRecusa(checagem.reason); return; }
    busy = true;
    erro = null;
    try {
      const res = await withServer(a.serverId, () => pairSession(a.name, [o.name], tarefa.trim(), substituir));
      if (res.warning) {
        conflito = null;
        erro = formataErro(res.warning) ?? String(res.warning);
      } else {
        arrastarGrupo.cancelar();
      }
    } catch (e) {
      if (e instanceof Error && (e as { status?: number }).status === 409) {
        conflito = e.message;
      } else {
        conflito = null;
        erro = e instanceof Error && e.message ? e.message : m.grupo_drop_falhou();
      }
    } finally {
      busy = false;
    }
  }

  async function confirmarSair() {
    if (pedido?.modo !== 'sair' || busy) return;
    const o = origemSessao;
    if (!o) { erro = mensagemRecusa('dead'); return; }
    busy = true;
    erro = null;
    try {
      const res = await withServer(o.serverId, () => unpairSession(o.name));
      if (res.warning) erro = formataErro(res.warning) ?? String(res.warning);
      else arrastarGrupo.cancelar();
    } catch (e) {
      erro = e instanceof Error && e.message ? e.message : m.grupo_drop_sair_falhou();
    } finally {
      busy = false;
    }
  }
</script>

{#if pedido}
  <ModalDialog
    open={true}
    ariaLabel={pedido.modo === 'agrupar' ? m.grupo_drop_titulo() : m.grupo_drop_sair_titulo()}
    onClose={fechar}
    className="grupo-drop"
  >
    {#if pedido.modo === 'agrupar'}
      <h2 class="gd-title">{m.grupo_drop_titulo()}</h2>

      <div class="gd-afetadas">
        <p class="gd-label">{m.grupo_drop_afetadas()}</p>
        <ul class="gd-lista">
          {#each afetados as nome (nome)}<li>{nome}</li>{/each}
        </ul>
      </div>

      <input
        type="text"
        class="gd-tarefa"
        bind:value={tarefa}
        placeholder={m.grupo_drop_tarefa()}
        disabled={busy}
      />

      {#if erro}<p class="gd-erro">{erro}</p>{/if}
      {#if conflito}<p class="gd-erro">{conflito}</p>{/if}
      {#if bloqueio && !erro && !conflito}<p class="gd-erro">{bloqueio}</p>{/if}

      <div class="gd-acoes">
        <button type="button" class="gd-btn" onclick={fechar} disabled={busy}>{m.comum_cancelar()}</button>
        {#if conflito}
          <button type="button" class="gd-btn gd-primary" onclick={() => confirmarAgrupar(true)} disabled={busy}>
            {m.grupo_drop_substituir_tarefa()}
          </button>
        {:else}
          <button type="button" class="gd-btn gd-primary" onclick={() => confirmarAgrupar(false)} disabled={busy || !!bloqueio}>
            {m.grupo_drop_confirmar()}
          </button>
        {/if}
      </div>
    {:else}
      <h2 class="gd-title">{m.grupo_drop_sair_titulo()}</h2>

      {#if quemFica.length}
        <div class="gd-afetadas">
          <p class="gd-label">{m.grupo_drop_afetadas()}</p>
          <ul class="gd-lista">
            {#each quemFica as nome (nome)}<li>{nome}</li>{/each}
          </ul>
        </div>
      {/if}

      {#if erro}<p class="gd-erro">{erro}</p>{/if}
      {#if bloqueio && !erro}<p class="gd-erro">{bloqueio}</p>{/if}

      <div class="gd-acoes">
        <button type="button" class="gd-btn" onclick={fechar} disabled={busy}>{m.comum_cancelar()}</button>
        <button type="button" class="gd-btn gd-danger" onclick={confirmarSair} disabled={busy || !!bloqueio}>
          {m.grupo_drop_sair_confirmar()}
        </button>
      </div>
    {/if}
  </ModalDialog>
{/if}

<style>
  :global(.grupo-drop) {
    width: min(420px, 92vw);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .gd-title { font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
  .gd-afetadas { display: flex; flex-direction: column; gap: var(--space-1); }
  .gd-label { font-size: var(--text-sm); color: var(--text-secondary); }
  .gd-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .gd-lista li { font-size: var(--text-sm); color: var(--text-primary); }
  .gd-tarefa {
    height: 44px;
    padding: 0 var(--space-3);
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: 16px;
  }
  .gd-tarefa:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
  .gd-tarefa::placeholder { color: var(--text-muted); }
  .gd-erro { font-size: var(--text-sm); color: #e5484d; }
  .gd-acoes { display: flex; gap: var(--space-2); }
  .gd-btn {
    flex: 1;
    height: 40px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 600;
    background: var(--bg-hover);
    color: var(--text-secondary);
    border: 0;
    cursor: pointer;
  }
  .gd-btn:hover { background: var(--bg-surface); }
  .gd-btn:disabled { opacity: 0.5; cursor: default; }
  .gd-primary { background: var(--accent); color: #fff; }
  .gd-danger { background: var(--error); color: #fff; }
</style>
