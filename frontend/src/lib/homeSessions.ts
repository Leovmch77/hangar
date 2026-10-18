import { grupoDaSessao, type AggSession, type GrupoSessoes } from '@hangar/core';

export type HomeState = 'awaiting_input' | 'working' | 'idle';
export interface HomeGroup { state: HomeState; total: number; servers: GrupoSessoes[] }

// Memória da home entre rotas, sem virar preferência permanente.
export const homeSessionsView = { readyExpanded: false, scrollTop: 0 };

const ORDER: HomeState[] = ['awaiting_input', 'working', 'idle'];

// ponytail: linhas de par externo (`outside`) ficam só na lista completa.
export function groupHomeSessions(rows: AggSession[], readyExpanded: boolean): HomeGroup[] {
  return ORDER.flatMap((state) => {
    const all = rows.filter((r) => r.state === state && !r.outside);
    if (!all.length) return [];
    // Prontas: a que terminou por último aparece primeiro, e é a que fica à vista recolhida.
    if (state === 'idle') all.sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0));
    const visible = state === 'idle' && !readyExpanded ? all.slice(0, 1) : all;
    const servers = new Map<string, GrupoSessoes>();
    for (const session of visible) {
      const group = servers.get(session.serverId) ?? { ...grupoDaSessao(session, 'server'), sessions: [] };
      group.sessions.push(session);
      servers.set(group.id, group);
    }
    return [{ state, total: all.length, servers: [...servers.values()].sort((a, b) => a.label.localeCompare(b.label)) }];
  });
}
