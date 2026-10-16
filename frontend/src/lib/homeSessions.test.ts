import { describe, expect, it } from 'vitest';
import { groupHomeSessions } from './homeSessions';

const row = (name: string, state: string, extra: object = {}) => ({ name, state, serverId: 's', ...extra }) as never;

describe('groupHomeSessions', () => {
  const rows = [row('a', 'idle'), row('b', 'working'), row('c', 'awaiting_input'), row('d', 'idle'), row('e', 'idle'),
    row('x', 'dead'), row('fora', 'working', { outside: { localServerId: 's', localSession: 'b' } })];

  it('agrupa esperando, trabalhando e prontas nessa ordem, sem mortas nem linhas de fora', () => {
    const g = groupHomeSessions(rows, false);
    expect(g.map((s) => s.state)).toEqual(['awaiting_input', 'working', 'idle']);
    expect(g[0].sessions.map((s) => s.name)).toEqual(['c']);
    expect(g[1].sessions.map((s) => s.name)).toEqual(['b']);
  });

  it('prontas mostram uma e contam o total enquanto recolhidas', () => {
    const idle = groupHomeSessions(rows, false)[2];
    expect(idle.sessions.map((s) => s.name)).toEqual(['a']);
    expect(idle.total).toBe(3);
    expect(groupHomeSessions(rows, true)[2].sessions.map((s) => s.name)).toEqual(['a', 'd', 'e']);
  });

  it('grupo vazio não aparece', () => {
    expect(groupHomeSessions([row('a', 'working')], false).map((s) => s.state)).toEqual(['working']);
  });
});
