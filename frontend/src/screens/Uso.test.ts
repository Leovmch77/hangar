// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { Aquecendo, zeroUso, type UsoReport } from '@hangar/core';
import { clienteQuery } from '../lib/queries';
import * as m from '../paraglide/messages';
import Uso from './Uso.svelte';

vi.mock('../components/NavBar.svelte', () => ({ default: createRawSnippet(() => ({ render: () => '<nav></nav>' })) }));
vi.mock('../lib/queries', () => ({
  uso: (server: { id: string }, period: string, conta = '') => ({ id: server.id, period, conta }),
  clienteQuery: { fetchQuery: vi.fn(), invalidateQueries: vi.fn(async () => {}) },
}));

const report = (period: string): Partial<UsoReport> => ({
  totals: { ...zeroUso('totals'), sessions: 3, chamadas: 120, ctx_chars: 4000, ctx_tokens_est: 1000, cost: 2.5 },
  by_skill: [{ ...zeroUso('orquestrar'), sessions: 2, chamadas: 5, pedidas: 2, ctx_chars: 400, ctx_tokens_est: 100, input: 10, output: 5, cost: 2 }],
  by_agente: [{ ...zeroUso('Explore'), sessions: 1, chamadas: 7, pedidas: 3, cost: 1 }],
  by_tool: Array.from({ length: 17 }, (_, i) => ({ ...zeroUso(`Tool${i}`), sessions: 1, chamadas: 17 - i })),
  by_contexto: [{ ...zeroUso('instructions'), sessions: 2, chamadas: 2, ctx_chars: 8000, ctx_tokens_est: 2000 }],
  applied: { period },
});

const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

it('mostra as seções, corta a tabela longa em 15 e preserva o período', async () => {
  localStorage.clear();
  localStorage.setItem('cp_servers', JSON.stringify([{ id: 'a', label: 'A', baseUrl: 'https://a.test', token: 't' }]));
  vi.mocked(clienteQuery.fetchQuery).mockImplementation((query) => {
    const { period } = query as unknown as { period: string };
    return Promise.resolve(report(period)) as ReturnType<typeof clienteQuery.fetchQuery>;
  });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  const button = (label: string) => [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  try {
    await settle();
    expect(target.querySelector('.overview')?.textContent).toContain('120');
    expect(target.textContent).toContain('orquestrar');
    // Quem pediu: skill 2 por barra / 3 pelo modelo; agente 3 pedidos / 4 sozinho.
    const linha = (nome: string) => [...target.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(nome))!;
    expect(linha('orquestrar').textContent?.replace(/\s+/g, ' ')).toContain('2 / 3');
    expect(linha('Explore').textContent?.replace(/\s+/g, ' ')).toContain('3 / 4');
    expect(target.textContent).toContain(m.uso_col_origem_agente());
    // 17 tools: 15 visíveis + botão de mostrar mais 2.
    expect(target.textContent).toContain(m.uso_mostrar_mais({ n: 2 }));
    expect(target.textContent).not.toContain('Tool16');
    button(m.uso_mostrar_mais({ n: 2 })).click();
    await settle();
    expect(target.textContent).toContain('Tool16');
    // Contexto: média por sessão = 2000 / 2.
    expect(target.textContent).toContain('instructions');
    expect(target.textContent).toContain('≈ 1 mil');
    button(m.custos_periodo_7d()).click();
    await settle();
    expect(button(m.custos_periodo_7d()).getAttribute('aria-pressed')).toBe('true');
    expect(target.querySelector('.warn')).toBeNull();
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
    expect(target.querySelector('.retry')).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(target.querySelector('.aquecendo')).toBeNull();
    expect(target.querySelector('.overview')?.textContent).toContain('120');
  } finally { vi.useRealTimers(); await unmount(component); target.remove(); localStorage.clear(); }
});

it('escolher uma conta refaz a busca com a conta e mantém a lista inteira no seletor', async () => {
  localStorage.clear();
  localStorage.setItem('cp_servers', JSON.stringify([{ id: 'a', label: 'A', baseUrl: 'https://a.test', token: 't' }]));
  const contas = [
    { ...zeroUso('anthropic:1'), label: 'um@x', sessions: 2, chamadas: 50 },
    { ...zeroUso('anthropic:2'), label: 'dois@x', sessions: 1, chamadas: 10 },
  ];
  const pedidos: string[] = [];
  vi.mocked(clienteQuery.fetchQuery).mockImplementation((query) => {
    const { conta } = query as unknown as { conta: string };
    pedidos.push(conta);
    return Promise.resolve({ ...report('30d'), by_conta: contas, conta: conta || null }) as ReturnType<typeof clienteQuery.fetchQuery>;
  });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  try {
    await settle();
    // O gatilho do Select é o próprio combobox; a lista de opções sai por portal no body.
    const select = target.querySelector(`button[aria-label="${m.uso_conta()}"]`) as HTMLButtonElement;
    expect(select).not.toBeNull();
    expect(select.textContent).toContain(m.custos_todas_n({ n: 2 }));
    select.click();
    await settle();
    const opcao = [...document.querySelectorAll('[role="option"]')].find((b) => b.textContent?.includes('dois@x')) as HTMLElement;
    opcao.click();
    await settle();
    expect(pedidos.at(-1)).toBe('anthropic:2');
    expect(select.textContent).toContain('dois@x');
  } finally { await unmount(component); target.remove(); localStorage.clear(); }
});

it('sem uso no período mostra o vazio, não a tabela', async () => {
  localStorage.clear();
  localStorage.setItem('cp_servers', JSON.stringify([{ id: 'a', label: 'A', baseUrl: 'https://a.test', token: 't' }]));
  vi.mocked(clienteQuery.fetchQuery).mockResolvedValue({ totals: zeroUso('totals'), applied: { period: '30d' } });
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Uso, { target, props: { onBack: vi.fn() } });
  try {
    await settle();
    expect(target.textContent).toContain(m.uso_vazio());
    expect(target.querySelector('table')).toBeNull();
  } finally { await unmount(component); target.remove(); localStorage.clear(); }
});
