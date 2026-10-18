import { agruparSessoes, sortSessions, type AggSession, type GroupBy } from '@hangar/core';
import { placeOutside } from './outsideRows';
import * as m from '../../paraglide/messages';

export interface SessionSection {
  id: string;
  label: string;
  color: string | null;
  total: number;
  collapsed: boolean;
  data: AggSession[];
}

export const sessionGroupKey = (mode: GroupBy, id: string) => id.startsWith('state:') ? id : `${mode}:${id}`;

export function buildSessionSections(rows: AggSession[], mode: GroupBy, search: string, collapsedGroups: ReadonlySet<string>, preferredServerId?: string): SessionSection[] {
  const liveRows = rows.filter((r) => r.state !== 'dead');
  const visible = search
    ? liveRows.filter((r) => r.name.toLowerCase().includes(search) || (r.cwd ?? '').toLowerCase().includes(search))
    : liveRows;
  const own = visible.filter((r) => !r.outside);
  const top = [
    { id: 'state:awaiting_input', label: m.home_sessions_awaiting(), color: null, sessions: sortSessions(own.filter((r) => r.state === 'awaiting_input')) },
    { id: 'state:working', label: m.home_sessions_working(), color: null, sessions: sortSessions(own.filter((r) => r.state === 'working')) },
  ];
  const rest = agruparSessoes(own.filter((r) => r.state !== 'awaiting_input' && r.state !== 'working'), mode);
  if (mode === 'server') rest.sort((a, b) => a.label.localeCompare(b.label));
  if (mode === 'none' && top.some((g) => g.sessions.length)) rest[0].label = m.home_sessions_ready();
  const groups = placeOutside([...top, ...rest], visible.filter((r) => r.outside), mode, liveRows);
  if (mode === 'server' && preferredServerId) {
    const rank = (id: string) => id === 'state:awaiting_input' ? 0 : id === 'state:working' ? 1 : 2;
    groups.sort((a, b) => rank(a.id) - rank(b.id)
      || Number(b.id === preferredServerId) - Number(a.id === preferredServerId) || a.label.localeCompare(b.label));
  }
  return groups.filter((g) => g.sessions.length).map((g) => {
    const collapsed = !!g.label && collapsedGroups.has(sessionGroupKey(mode, g.id));
    return { id: g.id, label: g.label, color: g.color, total: g.sessions.length, collapsed, data: collapsed ? [] : g.sessions };
  });
}
