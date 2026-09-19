import { describe, it, expect } from 'vitest';
import { podeAgrupar, podeSair } from './pairDrop';
import type { AggSession } from './types';

const s = (over: Partial<AggSession> = {}): AggSession =>
  ({
    name: 'a', serverId: 'srv1', serverLabel: 'srv1', serverColor: '#123',
    state: 'idle', pair_gid: null, pair_peers: null,
    ...over,
  }) as AggSession;

describe('podeAgrupar', () => {
  it('recusa soltar sobre si mesma (mesmo serverId + name)', () => {
    expect(podeAgrupar(s({ name: 'a' }), s({ name: 'a' }))).toEqual({ ok: false, motivo: 'mesma' });
  });

  it('recusa servidor diferente', () => {
    const origem = s({ name: 'a', serverId: 'srv1' });
    const alvo = s({ name: 'b', serverId: 'srv2' });
    expect(podeAgrupar(origem, alvo)).toEqual({ ok: false, motivo: 'outro_servidor' });
  });

  it('recusa sessão morta, tanto na origem quanto no alvo', () => {
    const viva = s({ name: 'a' });
    const morta = s({ name: 'b', state: 'dead' });
    expect(podeAgrupar(morta, viva)).toEqual({ ok: false, motivo: 'morta' });
    expect(podeAgrupar(viva, morta)).toEqual({ ok: false, motivo: 'morta' });
  });

  it('recusa mesmo grupo (pair_gid igual e não nulo)', () => {
    const origem = s({ name: 'a', pair_gid: 'g1' });
    const alvo = s({ name: 'b', pair_gid: 'g1' });
    expect(podeAgrupar(origem, alvo)).toEqual({ ok: false, motivo: 'mesmo_grupo' });
  });

  it('recusa cross-server, tanto na origem quanto no alvo', () => {
    const local = s({ name: 'a' });
    const comPeerRemoto = s({ name: 'b', pair_peers: ['srv2::outra'] });
    expect(podeAgrupar(comPeerRemoto, local)).toEqual({ ok: false, motivo: 'cross_server' });
    expect(podeAgrupar(local, comPeerRemoto)).toEqual({ ok: false, motivo: 'cross_server' });
  });

  it('aceita o caso feliz', () => {
    expect(podeAgrupar(s({ name: 'a' }), s({ name: 'b' }))).toEqual({ ok: true });
  });
});

describe('podeSair', () => {
  it('true com pair_gid mesmo sem peers (sidecar legado sem gid vem de outro caminho)', () => {
    expect(podeSair(s({ pair_gid: 'g1', pair_peers: null }))).toBe(true);
  });

  it('true com pair_peers mesmo sem gid (par cross-server)', () => {
    expect(podeSair(s({ pair_gid: null, pair_peers: ['srv2::outra'] }))).toBe(true);
  });

  it('false sem gid e sem peers', () => {
    expect(podeSair(s({ pair_gid: null, pair_peers: null }))).toBe(false);
  });
});
