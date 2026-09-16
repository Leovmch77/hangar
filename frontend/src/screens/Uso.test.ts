// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { Aquecendo, zeroUso, type UsoReport } from '@hangar/core';
import { clienteQuery } from '../lib/queries';
import * as m from '../paraglide/messages';
import Uso from './Uso.svelte';

vi.mock('../components/NavBar.svelte', () => ({ default: createRawSnippet(() => ({ render: () => '<nav></nav>' })) }));
vi.mock('../lib/queries', () => ({
  uso: (server: { id: string }, period: string, filtros: Record<string, string> = {}) => ({ id: server.id, period, conta: '', ...filtros }),
  clienteQuery: { fetchQuery: vi.fn(), invalidateQueries: vi.fn(async () => {}) },
}));

const report = (period: string): Partial<UsoReport> => ({
  totals: { ...zeroUso('totals'), sessions: 3, chamadas: 120, ctx_chars: 4000, ctx_tokens_est: 1000, cost: 130 },
  // Skills pesam pelo CONTEXTO injetado: "muitas" injeta mais no total; "pesada" injeta mais por
  // chamada (15 × a mediana). `cost` aqui é o custo do turno, secundário.
  by_skill: [
    { ...zeroUso('muitas'), sessions: 2, chamadas: 10, pedidas: 2, ctx_tokens_est: 10000, cost: 100 },
    { ...zeroUso('pesada'), sessions: 1, chamadas: 3, ctx_tokens_est: 4500, cost: 45 },
    ...Array.from({ length: 20 }, (_, i) => ({ ...zeroUso(`s${String(i).padStart(2, '0')}`), sessions: 1, chamadas: 5, ctx_tokens_est: 500, cost: 1 })),
  ],
  by_agente: [{ ...zeroUso('Explore'), sessions: 1, chamadas: 7, pedidas: 3, cost: 21 }],
  by_tool: [{ ...zeroUso('Bash'), sessions: 3, chamadas: 100, ctx_chars: 4000, ctx_tokens_est: 1000 }],
  by_contexto: [{ ...zeroUso('instructions'), sessions: 2, chamadas: 2, ctx_chars: 8000, ctx_tokens_est: 2000 }],
  by_day: [{ ...zeroUso('2026-09-10'), chamadas: 120, cost: 130 }],
  by_conta: [{ ...zeroUso('anthropic:1'), label: 'um@x', sessions: 2, chamadas: 50 }, { ...zeroUso('anthropic:2'), label: 'dois@x', sessions: 1, chamadas: 10 }],
  applied: { period },
});
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const servidor = () => localStorage.setItem('cp_servers', JSON.stringify([{ id: 'a', label: 'A', baseUrl: 'https://a.test', token: 't' }]));

it('monta o painel: números, bolhas, por dia, contexto e a tabela com abas ordenada por custo', async () => {
  localStorage.clear(); servidor();
  vi.mocked(clienteQuery.fetchQuery).mockImplementation((query) => {
    const { period } = query as unknown as { period: string };
    return Promise.resolve(report(period)) as ReturnType<typeof clienteQuery.fetchQuery>;
  });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  const nomes = () => [...target.querySelectorAll('table.data tr.click td.nome')].map((td) => td.textContent?.trim());
  try {
    await settle();
    expect(target.querySelector('.numeros')?.textContent).toContain('120');
    expect(target.querySelectorAll('.hero circle.bolha')).toHaveLength(22);   // modo skills: 22 skills com contexto
    ([...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === m.uso_modo_agentes()) as HTMLButtonElement).click();
    await settle();
    expect(target.querySelectorAll('.hero circle.bolha')).toHaveLength(1);    // modo agentes: só o Explore
    expect(target.querySelectorAll('.duplo svg')).toHaveLength(2);
    expect(target.querySelector('.pilha')).not.toBeNull();
    expect(nomes().slice(0, 2)).toEqual(['muitas', 'pesada']);                // contexto total, decrescente
    // "pesada" está fora da curva por chamada: leva a marca. O custo do turno aparece, mas apagado.
    const linhaPesada = [...target.querySelectorAll('tr.click')].find((tr) => tr.textContent?.includes('pesada'))!;
    expect(linhaPesada.querySelector('.marca')).not.toBeNull();
    expect(target.querySelector('thead')?.textContent).toContain(m.uso_col_custo_turno());
    // 22 skills: 20 visíveis + mostrar mais 2.
    expect(target.textContent).toContain(m.uso_mostrar_mais({ n: 2 }));
    // Cabeçalho reordena por contexto/chamada.
    ([...target.querySelectorAll('th .th')].find((b) => b.textContent?.includes(m.uso_col_ctx_chamada())) as HTMLButtonElement).click();
    await settle();
    expect(nomes()[0]).toBe('pesada');
    // Aba de tools: coluna de contexto no lugar de custo.
    ([...target.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes(m.uso_aba_tools())) as HTMLButtonElement).click();
    await settle();
    expect(nomes()).toEqual(['Bash']);
    expect(target.querySelector('thead')?.textContent).toContain(m.uso_col_ctx());
  } finally { await unmount(component); target.remove(); localStorage.clear(); }
});

it('clicar numa linha abre o detalhe com série própria (foco) sem refazer o relatório principal', async () => {
  localStorage.clear(); servidor();
  const pedidos: Record<string, string>[] = [];
  vi.mocked(clienteQuery.fetchQuery).mockImplementation((query) => {
    const q = query as unknown as Record<string, string>;
    pedidos.push(q);
    return Promise.resolve(q.foco
      ? { by_day: [{ ...zeroUso('2026-09-10'), chamadas: 3, cost: 45 }], applied: { period: q.period } }
      : report(q.period)) as ReturnType<typeof clienteQuery.fetchQuery>;
  });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  try {
    await settle();
    const principais = pedidos.filter((p) => !p.foco).length;
    ([...target.querySelectorAll('tr.click')].find((tr) => tr.textContent?.includes('pesada')) as HTMLElement).click();
    await settle();
    expect(pedidos.filter((p) => !p.foco).length).toBe(principais);          // relatório principal intocado
    expect(pedidos.at(-1)?.foco).toBe('pesada');
    const det = target.querySelector('.detalhe')!;
    expect(det.textContent).toContain('pesada');
    expect(det.textContent).toContain(m.uso_col_custo_turno());               // rotulado como turno, não custo da skill
    expect(det.querySelector('svg.serie')).not.toBeNull();
    // Números da tela continuam lá (nada foi apagado durante o detalhe).
    expect(target.querySelector('.numeros')?.textContent).toContain('120');
    (det.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector('.detalhe')).toBeNull();
  } finally { await unmount(component); target.remove(); localStorage.clear(); }
});

it('trocar filtro de conta refaz a busca com a conta e mantém o painel montado enquanto atualiza', async () => {
  localStorage.clear(); servidor();
  const pedidos: string[][] = [];
  let soltar!: () => void;
  vi.mocked(clienteQuery.fetchQuery).mockImplementation((query) => {
    const { conta, period } = query as unknown as { conta: string[] | string; period: string };
    const lista = Array.isArray(conta) ? conta : [];
    pedidos.push(lista);
    if (lista.length) return new Promise((r) => { soltar = () => r(report(period)); }) as ReturnType<typeof clienteQuery.fetchQuery>;
    return Promise.resolve(report(period)) as ReturnType<typeof clienteQuery.fetchQuery>;
  });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  try {
    await settle();
    const select = target.querySelector(`button[aria-label="${m.uso_conta()}"]`) as HTMLButtonElement;
    select.click();
    await settle();
    const opcao = (t: string) => [...document.querySelectorAll('[role="option"]')].find((b) => b.textContent?.includes(t)) as HTMLElement;
    opcao('dois@x').click();
    await settle();
    expect(pedidos.at(-1)).toEqual(['anthropic:2']);
    // Múltipla escolha: a lista continua aberta e a segunda marcação SOMA à primeira.
    expect(document.querySelector('.sel-lista')).not.toBeNull();
    opcao('um@x').click();
    await settle();
    expect(pedidos.at(-1)).toEqual(['anthropic:2', 'anthropic:1']);
    expect(select.textContent).toContain(m.uso_filtro_conta({ v: m.uso_n_de_m({ n: 2, m: 2 }) }));
    expect(target.textContent).toContain(m.uso_atualizando());
    expect(target.querySelector('.numeros')).not.toBeNull();                  // painel continua montado
    expect(target.querySelector('.esqueleto')).toBeNull();
    soltar();
    await settle();
    expect(target.textContent).not.toContain(m.uso_atualizando());
  } finally { await unmount(component); target.remove(); localStorage.clear(); }
});

it('202 "aquecendo" mostra o progresso e repergunta até o dado chegar', async () => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('cp_servers', JSON.stringify([{ id: 'novo', label: 'Novo', baseUrl: 'https://novo.test', token: 't' }]));
  let chamadas = 0;
  vi.mocked(clienteQuery.fetchQuery).mockImplementation(() => {
    chamadas += 1;
    if (chamadas < 2) return Promise.reject(new Aquecendo(50, 200));
    return Promise.resolve(report('30d')) as ReturnType<typeof clienteQuery.fetchQuery>;
  });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  try {
    await settle();
    expect(target.textContent).toContain(m.custos_aquecendo_progresso({ maquina: 'Novo', lidos: 50, total: 200 }));
    expect(target.querySelector('.esqueleto')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(target.querySelector('.aquecendo')).toBeNull();
    expect(target.querySelector('.numeros')?.textContent).toContain('120');
  } finally { vi.useRealTimers(); await unmount(component); target.remove(); localStorage.clear(); }
});

it('onde vai o dinheiro: pilha por área em ordem fixa, série por dia e aba de áreas por custo', async () => {
  localStorage.clear(); servidor();
  vi.mocked(clienteQuery.fetchQuery).mockImplementation((query) => {
    const { period } = query as unknown as { period: string };
    return Promise.resolve({
      ...report(period),
      by_area: [
        { ...zeroUso('back'), chamadas: 20, cost: 60 },
        { ...zeroUso('conversa'), cost: 10 },
        { ...zeroUso('front'), chamadas: 9, cost: 30 },
      ],
      by_area_dia: [
        { ...zeroUso('2026-09-09|back'), label: 'back', cost: 40 },
        { ...zeroUso('2026-09-10|back'), label: 'back', cost: 20 },
        { ...zeroUso('2026-09-10|front'), label: 'front', cost: 30 },
        { ...zeroUso('2026-09-10|conversa'), label: 'conversa', cost: 10 },
      ],
    }) as ReturnType<typeof clienteQuery.fetchQuery>;
  });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  try {
    await settle();
    const bloco = target.querySelector('.areas')!;
    // Ordem fixa por área (front, back, …, conversa), não por valor: a cor segue a área.
    expect([...bloco.querySelectorAll('.legenda .lab')].map((e) => e.textContent)).toEqual(
      [m.uso_area_front(), m.uso_area_back(), m.uso_area_conversa()]);
    expect(bloco.querySelectorAll('.pilha .seg-pilha')).toHaveLength(3);
    expect(bloco.textContent).toContain('60%');
    // Dia 09: um segmento; dia 10: três.
    expect(bloco.querySelectorAll('svg rect[rx="2"]')).toHaveLength(4);
    ([...target.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes(m.uso_aba_areas())) as HTMLButtonElement).click();
    await settle();
    expect([...target.querySelectorAll('table.data tr.click td.nome')].map((td) => td.textContent?.trim()))
      .toEqual([m.uso_area_back(), m.uso_area_front(), m.uso_area_conversa()]);
    expect(target.querySelector('thead')?.textContent).toContain(m.uso_col_custo());
  } finally { await unmount(component); target.remove(); localStorage.clear(); }
});

it('sem uso no período mostra o vazio, não o painel', async () => {
  localStorage.clear(); servidor();
  vi.mocked(clienteQuery.fetchQuery).mockResolvedValue({ totals: zeroUso('totals'), applied: { period: '30d' } });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  try {
    await settle();
    expect(target.textContent).toContain(m.uso_vazio());
    expect(target.querySelector('table')).toBeNull();
  } finally { await unmount(component); target.remove(); localStorage.clear(); }
});
