<script lang="ts">
  import * as m from '../paraglide/messages';
  import IconCerebro from './icons/IconCerebro.svelte';

  // Raciocínio chegando (Claude sem terminal). Some quando o bloco cai no transcript e vira o
  // ThinkingBlock; por isso o tempo conta a partir da montagem, não de um horário do servidor.
  interface Props {
    texto: string;
  }
  let { texto }: Props = $props();

  const inicio = Date.now();
  let segundos = $state(0);
  $effect(() => {
    const t = setInterval(() => { segundos = Math.floor((Date.now() - inicio) / 1000); }, 1000);
    return () => clearInterval(t);
  });

  // Só a cauda: o CSS mostra três linhas, e o resumo inteiro no DOM a cada pedaço é trabalho à toa.
  const cauda = $derived(texto.length > 600 ? '…' + texto.slice(-600) : texto);
</script>

<div class="pv" role="status" aria-live="off">
  <div class="pv-head">
    <span class="pv-ic"><IconCerebro size={15} /></span>
    <span class="pv-rotulo">{m.pensamento_vivo()}</span>
    <span class="pv-tempo">· {segundos}s</span>
  </div>
  <div class="pv-texto">
    <div>{cauda}</div>
  </div>
</div>

<style>
  .pv { margin-bottom: var(--space-1); animation: bubble-in 200ms var(--ease-out); }

  .pv-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: var(--space-1) 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* Animação no span, nunca no svg (o Chromium repinta a página inteira com transform em svg). */
  .pv-ic {
    display: inline-flex;
    color: var(--accent);
    animation: pv-respira 1.8s ease-in-out infinite;
  }
  @keyframes pv-respira {
    0%, 100% { opacity: 0.45; }
    50%      { opacity: 1; }
  }

  /* Faixa clara passando sobre a palavra. */
  .pv-rotulo {
    background-image:
      linear-gradient(90deg, transparent calc(50% - 32px), var(--text-primary) 50%, transparent calc(50% + 32px)),
      linear-gradient(var(--text-muted), var(--text-muted));
    background-size: 250% 100%, auto;
    background-repeat: no-repeat;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: pv-brilho 1.6s linear infinite;
  }
  @keyframes pv-brilho {
    from { background-position: 100% center; }
    to   { background-position: 0% center; }
  }

  .pv-tempo { font-variant-numeric: tabular-nums; opacity: 0.8; }

  /* Três linhas presas ao fim: o texto novo entra embaixo e o antigo sai por cima, com corte
     seco — o texto já é apagado (--text-muted), degradê em cima dele só parecia defeito. */
  .pv-texto {
    margin-left: 22px;
    max-width: 62ch;
    max-height: calc(1.6em * 3);
    overflow: hidden;
    display: flex;
    flex-direction: column-reverse;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--text-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  @media (prefers-reduced-motion: reduce) {
    .pv-ic, .pv-rotulo { animation: none; }
    .pv-rotulo { background: none; color: var(--text-muted); }
  }
</style>
