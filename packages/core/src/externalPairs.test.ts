import { describe, it, expect, vi } from 'vitest';
import { reconcilePairEntries, placeExternalRows, pairHeaderLabel, pairExternals, pairsLeft, fullPairsByAlias, grantFull, createExternalPairSync, type ExternalPair } from './externalPairs';
import { setPairAccess } from './api';

vi.mock('./api', () => ({ setPairAccess: vi.fn() }));
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

describe('pairsLeft', () => {
  it('par que sumiu da leitura avisa; o desfeito aqui não, e a marca é consumida', () => {
    const a = par(), b = par({ session: 'h2', owner: 'Bia' });
    const leaving = new Set(['casa::h']);
    expect(pairsLeft([a, b], [], leaving)).toEqual([b]);
    expect(leaving.size).toBe(0);
    expect(pairsLeft([a, b], [a], new Set())).toEqual([b]);
    expect(pairsLeft([a], [a], new Set())).toEqual([]);
  });
});

describe('fullPairsByAlias', () => {
  it('um por máquina de fora, só acesso completo já liberado', () => {
    const rows = [
      { pair_externals: [ext({ level: 'full' }), ext({ alias: 'bia', owner: 'Bia', level: 'view' })] },
      { pair_externals: [ext({ level: 'full', session: 'h2' }), ext({ alias: 'cid', owner: 'Cid', level: 'full', pending: true })] },
    ];
    expect(fullPairsByAlias(rows)).toEqual([{ alias: 'casa', owner: 'Ana' }]);
  });
});

describe('grantFull', () => {
  it('libera cada par e junta as falhas sem parar na primeira', async () => {
    vi.mocked(setPairAccess).mockRejectedValueOnce(new Error('caiu')).mockResolvedValue({ ok: true });
    const falhas = await grantFull([{ name: 'a', alias: 'casa' }, { name: 'b', alias: 'casa' }], PROPRIO);
    expect(falhas).toEqual(['a: caiu']);
    expect(setPairAccess).toHaveBeenCalledWith('b', 'casa', 'full', PROPRIO);
  });
});

describe('createExternalPairSync', () => {
  const comPar = [{ name: 's', state: 'idle', pair_externals: [ext()] }] as SessionInfo[];
  const setup = () => {
    let t = 0;
    let linhas: SessionInfo[] = comPar;
    const read = vi.fn(async (_s: Server): Promise<ExternalPair[]> => [par()]);
    const left: string[] = [];
    const sync = createExternalPairSync({ read, apply: () => [], attach: async () => {}, onLeft: (p) => left.push(p.owner), now: () => t });
    const tick = (rows = linhas) => { linhas = rows; return sync.refresh([PROPRIO, ENTRADA], (id) => id === PROPRIO.id ? linhas : null); };
    return { read, left, sync, tick, avanca: (ms: number) => { t += ms; } };
  };

  it('relê só quando muda o que as linhas próprias mostram; o par sumir da leitura avisa', async () => {
    const { read, left, sync, tick } = setup();
    await tick();
    expect(read).toHaveBeenCalledWith(PROPRIO);
    expect(sync.anchored('o', 's')).toEqual([par()]);
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue([]);
    await tick([]);
    expect(left).toEqual(['Ana']);
    // Sem par nem leitura anterior: nada a pedir.
    await tick([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('leitura falha fica com os pares de antes e espera para tentar de novo', async () => {
    const { read, left, sync, tick, avanca } = setup();
    await tick();
    read.mockRejectedValue(new Error('rede'));
    await tick([...comPar, { name: 'x', state: 'idle', pair_externals: [ext({ session: 'h2' })] } as SessionInfo]);
    expect(sync.anchored('o', 's')).toEqual([par()]);
    expect(left).toEqual([]);
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    avanca(2_000);
    read.mockResolvedValue([par()]);
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('attach que falha espera antes de tentar de novo, sem reler a cada lista; o sucesso zera a espera', async () => {
    let t = 0;
    const read = vi.fn(async (_s: Server): Promise<ExternalPair[]> => [par()]);
    const attach = vi.fn(async (_e: Server, _t: string): Promise<unknown> => { throw new Error('401'); });
    const sync = createExternalPairSync({ read, apply: () => [{ entry: ENTRADA, token: 'tp' }], attach, onLeft: () => {}, now: () => t });
    const tick = async () => { await sync.refresh([PROPRIO, ENTRADA], (id) => id === PROPRIO.id ? comPar : null); await new Promise((r) => setTimeout(r, 0)); };
    for (let i = 0; i < 5; i++) await tick();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    t += 2_000; await tick();
    expect(attach).toHaveBeenCalledTimes(2);
    // A espera dobra: 2 s depois ainda não tenta.
    t += 2_000; await tick();
    expect(attach).toHaveBeenCalledTimes(2);
    attach.mockResolvedValue({ ok: true });
    t += 2_000; await tick();
    expect(attach).toHaveBeenCalledTimes(3);
    // Ligou: nada mais a tentar.
    t += 60_000; await tick(); await tick();
    expect(attach).toHaveBeenCalledTimes(3);
  });

  it('marca de saída feita aqui não vira aviso', async () => {
    const { read, left, sync, tick } = setup();
    await tick();
    sync.markLeaving('casa', 'h');
    read.mockResolvedValue([]);
    await tick([]);
    expect(left).toEqual([]);
  });
});
