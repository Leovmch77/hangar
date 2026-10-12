// Par externo do lado de quem o tem: a sessão da outra pessoa é lida por uma entrada de convite
// temporária e aparece dentro do grupo local, nunca numa seção própria.
import * as m from './paraglide/messages';
import { setPairAccess } from './api';
import type { Server } from './servers';
import type { ServerBucket } from './sessions';
import type { AggSession, PairExternal, PairLevel, SessionInfo } from './types';

/** Item de `GET /api/external-pairs`; `level_given` é o que eu dei (ausente em servidor antigo). */
export interface ExternalPair { local_session: string; alias: string; owner: string; session: string; address: string; token: string; level_given?: PairLevel }
export interface PairAttach { entry: Server; token: string }

type PairFields = Pick<SessionInfo, 'pair_external' | 'pair_externals'>;

const norm = (address: string) => address.trim().replace(/\/+$/, '').toLowerCase();

/** Porta de `reconcile_pair_entries` do nativo: uma entrada temporária por máquina de fora e os
 * `attach` pendentes (token do par a ligar numa entrada que já tem outro token). */
export function reconcilePairEntries(list: Server[], pairs: ExternalPair[], newId: () => string): { servers: Server[]; attach: PairAttach[] } {
  const at = (address: string) => pairs.filter((p) => norm(p.address) === norm(address));
  const servers = list.filter((s) => !s.ephemeral || at(s.baseUrl).length > 0);
  const attach: PairAttach[] = [];
  for (const p of pairs) {
    const i = servers.findIndex((s) => norm(s.baseUrl) === norm(p.address));
    if (i < 0) {
      servers.push({ id: newId(), label: m.native_par_rotulo({ dono: p.owner }), baseUrl: p.address, token: p.token, invite: true, ephemeral: true });
      continue;
    }
    let s = servers[i];
    // Servidor próprio no mesmo endereço: o token do par não entra nele.
    if (!s.invite) continue;
    // Par que acabou levaria a entrada junto: ela passa ao token de um par vivo.
    if (s.ephemeral && !at(s.baseUrl).some((q) => q.token === s.token)) servers[i] = s = { ...s, token: p.token };
    if (s.token !== p.token) attach.push({ entry: s, token: p.token });
  }
  return { servers, attach };
}

/** Pares que sumiram entre duas leituras de `/api/external-pairs` sem terem sido desfeitos aqui:
 * "<dono> saiu do pareamento". Consome de `leaving` (`alias::sessão`) a marca de quem sumiu. */
export function pairsLeft(before: ExternalPair[], now: ExternalPair[], leaving: Set<string>): ExternalPair[] {
  const key = (p: ExternalPair) => `${p.alias}::${p.session}`;
  const live = new Set(now.map(key));
  return before.filter((p) => !live.has(key(p)) && !leaving.delete(key(p)));
}

/** Pares de fora da linha; servidor antigo manda só `pair_external`, sem nível (= ver e recado). */
export function pairExternals(s: PairFields): PairExternal[] {
  if (s.pair_externals) return s.pair_externals;
  const o = s.pair_external;
  if (!o) return [];
  return [{ alias: o.alias, owner: o.owner, session: o.session, address: o.address ?? '',
    level: o.level === 'full' ? 'full' : 'view', pending: o.pending === true }];
}

/** Tira a sessão de fora da entrada de convite e a põe no grupo local, no servidor do grupo.
 * Entradas temporárias nunca viram seção. */
export function placeExternalRows(agg: { rows: AggSession[]; byServer: ServerBucket[] }): { rows: AggSession[]; byServer: ServerBucket[] } {
  const where = new Map<string, { bucket: number; local: AggSession; pair: PairExternal }>();
  agg.byServer.forEach((b, bucket) => {
    if (b.server.invite) return;
    for (const local of b.sessions) {
      for (const pair of pairExternals(local)) {
        if (pair.address) where.set(`${norm(pair.address)}\n${pair.session}`, { bucket, local, pair });
      }
    }
  });
  if (where.size === 0 && !agg.byServer.some((b) => b.server.ephemeral)) return agg;
  const extra: AggSession[][] = agg.byServer.map(() => []);
  const byServer: ServerBucket[] = [];
  agg.byServer.forEach((b) => {
    if (!b.server.invite) { byServer.push(b); return; }
    const kept: AggSession[] = [];
    for (const row of b.sessions) {
      const hit = where.get(`${norm(b.server.baseUrl)}\n${row.name}`);
      if (!hit) { kept.push(row); continue; }
      extra[hit.bucket].push({ ...row, pair_gid: hit.local.pair_gid ?? null,
        outside: { alias: hit.pair.alias, owner: hit.pair.owner, localServerId: hit.local.serverId, localSession: hit.local.name } });
    }
    if (!b.server.ephemeral) byServer.push(kept.length === b.sessions.length ? b : { ...b, sessions: kept });
  });
  const placed = byServer.map((b) => {
    const i = agg.byServer.indexOf(b);
    return i >= 0 && extra[i].length ? { ...b, sessions: [...b.sessions, ...extra[i]] } : b;
  });
  return { rows: placed.flatMap((b) => b.sessions), byServer: placed };
}

/** Pares com acesso completo entre estas linhas, um por máquina de fora. Linha `pending` não conta:
 * nela o par ainda não foi liberado. */
export function fullPairsByAlias(rows: PairFields[]): { alias: string; owner: string }[] {
  const byAlias = new Map<string, string>();
  for (const s of rows) for (const p of pairExternals(s)) if (p.level === 'full' && !p.pending) byAlias.set(p.alias, p.owner);
  return [...byAlias].map(([alias, owner]) => ({ alias, owner }));
}

/** "Liberar" em lote: acesso completo de cada sessão para cada par. Devolve as falhas como
 * "sessão: motivo", sem parar na primeira. */
export async function grantFull(grants: { name: string; alias: string }[], server?: Server | null): Promise<string[]> {
  const failures: string[] = [];
  for (const g of grants) {
    try { await setPairAccess(g.name, g.alias, 'full', server); }
    catch (e) { failures.push(`${g.name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return failures;
}

export interface ExternalPairSyncOptions {
  /** `GET /api/external-pairs` de um servidor próprio; rejeitar é leitura falha. */
  read(server: Server): Promise<ExternalPair[]>;
  /** Todos os pares vivos: o cliente monta as entradas temporárias e devolve os `attach` pendentes. */
  apply(pairs: ExternalPair[]): PairAttach[];
  attach(entry: Server, token: string): Promise<unknown>;
  /** Par que sumiu sem ter sido desfeito aqui: "<dono> saiu do pareamento". */
  onLeft(pair: ExternalPair): void;
  onAttached?(entry: Server): void;
  now?(): number;
}

const READ_RETRY_MIN_MS = 2_000;
const READ_RETRY_MAX_MS = 60_000;

/** Laço de `/api/external-pairs` dos clientes: os pares nas linhas próprias dizem quando reler, e a
 * leitura (não a linha) diz quando o par acabou — sessão fechada ou lista com problema tiram a linha
 * sem o par ter acabado. Servidor cuja leitura falhou fica com os pares de antes e espera para tentar. */
export function createExternalPairSync(o: ExternalPairSyncOptions) {
  const now = o.now ?? Date.now;
  let byServer = new Map<string, ExternalPair[]>();
  const leaving = new Set<string>();
  const attached = new Set<string>();
  const waits = new Map<string, { delay: number; until: number }>();
  let sig = '';
  let run = 0;

  // Quem tinha par na última leitura é relido mesmo sem linha: é como se sabe que o par acabou.
  function plan(servers: Server[], sessionsOf: (id: string) => readonly SessionInfo[] | null | undefined) {
    const t = now();
    const seen = new Map<string, string>();
    for (const s of servers) {
      if (s.invite) continue;
      const keys = (sessionsOf(s.id) ?? []).flatMap((r) => pairExternals(r).map((p) => `${r.name}|${p.alias}::${p.session}|${p.address}`));
      if (keys.length || byServer.has(s.id)) seen.set(s.id, keys.sort().join(','));
    }
    const own = servers.filter((s) => seen.has(s.id));
    const ready = (id: string) => (waits.get(id)?.until ?? 0) <= t;
    return { own, ready, sig: own.map((s) => `${s.id}${ready(s.id) ? '' : '~'}|${seen.get(s.id)}`).sort().join('\n') };
  }

  async function refresh(servers: Server[], sessionsOf: (id: string) => readonly SessionInfo[] | null | undefined): Promise<void> {
    const p = plan(servers, sessionsOf);
    if (p.sig === sig) return;
    sig = p.sig;
    const mine = ++run;
    const reads = await Promise.all(p.own.map((s) => !p.ready(s.id) ? [s.id, null] as const
      : o.read(s).then((l) => { waits.delete(s.id); return [s.id, l] as const; }, () => {
        const delay = Math.min(READ_RETRY_MAX_MS, (waits.get(s.id)?.delay ?? READ_RETRY_MIN_MS / 2) * 2);
        waits.set(s.id, { delay, until: now() + delay });
        return [s.id, null] as const;
      })));
    if (mine !== run) return;
    const before = p.own.flatMap((s) => byServer.get(s.id) ?? []);
    const next = new Map<string, ExternalPair[]>();
    for (const [id, list] of reads) {
      const keep = list ?? byServer.get(id);
      if (keep?.length) next.set(id, keep);
    }
    byServer = next;
    // A espera nova entra na marca: a lista seguinte só relê quando ela vencer.
    sig = plan(servers, sessionsOf).sig;
    const all = [...next.values()].flat();
    for (const left of pairsLeft(before, all, leaving)) o.onLeft(left);
    // Par que acabou tira a marca do attach dele: um par novo no mesmo token precisa ligar de novo.
    const live = new Set(all.map((x) => x.token));
    for (const k of attached) if (!live.has(k.split('\n')[1])) attached.delete(k);
    for (const a of o.apply(all)) {
      const key = `${a.entry.id}\n${a.token}`;
      if (attached.has(key)) continue;
      attached.add(key);
      o.attach(a.entry, a.token).then(() => o.onAttached?.(a.entry), () => {
        attached.delete(key);
        sig = '';   // a próxima lista tenta ligar de novo
      });
    }
  }

  return {
    refresh,
    /** "Sair"/"Desfazer" feito aqui: o par sumir em seguida não é a outra pessoa saindo. Devolve o
     * desfazer da marca, para quando a saída falhar. */
    markLeaving(alias: string, session: string): () => void {
      const key = `${alias}::${session}`;
      leaving.add(key);
      return () => { leaving.delete(key); };
    },
    /** Pares cuja ponta é esta sessão, pela última leitura: sair do grupo os desfaz para todos. */
    anchored(serverId: string, name: string): ExternalPair[] {
      return (byServer.get(serverId) ?? []).filter((x) => x.local_session === name);
    },
    /** Esquece leituras e esperas; as marcas de saída e de attach continuam. */
    reset() {
      byServer = new Map();
      waits.clear();
      sig = '';
      run++;
    },
  };
}

/** Cabeçalho do grupo: "hangar ↔ casa::hangar (Ana)", um par por máquina de fora. */
export function pairHeaderLabel(label: string, members: PairFields[]): string {
  const seen = new Map<string, PairExternal>();
  for (const s of members) for (const p of pairExternals(s)) seen.set(`${p.alias}::${p.session}`, p);
  if (seen.size === 0) return label;
  return `${label} ↔ ${[...seen].map(([k, p]) => `${k} (${p.owner})`).join(', ')}`;
}
