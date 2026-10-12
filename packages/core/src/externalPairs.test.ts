import { describe, it, expect } from 'vitest';
import { reconcilePairEntries, placeExternalRows, pairHeaderLabel, pairExternals, type ExternalPair } from './externalPairs';
import type { Server } from './servers';
import type { AggSession, SessionInfo, PairExternal } from './types';
import type { ServerBucket } from './sessions';
import * as m from './paraglide/messages';

const CASA = 'https://casa.ts.net:8443';
const par = (over: Partial<ExternalPair> = {}): ExternalPair => ({
  local_session: 's', alias: 'casa', owner: 'Ana', session: 'h', address: CASA, token: 'tp', ...over,
});
const ids = () => { let n = 0; return () => `srv-${++n}`; };

describe('reconcilePairEntries', () => {
  it('cria uma entrada temporária por endereço de fora, com o token do par', () => {
    const r = reconcilePairEntries([], [par(), par({ session: 'h2', token: 'tp2', address: `${CASA}/` })], ids());
    expect(r.servers).toEqual([{ id: 'srv-1', label: m.native_par_rotulo({ dono: 'Ana' }), baseUrl: CASA, token: 'tp', invite: true, ephemeral: true }]);
    // O segundo par na mesma máquina liga o token dele à entrada.
    expect(r.attach).toEqual([{ entry: r.servers[0], token: 'tp2' }]);
  });
  it('par que acabou leva a entrada temporária junto', () => {
    const e: Server = { id: 'x', label: 'Par · Ana', baseUrl: CASA, token: 'tp', invite: true, ephemeral: true };
    expect(reconcilePairEntries([e], [], ids()).servers).toEqual([]);
  });
  it('entrada temporária cujo token acabou passa ao token de um par vivo', () => {
    const e: Server = { id: 'x', label: 'Par · Ana', baseUrl: CASA, token: 'velho', invite: true, ephemeral: true };
    const r = reconcilePairEntries([e], [par({ token: 'novo' })], ids());
    expect(r.servers).toEqual([{ ...e, token: 'novo' }]);
    expect(r.attach).toEqual([]);
  });
  it('convite de verdade no mesmo endereço recebe o attach e não vira temporário', () => {
    const e: Server = { id: 'x', label: 'Convite · Ana', baseUrl: CASA, token: 'tc', invite: true };
    const r = reconcilePairEntries([e], [par()], ids());
    expect(r.servers).toEqual([e]);
    expect(r.attach).toEqual([{ entry: e, token: 'tp' }]);
  });
  it('servidor próprio no mesmo endereço nunca recebe o token do par', () => {
    const own: Server = { id: 'o', label: 'casa', baseUrl: CASA, token: 'dono' };
    expect(reconcilePairEntries([own], [par()], ids())).toEqual({ servers: [own], attach: [] });
  });
});

const PROPRIO: Server = { id: 'o', label: 'note', baseUrl: 'https://note.ts.net', token: 'td' };
const ENTRADA: Server = { id: 'e', label: 'Par · Ana', baseUrl: CASA, token: 'tp', invite: true, ephemeral: true };
const row = (server: Server, over: Partial<SessionInfo>): AggSession =>
  ({ name: 'x', state: 'idle', serverId: server.id, serverLabel: server.label, serverColor: '#000', ...over }) as AggSession;
const bucket = (server: Server, sessions: AggSession[]): ServerBucket => ({ server, sessions, error: null, loaded: true });
const ext = (over: Partial<PairExternal> = {}): PairExternal =>
  ({ alias: 'casa', owner: 'Ana', session: 'h', address: CASA, level: 'view', pending: false, ...over });

describe('placeExternalRows', () => {
  it('a sessão de fora entra no grupo local, no servidor do grupo, e a entrada temporária some', () => {
    const local = row(PROPRIO, { name: 's', pair_gid: 'g1', pair_peers: ['casa::h'], pair_externals: [ext()] });
    const fora = row(ENTRADA, { name: 'h', pair_gid: 'gremoto', guest_kind: 'pair' });
    const outro = row(ENTRADA, { name: 'solta' });
    const r = placeExternalRows({ rows: [local, fora, outro], byServer: [bucket(PROPRIO, [local]), bucket(ENTRADA, [fora, outro])] });
    expect(r.byServer.map((b) => b.server.id)).toEqual(['o']);
    const placed = r.byServer[0].sessions[1];
    expect(placed).toMatchObject({ name: 'h', serverId: 'e', pair_gid: 'g1', outside: { alias: 'casa', owner: 'Ana', localServerId: 'o', localSession: 's' } });
    expect(r.rows.map((x) => x.name)).toEqual(['s', 'h']);
  });
  it('convite de verdade continua como seção; só a sessão do par sai dele', () => {
    const convite: Server = { ...ENTRADA, ephemeral: undefined, label: 'Convite · Ana' };
    const local = row(PROPRIO, { name: 's', pair_gid: 'g1', pair_externals: [ext()] });
    const fora = row(convite, { name: 'h' });
    const compartilhada = row(convite, { name: 'outra' });
    const r = placeExternalRows({ rows: [], byServer: [bucket(PROPRIO, [local]), bucket(convite, [fora, compartilhada])] });
    expect(r.byServer.map((b) => b.sessions.map((s) => s.name))).toEqual([['s', 'h'], ['outra']]);
  });
  it('linha de servidor antigo (pair_external objeto, sem endereço) não move nada', () => {
    const local = row(PROPRIO, { name: 's', pair_gid: 'g1', pair_external: { alias: 'casa', owner: 'Ana', session: 'h' } });
    const fora = row(ENTRADA, { name: 'h' });
    const r = placeExternalRows({ rows: [], byServer: [bucket(PROPRIO, [local]), bucket(ENTRADA, [fora])] });
    expect(r.byServer.map((b) => b.sessions.map((s) => s.name))).toEqual([['s']]);
  });
});

describe('pairExternals', () => {
  it('aceita a lista nova e o objeto único do servidor antigo (ver e recado)', () => {
    expect(pairExternals({ pair_externals: [ext({ level: 'full' })], pair_external: ext({ level: 'full' }) })).toEqual([ext({ level: 'full' })]);
    expect(pairExternals({ pair_external: { alias: 'casa', owner: 'Ana', session: 'h' } }))
      .toEqual([{ alias: 'casa', owner: 'Ana', session: 'h', address: '', level: 'view', pending: false }]);
    expect(pairExternals({ pair_external: null })).toEqual([]);
  });
});

describe('pairHeaderLabel', () => {
  it('diz com quem o grupo está pareado, sem repetir o par visto por dois membros', () => {
    const a = { pair_externals: [ext()] };
    const b = { pair_externals: [ext(), ext({ alias: 'bia', owner: 'Bia', session: 'k' })] };
    expect(pairHeaderLabel('hangar', [a, b])).toBe('hangar ↔ casa::h (Ana), bia::k (Bia)');
    expect(pairHeaderLabel('hangar', [{ pair_external: null }])).toBe('hangar');
  });
});
