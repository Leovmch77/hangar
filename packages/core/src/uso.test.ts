import { describe, expect, it } from 'vitest';
import { mergeUso, zeroUso, type UsoBucket } from './uso';

const b = (key: string, extra: Partial<UsoBucket> = {}): UsoBucket => ({
  ...zeroUso(key), sessions: 1, chamadas: 10, ctx_chars: 400, ctx_tokens_est: 100, cost: 1, ...extra,
});

describe('mergeUso', () => {
  it('soma por chave entre máquinas e carimba o corte por servidor', () => {
    const m = mergeUso([
      { id: 'a', label: 'A', report: { totals: b('totals'), by_skill: [b('orquestrar', { plugin: '' })], by_tool: [b('Bash')], applied: { period: '30d' } } },
      { id: 'b', label: 'B', report: { totals: b('totals', { cost: 3 }), by_skill: [b('orquestrar'), b('ecc:x', { plugin: 'ecc' })], applied: { period: '30d' }, usd_brl: 5 } },
    ], '30d');
    expect(m.partial).toBe(false);
    expect(m.report.totals.chamadas).toBe(20);
    expect(m.report.totals.cost).toBe(4);
    expect(m.report.by_skill.map((x) => [x.key, x.chamadas, x.plugin])).toEqual([['orquestrar', 20, ''], ['ecc:x', 10, 'ecc']]);
    expect(m.report.by_tool).toHaveLength(1);
    expect(m.report.by_servidor.map((x) => [x.key, x.label, x.cost])).toEqual([['b', 'B', 3], ['a', 'A', 1]]);
    expect(m.report.usd_brl).toBe(5);
  });

  it('servidor antigo sem campo não vira NaN; sem eco do período fica fora da soma; offline é failed', () => {
    const m = mergeUso([
      { label: 'Nova', report: { totals: { key: 'totals', chamadas: 5 } as UsoBucket, by_mcp: [{ key: 'hangar' } as UsoBucket], applied: { period: '7d' } } },
      { label: 'Velha', report: { totals: b('totals') } },
      { label: 'Fora', report: null },
    ], '7d');
    expect(m.partial).toBe(true);
    expect(m.mismatched).toEqual(['Velha']);
    expect(m.failed).toEqual(['Fora']);
    expect(m.report.totals.chamadas).toBe(5);
    expect(Number.isNaN(m.report.totals.ctx_chars)).toBe(false);
    expect(m.report.by_mcp[0].ctx_tokens_est).toBe(0);
  });
});
