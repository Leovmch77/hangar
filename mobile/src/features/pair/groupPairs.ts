import type { AggSession } from '@hangar/core';

/** Membro de fora (`alias::sessao`) é aberto pela entrada do par, não pelo servidor do grupo. */
export function outsideRow(rows: AggSession[], peer: string): AggSession | null {
  return rows.find((r) => r.outside && `${r.outside.alias}::${r.name}` === peer) ?? null;
}
