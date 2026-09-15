<script lang="ts">
  import AskQuestionStepper from './AskQuestionStepper.svelte';
  import * as m from '../paraglide/messages';
  import type { AskQuestionPayload, AnswerItem } from '@hangar/core';

  // Container desktop: card inline no fluxo do chat (sem backdrop/modal) — o contexto acima
  // (mensagem/tabela do assistente) fica visível enquanto se escolhe. Roda o mesmo stepper do sheet.
  interface Props {
    open: boolean;
    payload: AskQuestionPayload | null;
    onSubmit: (answers: AnswerItem[]) => Promise<void>;
    onClose: () => void;
    /** Repassado ao stepper: ver a prop lá. */
    escapes?: boolean;
  }
  let { open, payload, onSubmit, onClose, escapes = true }: Props = $props();
</script>

{#if open}
  <div class="ask-card" role="group" aria-label={m.ask_perguntas()}>
    {#if escapes}
      <div class="ask-status">
        <span class="ask-glyph" aria-hidden="true">?</span>
        <span class="ask-status-label">{m.board_precisa_de_voce()}</span>
        <span class="ask-status-badge">{m.estado_aguardando()}</span>
      </div>
    {/if}
    <AskQuestionStepper {open} {payload} {onSubmit} {onClose} {escapes} />
  </div>
{/if}

<style>
  .ask-card {
    align-self: stretch;
    max-width: 640px;
    margin: var(--space-2) 0;
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5);
    box-shadow: var(--elev-1, 0 1px 2px rgba(0,0,0,.18));
    container-type: inline-size;
    animation: card-in 220ms var(--ease-out) both;
  }

  .ask-status { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
  .ask-glyph {
    display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--radius-full);
    background: var(--fill-subtle); color: var(--accent); font-size: var(--text-xs); font-weight: 700;
  }
  .ask-status-label { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 600; }
  .ask-status-badge {
    margin-left: auto; padding: 2px 8px; border-radius: var(--radius-full);
    background: var(--pill-input-bg); color: var(--pill-input-fg);
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  }

  @keyframes card-in {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>
