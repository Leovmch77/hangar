import { describe, expect, it } from 'vitest';
import { groupBadges, groupGlobal, pairTargets, ticketCode } from './pairGroups';
import type { AggSession } from './types';
import fixtures from './pairGroups.fixtures.json';

type FixtureRow = { server: string; invite?: boolean; [field: string]: unknown };
const fixtureRow = ({ server, invite, ...rest }: FixtureRow) =>
  ({ serverId: server, serverLabel: server, serverColor: '#123', state: 'idle', serverInvite: invite, ...rest }) as unknown as AggSession;

describe('groupGlobal (fixture compartilhada com o nativo)', () => {
  it.each(fixtures.groups.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const identities = new Map(Object.entries((c as { identities?: Record<string, string> }).identities ?? fixtures.defaultIdentities));
    expect(groupGlobal(c.rows.map(fixtureRow), identities)).toEqual(c.groups);
  });

  it('a linha de fora (convite) não forma grupo próprio: o membro vem do par da sessão local', () => {
    const local = fixtureRow({ server: 'srv-a', name: 'x', pair_gid: 'g1', pair_peers: ['ana::Y'],
      pair_externals: [{ alias: 'ana', owner: 'Ana', session: 'Y', address: 'https://ana.ts.net:8443', level: 'view', pending: false }] });
    const fora = { ...fixtureRow({ server: 'convite', name: 'Y', pair_gid: 'g1' }),
      outside: { alias: 'ana', owner: 'Ana', localServerId: 'srv-a', localSession: 'x' } };
    expect(groupGlobal([local, fora], new Map([['srv-a', 'casa']]))).toEqual([{ key: 'local:srv-a/g1', label: 'x', members: [
      { kind: 'here', server: 'srv-a', name: 'x' }, { kind: 'outside', alias: 'ana', session: 'Y' }] }]);
  });
});

const row = (name: string, extra: Partial<AggSession> = {}) => ({ name, state: 'idle', serverId: 's1', serverLabel: 'casa', serverColor: '#000', ...extra }) as AggSession;
const ids = new Map([['s1', 'casa'], ['s2', 'lab']]);

describe('selo do grupo entre máquinas', () => {
  it('código do ticket como o split_code do nativo', () => {
    expect(ticketCode('ABC-1234 tela X')).toBe('ABC-1234');
    expect(ticketCode('PM-12')).toBe('PM-12');
    expect(ticketCode('PM-12x')).toBeNull();
    expect(ticketCode('tela nova')).toBeNull();
  });

  it('grupo de uma máquina só não ganha selo, nem com dona definida', () => {
    const a = row('a', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['b'] });
    const b = row('b', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['a'] });
    expect(groupBadges([a, b], ids).size).toBe(0);
  });

  it('conta as máquinas pelo modelo global, sem o membro de fora, e prefere o ticket', () => {
    const externals = [{ alias: 'ana', owner: 'Ana', session: 'web', address: 'https://x.ts.net:8443', level: 'view' as const, pending: false }];
    const a = row('a', { pair_gid: 'g', pair_owner: 'casa', pair_peers: ['b', 'lab::c', 'vm::d', 'ana::web'], pair_externals: externals, pair_task: 'tela X' });
    const c = row('c', { serverId: 's2', serverLabel: 'lab', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['casa::a', 'casa::b', 'vm::d'] });
    expect(groupBadges([a, c], ids)).toEqual(new Map([['s1::a', { text: null, machines: 3 }], ['s2::c', { text: null, machines: 3 }]]));
    expect(groupBadges([{ ...a, pair_task: 'PM-7 tela' }, c], ids).get('s2::c')).toEqual({ text: 'PM-7', machines: 3 });
  });
});

describe('pairTargets', () => {
  it('qualifica só quem é de outra máquina', () => {
    expect(pairTargets(['s1::b', 's2::z'], 's1', ids)).toEqual({ names: ['b', 'lab::z'], unresolved: [] });
  });

  it('máquina sem identificador válido não vai como undefined::nome: a escolha sai do pedido', () => {
    expect(pairTargets(['s1::b', 's3::w'], 's1', ids)).toEqual({ names: ['b'], unresolved: ['s3::w'] });
    expect(pairTargets(['s2::z'], 's1', new Map([['s1', 'casa'], ['s2', 'casa']]))).toEqual({ names: [], unresolved: ['s2::z'] });
  });
});
