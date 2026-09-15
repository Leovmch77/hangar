<script lang="ts">
  // Controles de arranjo de um bloco do desktop (coluna de git, painel de contexto): o punho de
  // arrastar e o botão de voltar ao padrão. A conversa não tem controles próprios — ela ocupa o
  // que sobra, e mexer nos dois blocos ao redor dela alcança todos os arranjos.
  import * as m from '../paraglide/messages';
  import { shellLayout, type BlocoShell } from '../lib/shellLayout.svelte';
  import { arrasto, iniciarArrasto } from '../lib/arrastoBloco.svelte';

  interface Props { bloco: BlocoShell }
  let { bloco }: Props = $props();
</script>

<span class="mover">
  <!-- Punho: arrastar até a borda de outro bloco. Lateral reordena, cima/baixo empilha. `button`
       de verdade pra ter foco e rótulo; quem executa o gesto é o pointerdown. -->
  <button type="button" class="punho" class:arrastando={arrasto.bloco === bloco}
          onpointerdown={(e) => iniciarArrasto(bloco, e)}
          aria-label={m.layout_arrastar()} title={m.layout_arrastar()}>
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
      <circle cx="4" cy="2" r="1" /><circle cx="8" cy="2" r="1" />
      <circle cx="4" cy="6" r="1" /><circle cx="8" cy="6" r="1" />
      <circle cx="4" cy="10" r="1" /><circle cx="8" cy="10" r="1" />
    </svg>
  </button>
  <!-- Voltar ao padrão é tarefa PRÓPRIA, não efeito colateral de recolher o painel — e só existe
       quando há o que desfazer, senão é botão morto em toda tela. -->
  {#if shellLayout.mexido}
    <button type="button" class="voltar" onclick={() => shellLayout.restaurar()}
            aria-label={m.layout_voltar_padrao()} title={m.layout_voltar_padrao()}>⟲</button>
  {/if}
</span>

<style>
  /* Discreto no repouso: é comando de arrumação, não de trabalho — só ganha cor no hover. */
  .mover { display: flex; align-items: center; gap: 1px; }
  .mover button {
    /* O `button` global nasce com 44×44 (alvo de toque). Aqui são controles de arrumação numa
       linha de cabeçalho de 270px: nos 44 eles sozinhos empurravam o × pra fora da coluna. São de
       ponteiro fino, no desktop, e ficam do lado de botões que já usam a mesma exceção (o ⋯ da
       lista de arquivos tem 20px). */
    min-width: 0; min-height: 0; width: 20px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: 0; cursor: pointer; padding: 0;
    color: var(--text-muted); font: inherit; font-size: var(--text-sm); line-height: 1;
    border-radius: 4px;
    transition: color 120ms cubic-bezier(0.2, 0, 0, 1), background-color 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  .mover button:disabled { opacity: 0.3; cursor: default; }
  /* Um pouco menor que as setas: é saída de emergência, não comando de uso diário. */
  .voltar { font-size: var(--text-xs); }
  /* `touch-action: none` senão o navegador trata o gesto como rolagem e o pointermove morre. */
  .punho { cursor: grab; touch-action: none; }
  .punho:active, .punho.arrastando { cursor: grabbing; color: var(--accent); }
  @media (hover: hover) and (pointer: fine) {
    .mover button:not(:disabled):hover { color: var(--text-primary); background: var(--fill-subtle); }
  }
</style>
