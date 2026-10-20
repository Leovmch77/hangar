import { describe, expect, it } from 'vitest';
import { groupGlobal } from './pairGroups';
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
