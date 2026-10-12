import { pairExternals, type AggSession, type PairExternal } from '@hangar/core';

/** Pares de acesso completo do grupo: quem entra nele fica aberto para estes donos. */
export function fullPairs(rows: AggSession[]): PairExternal[] {
  const seen = new Map<string, PairExternal>();
  for (const r of rows) for (const p of pairExternals(r)) if (p.level === 'full') seen.set(`${p.alias}::${p.session}`, p);
  return [...seen.values()];
}

/** Membro de fora (`alias::sessao`) é aberto pela entrada do par, não pelo servidor do grupo. */
export function outsideRow(rows: AggSession[], peer: string): AggSession | null {
  return rows.find((r) => r.outside && `${r.outside.alias}::${r.name}` === peer) ?? null;
}
