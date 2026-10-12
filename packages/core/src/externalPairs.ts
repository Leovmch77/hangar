// Par externo do lado de quem o tem: a sessão da outra pessoa é lida por uma entrada de convite
// temporária e aparece dentro do grupo local, nunca numa seção própria.
import * as m from './paraglide/messages';
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

/** Cabeçalho do grupo: "hangar ↔ casa::hangar (Ana)", um par por máquina de fora. */
export function pairHeaderLabel(label: string, members: PairFields[]): string {
  const seen = new Map<string, PairExternal>();
  for (const s of members) for (const p of pairExternals(s)) seen.set(`${p.alias}::${p.session}`, p);
  if (seen.size === 0) return label;
  return `${label} ↔ ${[...seen].map(([k, p]) => `${k} (${p.owner})`).join(', ')}`;
}
