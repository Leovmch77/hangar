import { describe, expect, it } from 'vitest';
import { mergeReports, type ComboRow } from '@hangar/core';
import { comparison, costView, filterCombos, priceLabel, setCostFilter, sumCombos } from './costs-model';

const combo = (patch: Partial<ComboRow> = {}): ComboRow => ({ dia: '2026-10-01', provider: 'a', source: 'claude', project: '/one', model: 'known', subagente: false, sessions: 1, session_ids: ['same-id'], input: 100, output: 20, cache_write: 0, cache_read: 10, cost: 2, cost_input: 1, cost_output: 1, cost_cache_write: 0, cost_cache_read: 0, ...patch });
const report = () => mergeReports([
  { id: 'one', report: { applied: { period: '30d' }, totals: { ...sumCombos([]), sessions: 2, cost: 6 }, combos: [combo(), combo({ dia: '2026-10-02' }), combo({ provider: 'b', source: 'codex', project: '/two', session_ids: ['other'], subagente: true })] } },
  { id: 'two', report: { applied: { period: '30d' }, totals: { ...sumCombos([]), sessions: 1, cost: 2 }, combos: [combo()] } },
], '30d').report;

describe('recortes de custos mobile', () => {
  it('cruza dimensões com OR interno e conta ids por máquina, não por dia', () => {
    const r = report();
    const rows = filterCombos(r.combos, { provider: ['a', 'b'], source: ['claude'], project: ['/one'], sub: false });
    expect(rows).toHaveLength(3);
    expect(sumCombos(rows)).toMatchObject({ sessions: 2, input: 300, cost: 6 });
    expect(costView(r, { source: ['codex'], sub: true }).total).toMatchObject({ sessions: 1, cost: 2 });
    expect(costView(r, { source: ['codex'], project: ['/one'] }).total.cost).toBe(0);
  });
  it('sem combos permite só um valor e mantém painéis no período inteiro', () => {
    const r = { ...report(), combos: [], by_provider: [{ ...sumCombos([]), key: 'a', cost: 3 }], by_day: [{ ...sumCombos([]), key: '2026-10-01', cost: 8 }] };
    const f = setCostFilter({ source: ['claude'], sub: true }, 'provider', ['a', 'b'], false);
    expect(f).toEqual({ provider: ['a'] });
    expect(costView(r, f)).toMatchObject({ total: { cost: 3 }, days: r.by_day, cross: false });
  });
  it('comparação ignora seu próprio filtro mas conserva os demais e não passa de quatro', () => {
    const r = report();
    const c = comparison(r, { provider: ['a'], source: ['codex'] }, 'provider', ['b', 'a', 'c', 'd', 'e']);
    expect(c).toHaveLength(4);
    expect(c[0].total.cost).toBe(2);
    expect(c[0].days[0].key).toBe('2026-10-01');
    expect(c[1].total.cost).toBe(0);
  });
  it('volume sem tarifa é desconhecido, não zero grátis', () => {
    const b = { ...sumCombos([]), input: 42 };
    expect(priceLabel(b, 'missing')).toBe('unknown');
    expect(priceLabel(b, 'kimi-free:high')).toBe('free');
    expect(priceLabel({ ...b, cost: 1 }, 'known')).toBe('priced');
  });
});
