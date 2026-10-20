import { describe, expect, it } from 'vitest';
import type { AggSession } from '@hangar/core';
import { groupBadge, groupMembers, outsideRow, pairCandidates, pairTargets, ticketCode } from './groupPairs';

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
  it('código do ticket como o split_code do nativo', () => {
    expect(ticketCode('ABC-1234 tela X')).toBe('ABC-1234');
    expect(ticketCode('PM-12')).toBe('PM-12');
    expect(ticketCode('PM-12x')).toBeNull();
    expect(ticketCode('tela nova')).toBeNull();
  });

  it('grupo de uma máquina mantém o rótulo antigo', () => {
    expect(groupBadge(row('a', { pair_peers: ['b'], pair_task: 'tela X' }))).toEqual({ text: 'tela X', machines: 1 });
    expect(groupBadge(row('a', { pair_peers: ['b', 'c'] }))).toEqual({ text: '3', machines: 1 });
    expect(groupBadge(row('a'))).toBeNull();
  });

  it('entre máquinas conta as máquinas, sem o membro de fora, e prefere o ticket', () => {
    const externals = [{ alias: 'ana', owner: 'Ana', session: 'web', address: 'https://x.ts.net:8443', level: 'view' as const, pending: false }];
    const s = row('a', { pair_owner: 'casa', pair_peers: ['b', 'lab::c', 'vm::d', 'ana::web'], pair_externals: externals, pair_task: 'tela X' });
    expect(groupBadge(s)).toEqual({ text: null, machines: 3 });
    expect(groupBadge({ ...s, pair_task: 'PM-7 tela' })).toEqual({ text: 'PM-7', machines: 3 });
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

  it('o pedido qualifica só quem é de outra máquina', () => {
    expect(pairTargets(['s1::b', 's2::z'], 's1', ids)).toEqual(['b', 'lab::z']);
  });
});

describe('membros do grupo entre máquinas', () => {
  it('traz o membro da outra máquina com o nome dela e o de máquina sem conexão como texto', () => {
    const rows = [
      row('a', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['lab::z', 'vm::y'] }),
      row('z', { serverId: 's2', serverLabel: 'lab', state: 'working', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['casa::a', 'vm::y'] }),
    ];
    expect(groupMembers('s1', 'a', rows, ids)).toEqual([
      { key: 's2::z', name: 'z', machine: 'lab', state: 'working', target: { server: 's2', name: 'z' }, missing: false },
      { key: 'missing:vm::y', name: 'y', machine: 'vm', state: null, target: null, missing: true },
    ]);
  });

  it('par sem gid continua pelos nomes de pair_peers', () => {
    const rows = [row('a', { pair_peers: ['b'] }), row('b', { pair_peers: ['a'], state: 'working' })];
    expect(groupMembers('s1', 'a', rows, ids)).toEqual([
      { key: 'b', name: 'b', machine: null, state: 'working', target: { server: 's1', name: 'b' }, missing: false },
    ]);
  });
});
