<script lang="ts">
  // Seção "Ações": os atalhos customizados como blocos (ícone em cima, rótulo embaixo), no desenho do
  // painel direito do app nativo. Grade que quebra linha em vez de rolar: com mais largura cabem mais
  // colunas, e cada bloco divide a linha por igual. Usada no painel do desktop e no "⋯" do celular.
  import ShortcutIcon from './icons/ShortcutIcon.svelte';
  import { shortcutMissingSecret, type ShortcutSendText, type ShortcutShell } from '@hangar/core';
  import type { Snippet } from 'svelte';
  import type { CustomScoped } from '../lib/shortcuts.svelte';
  import * as m from '../paraglide/messages';

  interface Props {
    shortcuts: CustomScoped[];
    onShortcut: (s: ShortcutSendText | ShortcutShell) => void;
    onAdd?: () => void;
    // Controles extras do cabeçalho (menu de importar/exportar), à direita do "+".
    extra?: Snippet;
    // Nome do projeto da sessão (dica da marca) e erro ao ler os atalhos dele (uma linha discreta).
    projectName?: string;
    projectError?: string;
  }
  let { shortcuts, onShortcut, onAdd, extra, projectName = '', projectError = '' }: Props = $props();
</script>

<section class="acoes" aria-label={m.ctx_acoes()}>
  <div class="acoes-topo">
    <span class="acoes-titulo">{m.ctx_acoes()}</span>
    <span class="acoes-ctl">
      {@render extra?.()}
      {#if onAdd}
        <button type="button" class="acoes-add" onclick={onAdd} aria-label={m.atalhos_add()} title={m.atalhos_add()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      {/if}
    </span>
  </div>
  <div class="acoes-grade">
    {#each shortcuts as { shortcut: s, scope, key } (key)}
      {@const falta = shortcutMissingSecret(s)}
      {@const rotulo = scope === 'project' ? m.atalhos_projeto_marca({ rotulo: s.label, nome: projectName }) : s.label}
      <!-- Credencial em branco (veio de uma importação): o bloco fica apagado e o clique avisa. -->
      <button type="button" class="acao-bloco" class:pendente={!!falta} onclick={() => onShortcut(s)}
              aria-label={rotulo} title={falta ? m.atalhos_segredo_falta({ nome: falta }) : rotulo}>
        {#if scope === 'project'}<span class="acao-projeto" aria-hidden="true"></span>{/if}
        <ShortcutIcon icon={s.icon} />
        <span class="acao-rotulo">{s.label}</span>
      </button>
    {/each}
  </div>
  {#if projectError}
    <p class="acoes-erro" title={projectError}>{m.atalhos_projeto_erro_fileira({ msg: projectError })}</p>
  {/if}
</section>

<style>
  .acoes { display: flex; flex-direction: column; gap: var(--space-2); }
  .acoes-topo { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 24px; }
  /* Mesma receita dos rótulos de seção do painel (tokens de app.css). */
  .acoes-titulo {
    color: var(--text-muted); font-size: var(--label-size); font-weight: var(--label-weight);
    letter-spacing: var(--label-tracking); text-transform: uppercase;
  }
  .acoes-ctl { position: relative; display: inline-flex; align-items: center; gap: 2px; }
  .acoes-add {
    display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
    border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer;
  }
  .acoes-add:hover { background: var(--surface-raised); color: var(--text-primary); }
  .acoes-add:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* auto-fit + minmax: as colunas saem da largura e as vazias somem, então poucos blocos dividem a
     linha inteira em vez de ficarem encostados à esquerda. */
  .acoes { container-type: inline-size; }
  /* No máximo cinco por linha: o piso da coluna é o maior entre 88px e um quinto da linha. */
  .acoes-grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(max(88px, calc((100% - 24px) / 5)), 1fr)); gap: 6px; }
  @container (max-width: 200px) { .acoes-grade { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .acao-bloco {
    position: relative; min-width: 0; min-height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; padding: 8px 4px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
    background: transparent; color: var(--text-secondary); cursor: pointer;
    transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
  }
  .acao-bloco:hover { background: var(--surface-raised); color: var(--text-primary); }
  .acao-bloco:active { background: var(--bg-hover); }
  .acao-bloco.pendente { opacity: 0.55; border-style: dashed; }
  .acao-bloco:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .acao-bloco :global(svg) { flex-shrink: 0; width: 18px; height: 18px; }
  /* Marca de "deste projeto": ponto no canto, na cor de destaque apagada. */
  .acao-projeto {
    position: absolute; top: 5px; right: 5px; width: 6px; height: 6px;
    border-radius: var(--radius-full); background: var(--accent); opacity: 0.7;
  }
  .acoes-erro {
    margin: 0; font-size: var(--text-xs); color: var(--text-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Duas linhas antes de cortar: rótulo curto demais escondia o que o atalho faz. */
  .acao-rotulo {
    max-width: 100%; font-size: 11px; font-weight: 600; line-height: 1.25; text-align: center;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }
</style>
