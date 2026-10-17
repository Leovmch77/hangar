import { describe, expect, it } from 'vitest';
import { groupHomeSessions } from './homeSessions';

const row = (name: string, state: string, extra: object = {}) => ({ name, state, serverId: 's', serverLabel: 's', serverColor: '#fff', ...extra }) as never;
const visible = (group: ReturnType<typeof groupHomeSessions>[number]) => group.servers.flatMap((s) => s.sessions);

describe('groupHomeSessions', () => {
  const rows = [row('a', 'idle'), row('b', 'working'), row('c', 'awaiting_input'), row('d', 'idle'), row('e', 'idle'),
    row('x', 'dead'), row('fora', 'working', { outside: { localServerId: 's', localSession: 'b' } })];

  it('agrupa esperando, trabalhando e prontas nessa ordem, sem mortas nem linhas de fora', () => {
    const g = groupHomeSessions(rows, false);
    expect(g.map((s) => s.state)).toEqual(['awaiting_input', 'working', 'idle']);
    expect(visible(g[0]).map((s) => s.name)).toEqual(['c']);
    expect(visible(g[1]).map((s) => s.name)).toEqual(['b']);
  });

  it('prontas mostram uma e contam o total enquanto recolhidas', () => {
    const idle = groupHomeSessions(rows, false)[2];
    expect(visible(idle).map((s) => s.name)).toEqual(['a']);
    expect(idle.total).toBe(3);
    expect(visible(groupHomeSessions(rows, true)[2]).map((s) => s.name)).toEqual(['a', 'd', 'e']);
  });

  it('prontas vêm da que terminou por último para a mais antiga', () => {
    const ready = [row('antiga', 'idle', { last_activity: 100 }), row('recente', 'idle', { last_activity: 300 }),
      row('meio', 'idle', { last_activity: 200 })];
    expect(visible(groupHomeSessions(ready, false)[0]).map((s) => s.name)).toEqual(['recente']);
    expect(visible(groupHomeSessions(ready, true)[0]).map((s) => s.name)).toEqual(['recente', 'meio', 'antiga']);
  });

  it('separa servidores em cada estado e recolhe só uma pronta global', () => {
    const sessions = [
      row('espera-b', 'awaiting_input', { serverId: 'b', serverLabel: 'Beta', serverColor: '#bbb' }),
      row('espera-a', 'awaiting_input', { serverId: 'a', serverLabel: 'Alfa', serverColor: '#aaa' }),
      row('trabalho-b', 'working', { serverId: 'b', serverLabel: 'Beta', serverColor: '#bbb' }),
      row('trabalho-a', 'working', { serverId: 'a', serverLabel: 'Alfa', serverColor: '#aaa' }),
      row('antiga-a', 'idle', { serverId: 'a', serverLabel: 'Alfa', serverColor: '#aaa', last_activity: 100 }),
      row('recente-b', 'idle', { serverId: 'b', serverLabel: 'Beta', serverColor: '#bbb', last_activity: 300 }),
      row('meio-a', 'idle', { serverId: 'a', serverLabel: 'Alfa', serverColor: '#aaa', last_activity: 200 }),
    ];
    const collapsed = groupHomeSessions(sessions, false);
    expect(collapsed[0].servers).toEqual([
      { id: 'a', label: 'Alfa', color: '#aaa', sessions: [sessions[1]] },
      { id: 'b', label: 'Beta', color: '#bbb', sessions: [sessions[0]] },
    ]);
    expect(collapsed[1].servers.map((s) => s.id)).toEqual(['a', 'b']);
    expect(collapsed[2].total).toBe(3);
    expect(collapsed[2].servers).toEqual([
      { id: 'b', label: 'Beta', color: '#bbb', sessions: [sessions[5]] },
    ]);
    const expanded = groupHomeSessions(sessions, true)[2];
    expect(expanded.total).toBe(3);
    expect(expanded.servers.map((s) => [s.id, s.sessions.map((r) => r.name)])).toEqual([
      ['a', ['meio-a', 'antiga-a']], ['b', ['recente-b']],
    ]);
  });

  it('grupo vazio não aparece', () => {
    expect(groupHomeSessions([row('a', 'working')], false).map((s) => s.state)).toEqual(['working']);
  });
});
