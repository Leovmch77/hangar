// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { Aquecendo, zeroUso, type UsoReport } from '@hangar/core';
import { clienteQuery } from '../lib/queries';
import * as m from '../paraglide/messages';
import Uso from './Uso.svelte';

vi.mock('../components/NavBar.svelte', () => ({ default: createRawSnippet(() => ({ render: () => '<nav></nav>' })) }));
vi.mock('../lib/queries', () => ({
  uso: (server: { id: string }, period: string) => ({ id: server.id, period }),
  clienteQuery: { fetchQuery: vi.fn(), invalidateQueries: vi.fn(async () => {}) },
}));

const report = (period: string): Partial<UsoReport> => ({
  totals: { ...zeroUso('totals'), sessions: 3, chamadas: 120, ctx_chars: 4000, ctx_tokens_est: 1000, cost: 2.5 },
  by_skill: [{ ...zeroUso('orquestrar'), sessions: 2, chamadas: 5, ctx_chars: 400, ctx_tokens_est: 100, input: 10, output: 5, cost: 2 }],
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
