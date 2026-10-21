import { describe, expect, it } from 'vitest';
import { groupBadges, type AggSession } from '@hangar/core';
import { groupBadge, groupMembers, outsideRow, pairCandidates, pickKey } from './groupPairs';

const row = (name: string, extra: Partial<AggSession> = {}) => ({ name, state: 'idle', serverId: 's1', serverLabel: 'casa', serverColor: '#000', ...extra }) as AggSession;
const ids = new Map([['s1', 'casa'], ['s2', 'lab']]);

describe('outsideRow', () => {
  it('acha a linha de fora de um membro alias::sessao', () => {
    const fora = row('web', { serverId: 'p_1', outside: { alias: 'ana', owner: 'Ana', localServerId: 's1', localSession: 'api' } });
    expect(outsideRow([row('api'), fora], 'ana::web')).toBe(fora);
    expect(outsideRow([row('api'), fora], 'docs')).toBeNull();
  });
});

describe('selo do grupo', () => {
  const badgeOf = (s: AggSession, rows: AggSession[], identities = ids) => groupBadge(s, groupBadges(rows, identities).get(pickKey(s.serverId, s.name)));

  it('grupo de uma máquina mantém o rótulo antigo', () => {
    const one = row('a', { pair_peers: ['b'], pair_task: 'tela X' });
    expect(badgeOf(one, [one])).toEqual({ text: 'tela X', machines: 1 });
    const three = row('a', { pair_peers: ['b', 'c'] });
    expect(badgeOf(three, [three])).toEqual({ text: '3', machines: 1 });
    expect(badgeOf(row('a'), [row('a')])).toBeNull();
  });

  it('dona definida com todos os membros nesta máquina não vira "1 máquinas"', () => {
    const a = row('a', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['b'] });
    const b = row('b', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['a'] });
    expect(badgeOf(a, [a, b])).toEqual({ text: 'b', machines: 1 });
  });

  it('entre máquinas conta as máquinas pelo modelo global, sem o membro de fora, e prefere o ticket', () => {
    const externals = [{ alias: 'ana', owner: 'Ana', session: 'web', address: 'https://x.ts.net:8443', level: 'view' as const, pending: false }];
    const a = row('a', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['b', 'lab::c', 'vm::d', 'ana::web'], pair_externals: externals, pair_task: 'tela X' });
    const c = row('c', { serverId: 's2', serverLabel: 'lab', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['casa::a', 'casa::b', 'vm::d'] });
    expect(badgeOf(a, [a, c])).toEqual({ text: null, machines: 3 });
    expect(badgeOf(c, [{ ...a, pair_task: 'PM-7 tela' }, c])).toEqual({ text: 'PM-7', machines: 3 });
  });
});

describe('candidatas de todas as máquinas', () => {
  const current = row('a');
  const own = { serverId: 's1', label: 'casa', rows: [current, row('b'), row('morta', { state: 'dead' })] };
  const lab = { serverId: 's2', label: 'lab', rows: [row('z', { serverId: 's2', serverLabel: 'lab' })] };

  it('lista a outra máquina com a chave qualificada', () => {
    expect(pairCandidates(current, [own, lab], ids, new Set())).toEqual([
      { serverId: 's1', label: 'casa', status: 'ready', candidates: [{ key: 's1::b', row: own.rows[1], refusal: null }] },
      { serverId: 's2', label: 'lab', status: 'ready', candidates: [{ key: 's2::z', row: lab.rows[0], refusal: null }] },
    ]);
  });

  it('identificador em leitura é carregando; sem identificador, a máquina diz o motivo', () => {
    expect(pairCandidates(current, [lab], new Map([['s1', 'casa']]), new Set(['s2']))[0].status).toBe('loading');
    expect(pairCandidates(current, [lab], new Map([['s1', 'casa']]), new Set())[0]).toEqual({ serverId: 's2', label: 'lab', status: 'no_identity', candidates: [] });
  });

  it('grupo de outra dona aparece recusado', () => {
    const fed = { ...lab, rows: [row('z', { serverId: 's2', pair_gid: 'g2', pair_owner: 'lab', pair_peers: ['w'] })] };
    const mine = row('a', { pair_gid: 'g1', pair_owner: 'casa', pair_peers: ['b'] });
    expect(pairCandidates(mine, [fed], ids, new Set())[0].candidates[0].refusal).toBe('other_owner');
  });
});

describe('membros do grupo entre máquinas', () => {
  it('traz o membro da outra máquina com o nome dela e o de máquina sem conexão como texto', () => {
    const rows = [
      row('a', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['lab::z', 'vm::y'] }),
      row('z', { serverId: 's2', serverLabel: 'lab', state: 'working', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['casa::a', 'vm::y'] }),
    ];
    expect(groupMembers('s1', 'a', rows, ids)).toEqual([
      { key: 's1::a', name: 'a', machine: null, state: 'idle', target: null, missing: false, self: true },
      { key: 's2::z', name: 'z', machine: 'lab', state: 'working', target: { server: 's2', name: 'z' }, missing: false },
      { key: 'missing:vm::y', name: 'y', machine: 'vm', state: null, target: null, missing: true },
    ]);
  });

  it('par sem gid continua pelos nomes de pair_peers', () => {
    const rows = [row('a', { pair_peers: ['b'] }), row('b', { pair_peers: ['a'], state: 'working' })];
    expect(groupMembers('s1', 'a', rows, ids)).toEqual([
      { key: 's1::a', name: 'a', machine: null, state: 'idle', target: null, missing: false, self: true },
      { key: 'b', name: 'b', machine: null, state: 'working', target: { server: 's1', name: 'b' }, missing: false },
    ]);
  });

  it('os 4 do grupo de 2 máquinas, vistos de um membro da outra máquina', () => {
    const fed = (name: string, serverId: string) => row(name, { serverId, serverLabel: serverId === 's1' ? 'casa' : 'lab', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['x'] });
    const rows = [fed('a', 's1'), fed('b', 's1'), fed('c', 's2'), fed('d', 's2')];
    const members = groupMembers('s2', 'c', rows, ids);
    expect(members.map((mb) => [mb.name, mb.machine, !!mb.self])).toEqual([['a', 'casa', false], ['b', 'casa', false], ['c', null, true], ['d', null, false]]);
  });
});
