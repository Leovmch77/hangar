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
  totals: { ...zeroUso('totals'), sessions: 3, subagentes: 2, chamadas: 120, ctx_chars: 4000, ctx_tokens_est: 1000, input: 1_000_000 },
  by_mcp: [{ ...zeroUso('hangar'), sessions: 1, chamadas: 4 }],
  // Skills pesam pelos tokens que OCUPARAM: "muitas" ocupa mais no total; "pesada" é maior por
  // carga (15 × a mediana).
  by_skill: [
    { ...zeroUso('muitas'), sessions: 2, chamadas: 10, pedidas: 2, ctx_tokens_est: 10000, ocupados_tokens_est: 100000, respostas: 40 },
    { ...zeroUso('pesada'), sessions: 1, chamadas: 3, ctx_tokens_est: 4500, ocupados_tokens_est: 45000, respostas: 10 },
    ...Array.from({ length: 20 }, (_, i) => ({ ...zeroUso(`s${String(i).padStart(2, '0')}`), sessions: 1, chamadas: 5, ctx_tokens_est: 500, ocupados_tokens_est: 500, respostas: 1 })),
  ],
  by_agente: [{ ...zeroUso('Explore'), sessions: 1, chamadas: 7, pedidas: 3, input: 21000 }],
  by_tool: [{ ...zeroUso('Bash'), sessions: 3, chamadas: 100, ctx_chars: 4000, ctx_tokens_est: 1000 },
            { ...zeroUso('Skill'), sessions: 1, chamadas: 50 }],
  by_contexto: [{ ...zeroUso('instructions'), sessions: 2, chamadas: 2, ctx_chars: 8000, ctx_tokens_est: 2000 }],
  by_day: [{ ...zeroUso('2026-09-10'), chamadas: 120, input:130 }],
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
    // Topo: só skills e tools — 88 cargas de 22 skills, ferramentas sem contar Skill/Agent (100 do Bash).
    const numeros = target.querySelector('.numeros')!;
    expect(numeros.querySelectorAll(':scope > div')).toHaveLength(4);
    expect(numeros.textContent).toContain(m.uso_kpi_skills_distintas({ n: '22' }));
    expect(numeros.textContent).toContain(m.uso_kpi_mais_usada({ nome: 'Bash', pct: '100' }));
    // Rankings: skills (8 + "outros (14)"), ferramentas, agentes, MCP; área e projeto não moram aqui.
    const [skills, ferramentas, agentes, mcp] = [...target.querySelectorAll('ol.rank')];    expect(skills.querySelectorAll('li')).toHaveLength(9);
    expect(skills.textContent).toContain(m.uso_outros_itens({ n: 14 }));
    expect([...ferramentas.querySelectorAll('li')].map((li) => li.querySelector('.rank-nome')?.textContent)).toEqual(['Bash']);
    expect(agentes.textContent).toContain('Explore');
    expect(mcp.textContent).toContain('hangar');
    expect(target.textContent).not.toContain(m.uso_graf_areas());
    // Clicar numa skill do ranking abre o detalhe dela.
    (skills.querySelector('button.rank-nome') as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector('.detalhe')?.textContent).toContain('muitas');
    (target.querySelector('.detalhe button') as HTMLButtonElement).click();
    await settle();
    expect(nomes().slice(0, 2)).toEqual(['muitas', 'pesada']);                // tokens ocupados, decrescente
    // "pesada" está fora da curva por carga: leva a marca. Skill mostra cargas e respostas, não custo.
    const linhaPesada = [...target.querySelectorAll('tr.click')].find((tr) => tr.textContent?.includes('pesada'))!;
    expect(linhaPesada.querySelector('.marca')).not.toBeNull();
    expect(target.querySelector('thead')?.textContent).toContain(m.uso_col_respostas());
    expect(target.querySelector('thead')?.textContent).toContain(m.uso_col_cargas());
    expect(target.textContent).not.toContain('R$');
    // 22 skills: 20 visíveis + mostrar mais 2.
    expect(target.textContent).toContain(m.uso_mostrar_mais({ n: 2 }));
    // Cabeçalho reordena por tamanho da carga.
    ([...target.querySelectorAll('th .th')].find((b) => b.textContent?.includes(m.uso_col_tamanho())) as HTMLButtonElement).click();
    await settle();
    expect(nomes()[0]).toBe('pesada');
    // Aba de tools: coluna de contexto no lugar de custo.
    ([...target.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes(m.uso_aba_tools())) as HTMLButtonElement).click();
    await settle();
    expect(nomes()).toEqual(['Bash', 'Skill']);                               // a aba mostra a tool crua
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
      ? { by_day: [{ ...zeroUso('2026-09-10'), chamadas: 3, input:45 }], applied: { period: q.period } }
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
    expect(det.textContent).toContain(m.uso_col_ocupados());                  // skill pesa pelo que ocupou
    expect(det.querySelector('svg.serie')).not.toBeNull();
    // Números da tela continuam lá (nada foi apagado durante o detalhe).
    expect(target.querySelector('.numeros')?.textContent).toContain(m.uso_kpi_cargas_skills());
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
    expect(target.querySelector('.numeros')?.textContent).toContain(m.uso_kpi_cargas_skills());
  } finally { vi.useRealTimers(); await unmount(component); target.remove(); localStorage.clear(); }
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
