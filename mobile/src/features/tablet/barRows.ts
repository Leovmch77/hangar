import { groupGlobal, type AggSession } from '@hangar/core';
import { buildSessionSections } from '../sessions/sessionSections';

export type BarItem = { kind: 'single'; session: AggSession } | { kind: 'group'; label: string | null; members: AggSession[] };

const keyOf = (s: AggSession) => `${s.serverId}::${s.name}`;

export function barRows(rows: AggSession[], identities: ReadonlyMap<string, string>): BarItem[] {
  const ordered = buildSessionSections(rows, 'none', '', new Set()).flatMap(s => s.data);
  const byKey = new Map(ordered.map(s => [keyOf(s), s]));
  type Group = { label: string | null; members: Set<AggSession> };
  const groupOf = new Map<AggSession, Group>();
  const join = (members: AggSession[], label: string | null = null) => {
    const group: Group = { label, members: new Set(members) };
    for (const member of members) {
      const existing = groupOf.get(member);
      if (!existing) continue;
      group.label ??= existing.label;
      for (const s of existing.members) group.members.add(s);
    }
    for (const member of group.members) groupOf.set(member, group);
  };
  for (const group of groupGlobal(ordered, identities)) {
    const members = group.members.flatMap(m => m.kind === 'here' ? byKey.get(`${m.server}::${m.name}`) ?? [] : []);
    if (members.length > 1) join(members, group.label);
  }
  for (const s of ordered) {
    // O vínculo é local; nomes iguais noutra máquina não são a mãe da filha.
    const parent = s.linked_by ? byKey.get(`${s.serverId}::${s.linked_by}`) : undefined;
    const anchor = s.outside ? byKey.get(`${s.outside.localServerId}::${s.outside.localSession}`) : undefined;
    if (parent) join([parent, s]);
    if (anchor) join([anchor, s]);
  }
  const members = new Map<Group, AggSession[]>();
  for (const s of ordered) {
    const group = groupOf.get(s);
    if (group) {
      const list = members.get(group) ?? [];
      list.push(s);
      members.set(group, list);
    }
  }
  const placed = new Set<Group>();
  return ordered.flatMap((session): BarItem[] => {
    const group = groupOf.get(session);
    if (!group || group.members.size < 2) return [{ kind: 'single', session }];
    if (placed.has(group)) return [];
    placed.add(group);
    return [{ kind: 'group', label: group.label, members: members.get(group)! }];
  });
}
