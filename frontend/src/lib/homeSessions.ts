import type { AggSession } from '@hangar/core';

export type HomeState = 'awaiting_input' | 'working' | 'idle';
export interface HomeGroup { state: HomeState; total: number; sessions: AggSession[] }

const ORDER: HomeState[] = ['awaiting_input', 'working', 'idle'];

// ponytail: linhas de par externo (`outside`) ficam só na lista completa.
export function groupHomeSessions(rows: AggSession[], readyExpanded: boolean): HomeGroup[] {
  return ORDER.flatMap((state) => {
    const all = rows.filter((r) => r.state === state && !r.outside);
    if (!all.length) return [];
    // Prontas: a que terminou por último aparece primeiro, e é a que fica à vista recolhida.
    if (state === 'idle') all.sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0));
    return [{ state, total: all.length, sessions: state === 'idle' && !readyExpanded ? all.slice(0, 1) : all }];
  });
}
