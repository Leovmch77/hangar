import type { AggSession } from './types';

type LinkRow = Pick<AggSession, 'name' | 'linked_by'> & { serverId?: string };

/** Filhas ligadas a `parent`. `linked_by` é um nome local: o servidor é conferido quando os dois lados o têm;
 *  lista de um servidor só (sem `serverId`) passa direto. */
export function linkedChildren<T extends LinkRow>(rows: readonly T[], parent: { serverId?: string; name: string }): T[] {
  return rows
    .filter(r => r.linked_by === parent.name
      && (parent.serverId === undefined || r.serverId === undefined || r.serverId === parent.serverId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Filhas concluídas: só `idle` conta. */
export function linkedChildrenDone(children: readonly Pick<AggSession, 'state'>[]): number {
  return children.filter(c => c.state === 'idle').length;
}
