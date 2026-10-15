import { describe, it, expect } from 'vitest';
import { canPair, canLeave, pairAnchor } from './pairDrop';
import type { AggSession } from './types';

const s = (over: Partial<AggSession> = {}): AggSession =>
  ({
    name: 'a', serverId: 'srv1', serverLabel: 'srv1', serverColor: '#123',
    state: 'idle', pair_gid: null, pair_peers: null,
    ...over,
  }) as AggSession;

describe('canPair', () => {
  it('recusa soltar sobre si mesma (mesmo serverId + name)', () => {
    expect(canPair(s({ name: 'a' }), s({ name: 'a' }))).toEqual({ ok: false, reason: 'same' });
  });

  it('recusa servidor diferente', () => {
    const origem = s({ name: 'a', serverId: 'srv1' });
    const alvo = s({ name: 'b', serverId: 'srv2' });
    expect(canPair(origem, alvo)).toEqual({ ok: false, reason: 'other_server' });
  });

  it('recusa sessão morta, tanto na origem quanto no alvo', () => {
    const viva = s({ name: 'a' });
    const morta = s({ name: 'b', state: 'dead' });
    expect(canPair(morta, viva)).toEqual({ ok: false, reason: 'dead' });
    expect(canPair(viva, morta)).toEqual({ ok: false, reason: 'dead' });
  });

  it('recusa mesmo grupo (pair_gid igual e não nulo)', () => {
    const origem = s({ name: 'a', pair_gid: 'g1' });
    const alvo = s({ name: 'b', pair_gid: 'g1' });
    expect(canPair(origem, alvo)).toEqual({ ok: false, reason: 'same_group' });
  });

  it('recusa cross-server, tanto na origem quanto no alvo', () => {
    const local = s({ name: 'a' });
    const comPeerRemoto = s({ name: 'b', pair_peers: ['srv2::outra'] });
    expect(canPair(comPeerRemoto, local)).toEqual({ ok: false, reason: 'cross_server' });
    expect(canPair(local, comPeerRemoto)).toEqual({ ok: false, reason: 'cross_server' });
  });

  it('membro de fora (par externo) não conta como par de outro servidor', () => {
    const comFora = s({ name: 'b', pair_gid: 'g1', pair_peers: ['casa::h'],
      pair_externals: [{ alias: 'casa', owner: 'Ana', session: 'h', address: 'https://casa.ts.net:8443', level: 'view', pending: false }] });
    expect(canPair(s({ name: 'a' }), comFora)).toEqual({ ok: true });
    expect(canPair(comFora, s({ name: 'a' }))).toEqual({ ok: true });
  });

  it('a linha de fora vale pela sessão local do grupo dela', () => {
    const fora = s({ name: 'h', serverId: 'convite', pair_gid: 'g1',
      outside: { alias: 'casa', owner: 'Ana', localServerId: 'srv1', localSession: 'b' } });
    expect(canPair(s({ name: 'a' }), fora)).toEqual({ ok: true });
    expect(canPair(s({ name: 'b', pair_gid: 'g1' }), fora)).toEqual({ ok: false, reason: 'same' });
    expect(pairAnchor(fora)).toMatchObject({ serverId: 'srv1', name: 'b' });
  });

  it('recusa a linha do orquestrador, tanto na origem quanto no alvo', () => {
    const comum = s({ name: 'a' });
    const orq = s({ name: 'orq-x', provider: 'orq' });
    expect(canPair(orq, comum)).toEqual({ ok: false, reason: 'orq' });
    expect(canPair(comum, orq)).toEqual({ ok: false, reason: 'orq' });
  });

  it('aceita o caso feliz', () => {
    expect(canPair(s({ name: 'a' }), s({ name: 'b' }))).toEqual({ ok: true });
  });
});

describe('canLeave', () => {
  it('true com pair_gid mesmo sem peers (sidecar legado sem gid vem de outro caminho)', () => {
    expect(canLeave(s({ pair_gid: 'g1', pair_peers: null }))).toBe(true);
  });

  it('false para a linha do orquestrador, mesmo com grupo', () => {
    expect(canLeave(s({ provider: 'orq', pair_gid: 'g1', pair_peers: ['b'] }))).toBe(false);
  });

  it('true com pair_peers mesmo sem gid (par cross-server)', () => {
    expect(canLeave(s({ pair_gid: null, pair_peers: ['srv2::outra'] }))).toBe(true);
  });

  it('false sem gid e sem peers', () => {
    expect(canLeave(s({ pair_gid: null, pair_peers: null }))).toBe(false);
  });
});
