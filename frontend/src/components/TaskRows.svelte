<script lang="ts">
  // Lista de tarefas do agente como bloco de progresso: cabeçalho com o que falta e um anel que
  // enche, passos concluídos riscados, o atual numa pílula com o círculo girando.
  //
  // A lista não vem pronta de nenhum evento: o TaskCreate/TaskUpdate é incremental e o id nasce no
  // texto do resultado — quem reconstrói é o `foldTasks` (lib/tasks.ts, com teste). Aqui é só
  // desenho.
  import type { Task } from '@hangar/core';
  import * as m from '../paraglide/messages';
  interface Props {
    tasks: Task[];
    /** false = histórico remontado (paginação): entra parado, sem escalonar a animação. */
    animate?: boolean;
  }
  let { tasks, animate = true }: Props = $props();

  let minimizado = $state(false);
  // Toque num passo abre a descrição dele; várias podem ficar abertas.
  let abertas = $state<Record<string, boolean>>({});
  const chave = (t: Task, i: number) => t.id || `novo-${i}`;

  const feitas = $derived(tasks.filter((t) => t.status === 'completed').length);
  const faltam = $derived(tasks.length - feitas);
  const rotulo = $derived(
    faltam === 0 ? m.tasks_tudo_pronto() : faltam === 1 ? m.tasks_falta_1() : m.tasks_faltam({ n: faltam }),
  );
  // Circunferência do anel de r=6: o traço que falta encolhe conforme os passos fecham.
  const CIRC = 2 * Math.PI * 6;
  const offset = $derived(tasks.length ? CIRC * (1 - feitas / tasks.length) : CIRC);
</script>

<div class="tp" class:min={minimizado}>
  <div class="tp-head">
    <svg class="tp-anel" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" class="tp-anel-fundo" />
      <circle cx="8" cy="8" r="6" class="tp-anel-frente" stroke-dasharray={CIRC} stroke-dashoffset={offset}
              transform="rotate(-90 8 8)" />
    </svg>
    <span class="tp-rotulo">{rotulo}</span>
    <button type="button" class="tp-min" aria-expanded={!minimizado}
            aria-label={minimizado ? m.tasks_expandir() : m.tasks_minimizar()}
            onclick={() => (minimizado = !minimizado)}><i></i></button>
  </div>

  <div class="tp-wrap" style:grid-template-rows={minimizado ? '0fr' : '1fr'}>
    <div class="tp-clip">
      {#each tasks as t, i (chave(t, i))}
        {@const k = chave(t, i)}
        {@const aberta = !!abertas[k]}
        <div
          class="tp-passo"
          class:feito={t.status === 'completed'}
          class:atual={t.status === 'in_progress'}
          class:noanim={!animate}
          style:animation-delay={animate ? `${i * 70}ms` : undefined}
        >
          <button type="button" class="tp-btn" aria-expanded={aberta} onclick={() => (abertas[k] = !aberta)}>
            <span class="tp-marca" aria-label={t.status === 'completed' ? m.tasks_concluida() : undefined}></span>
            <span class="tp-titulo">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}</span>
          </button>
          {#if aberta}
            <div class="tp-detalhe">{t.description || m.tasks_sem_descricao()}</div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  /* Superfície pelos tokens: com papel de parede o bloco acompanha a Transparência. */
  .tp {
    max-width: 380px;
    margin: var(--space-2) 0;
    padding: 8px 8px 6px;
    border-radius: 14px;
    background: var(--surface-raised);
    box-shadow: 0 0 0 1px var(--border-subtle), 0 1px 2px rgba(0, 0, 0, 0.18);
  }

  .tp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px 6px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .tp.min .tp-head { padding-bottom: 2px; }
  .tp-anel { flex-shrink: 0; }
  .tp-anel circle { fill: none; stroke-width: 2.5; }
  .tp-anel-fundo { stroke: var(--border-default); }
  .tp-anel-frente { stroke: var(--text-primary); stroke-linecap: round; transition: stroke-dashoffset 600ms var(--ease-out); }
  .tp-rotulo { min-width: 0; flex: 1; font-variant-numeric: tabular-nums; }

  /* O global dá 44px a todo botão; aqui o desenho é 20px e a área de toque cresce pelo ::before. */
  .tp-min {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: var(--fill-subtle);
    cursor: pointer;
  }
  .tp-min::before { content: ''; position: absolute; inset: -12px; }
  .tp-min i { width: 8px; height: 1.5px; background: var(--text-secondary); }
  .tp-min:hover { background: var(--border-subtle); }

  .tp-wrap { display: grid; transition: grid-template-rows 300ms var(--ease-out); }
  .tp-clip { min-height: 0; overflow: hidden; }

  .tp-passo {
    margin: 2px 0;
    border: 1px solid transparent;
    border-radius: 16px;
    animation: fade-up 350ms var(--ease-out) both;
    transition: background-color 250ms var(--ease-out), border-color 250ms var(--ease-out);
  }
  .tp-passo.noanim { animation: none; }
  .tp-passo.atual { background: var(--fill-subtle); border-color: var(--border-default); }

  .tp-btn {
    display: flex;
    align-items: center;
    justify-content: flex-start;   /* o app tem button { justify-content: center } global */
    gap: 8px;
    width: 100%;
    min-width: 0;
    min-height: 30px;
    padding: 0 9px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .tp-marca {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px dashed var(--border-default);
  }
  .feito .tp-marca { border: none; background: var(--fill-subtle); box-shadow: inset 0 0 0 1px var(--border-default); }
  .feito .tp-marca::after {
    content: '';
    width: 5px;
    height: 3px;
    border-left: 1.5px solid var(--text-primary);
    border-bottom: 1.5px solid var(--text-primary);
    transform: translateY(-1px) rotate(-45deg);
  }
  .atual .tp-marca { border: 1.5px solid var(--border-default); border-top-color: var(--accent); animation: spin 0.9s linear infinite; }

  .tp-titulo {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .feito .tp-titulo { color: var(--text-muted); text-decoration: line-through; text-decoration-color: var(--border-default); }
  .atual .tp-titulo { color: var(--text-primary); }

  .tp-detalhe {
    padding: 0 12px 8px 31px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text-secondary);
    animation: fade-up 220ms var(--ease-out) both;
  }

  @media (prefers-reduced-motion: reduce) {
    .tp-passo, .atual .tp-marca, .tp-detalhe { animation: none; }
  }
</style>
