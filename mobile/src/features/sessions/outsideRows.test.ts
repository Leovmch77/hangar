import { describe, expect, it } from 'vitest';
import { agruparSessoes, type AggSession } from '@hangar/core';
import { placeOutside } from './outsideRows';

const row = (name: string, extra: Partial<AggSession> = {}): AggSession => ({
  name, state: 'idle', serverId: 's1', serverLabel: 'casa', serverColor: '#000', cwd: `/r/${name}`, last_activity: 1, ...extra,
} as AggSession);
const web = row('web', { serverId: 'p_1', serverLabel: 'Par · Ana', outside: { alias: 'casa', owner: 'Ana', localServerId: 's1', localSession: 'api' } });

describe('placeOutside', () => {
  it('põe a sessão de fora logo abaixo da sessão do par, no grupo dela', () => {
    const locais = [row('api'), row('outra')];
    const grupos = placeOutside(agruparSessoes(locais, 'server'), [web], 'server', locais);
    expect(grupos).toHaveLength(1);
    const nomes = grupos[0].sessions.map((s) => s.name);
    expect(nomes.indexOf('web')).toBe(nomes.indexOf('api') + 1);
  });

  it('sessão do par fora dos grupos (precisa de você): vai para o grupo dela, nunca para um grupo próprio', () => {
    const api = row('api', { state: 'awaiting_input' });
    const grupos = placeOutside(agruparSessoes([row('outra')], 'server'), [web], 'server', [api, row('outra')]);
    expect(grupos.map((g) => g.id)).toEqual(['s1']);
    expect(grupos[0].sessions.map((s) => s.name)).toContain('web');
  });

  it('sem nenhum grupo da máquina, cria o grupo da máquina dela', () => {
    const api = row('api', { state: 'awaiting_input' });
    const grupos = placeOutside([], [web], 'project', [api]);
    expect(grupos).toEqual([expect.objectContaining({ id: '/r/api', sessions: [web] })]);
  });
});
