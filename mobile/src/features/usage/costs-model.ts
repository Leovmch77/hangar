import { custoDesconhecido, isFree, type ComboLocal, type DimBucket, type RelatorioMesclado } from '@hangar/core';

export const dimensions = ['provider', 'source', 'project', 'model', 'servidor'] as const;
export type Dimension = typeof dimensions[number];
export type CostFilter = Partial<Record<Dimension, string[]>> & { sub?: boolean };
export const rawTokens = (b: { input: number; output: number; cache_write: number; cache_read: number }) => b.input + b.output + b.cache_write + b.cache_read;
const fields = ['input', 'output', 'cache_write', 'cache_read', 'cost', 'cost_input', 'cost_output', 'cost_cache_write', 'cost_cache_read', 'cache_write_1h', 'regravado', 'custo_regravado'] as const;
const zero = (key: string): DimBucket => ({ key, sessions: 0, input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0, cost_input: 0, cost_output: 0, cost_cache_write: 0, cost_cache_read: 0 });

// Sem combinações, os totais por dimensão não permitem cruzamentos.
export function setCostFilter(filter: CostFilter, dim: Dimension, values: string[], cross: boolean): CostFilter {
  const next = cross ? { ...filter } : {};
  if (values.length) next[dim] = cross ? values : values.slice(0, 1);
  else delete next[dim];
  return next;
}
export function filterCombos(rows: ComboLocal[], filter: CostFilter): ComboLocal[] {
  return rows.filter((row) => dimensions.every((dim) => !filter[dim]?.length || filter[dim]!.includes(row[dim]))
    && (filter.sub === undefined || row.subagente === filter.sub));
}
export function sumCombos(rows: ComboLocal[]): DimBucket {
  const total = zero('totals');
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.session_ids) {
      for (const id of row.session_ids) {
        const key = JSON.stringify([row.servidor, id]);
        if (!seen.has(key)) { seen.add(key); total.sessions++; }
      }
    } else total.sessions += row.sessions;
    for (const field of fields) total[field] = (total[field] ?? 0) + (row[field] ?? 0);
  }
  return total;
}
export function groupCombos(rows: ComboLocal[], field: Dimension | 'dia'): DimBucket[] {
  const groups = new Map<string, ComboLocal[]>();
  for (const row of rows) {
    const list = groups.get(row[field]);
    if (list) list.push(row); else groups.set(row[field], [row]);
  }
  return [...groups].map(([key, list]) => ({ ...sumCombos(list), key }))
    .sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
}
export function dimensionBuckets(report: RelatorioMesclado, dim: Dimension): DimBucket[] {
  return { provider: report.by_provider, source: report.by_source, project: report.by_project, model: report.by_model, servidor: report.by_servidor }[dim];
}
export function costView(report: RelatorioMesclado, filter: CostFilter) {
  const cross = report.combos.length > 0;
  const rows = filterCombos(report.combos, filter);
  const dim = dimensions.find((d) => filter[d]?.length);
  const total = cross ? sumCombos(rows) : dim ? dimensionBuckets(report, dim).find((b) => b.key === filter[dim]![0]) ?? zero('totals') : report.totals;
  const groups = Object.fromEntries(dimensions.map((d) => [d, cross ? groupCombos(rows, d) : dimensionBuckets(report, d)])) as Record<Dimension, DimBucket[]>;
  return { total, groups, rows, cross, days: cross ? groupCombos(rows, 'dia').sort((a, b) => b.key.localeCompare(a.key)) : report.by_day };
}
export function comparison(report: RelatorioMesclado, filter: CostFilter, dim: Dimension, keys: string[]) {
  const rest = { ...filter };
  delete rest[dim];
  return [...new Set(keys)].slice(0, 4).map((key) => {
    const view = costView(report, { ...rest, [dim]: [key] });
    return { key, total: report.combos.length ? view.total : dimensionBuckets(report, dim).find((b) => b.key === key) ?? zero(key), days: report.combos.length ? view.days : [] };
  });
}
export function priceLabel(bucket: Pick<DimBucket, 'input' | 'output' | 'cache_write' | 'cache_read' | 'cost'>, model?: string): 'unknown' | 'free' | 'priced' {
  return custoDesconhecido({ ...zero(''), ...bucket }) ? model && isFree(model) ? 'free' : 'unknown' : 'priced';
}
