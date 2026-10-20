import type { AggSession } from './types';
import { pairExternals } from './externalPairs';

// Cópia em Rust: desktop-native/src/app/grouping.rs. Os casos das duas moram em pairGroups.fixtures.json.

const sessionKey = (session: AggSession) => `${session.serverId}::${session.name}`;

export type GroupMember =
  | { kind: 'here'; server: string; name: string }
  | { kind: 'missing'; server_id: string; name: string }
  | { kind: 'outside'; alias: string; session: string };
export type GlobalGroup = { key: string; label: string; members: GroupMember[] };

type GroupRow = Pick<AggSession, 'serverId' | 'name' | 'pair_gid' | 'pair_owner' | 'pair_peers'>;

/** Identificador da máquina do app. Ausente, vazio ou igual ao de outra máquina não vale: não se adivinha. */
export function identityOf(serverId: string, identities: ReadonlyMap<string, string>): string | undefined {
  const id = identities.get(serverId);
  if (!id) return undefined;
  for (const [other, value] of identities) if (other !== serverId && value === id) return undefined;
  return id;
}

/** Chave do grupo, fora o par antigo: dona + gid entre máquinas, máquina + gid no grupo de uma só. */
export function groupKey(s: GroupRow): string | null {
  if (!s.pair_gid) return null;
  return s.pair_owner ? `fed:${s.pair_owner}/${s.pair_gid}` : `local:${s.serverId}/${s.pair_gid}`;
}

/** Par 1:1 antigo entre máquinas (sem dona): cada uma é o único par da outra, pelo identificador. */
export function legacyPair(a: GroupRow, b: GroupRow, identities: ReadonlyMap<string, string>): boolean {
  const points = (from: GroupRow, to: GroupRow) => {
    if (from.pair_owner || from.pair_peers?.length !== 1 || from.serverId === to.serverId) return false;
    const id = identityOf(to.serverId, identities);
    return !!id && from.pair_peers[0] === `${id}::${to.name}`;
  };
  return points(a, b) && points(b, a);
}

// Ordem de ponto de código, a mesma dos bytes UTF-8 do `sort` de String no Rust; o `sort()` padrão compara UTF-16.
function byCodePoint(a: string, b: string): number {
  const [x, y] = [Array.from(a), Array.from(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (diff) return diff;
  }
  return x.length - y.length;
}

/** Grupos de todas as máquinas do app. Membro citado numa máquina sem conexão aqui vira `missing`; com alguma
 * máquina do app sem identificador válido, quem não aparece fica de fora em vez de virar `missing` por palpite. */
export function groupGlobal(rows: AggSession[], identities: ReadonlyMap<string, string>): GlobalGroup[] {
  const servers = new Set([...identities.keys(), ...rows.map(r => r.serverId)]);
  const known = new Map<string, string>();
  let unresolved = false;
  for (const server of servers) {
    const id = identityOf(server, identities);
    if (id) known.set(id, server); else unresolved = true;
  }
  const sessions = new Map<string, AggSession | null>();
  for (const row of rows) sessions.set(sessionKey(row), sessions.has(sessionKey(row)) ? null : row);

  const keys = new Map<AggSession, string>();
  for (const row of rows) {
    // A linha de fora (convite) chega como membro `outside` pelo par da sessão local.
    if (row.outside || keys.has(row)) continue;
    const address = row.pair_peers?.length === 1 ? row.pair_peers[0] : '';
    const separator = address.indexOf('::');
    const server = separator > 0 ? known.get(address.slice(0, separator)) : undefined;
    const peer = server ? sessions.get(`${server}::${address.slice(separator + 2)}`) : null;
    if (peer && sessions.get(sessionKey(row)) === row && legacyPair(row, peer, identities)) {
      const key = `remote:${JSON.stringify([row, peer].map(sessionKey).sort(byCodePoint))}`;
      keys.set(row, key);
      keys.set(peer, key);
      continue;
    }
    const key = groupKey(row);
    if (key) keys.set(row, key);
  }

  const byKey = new Map<string, AggSession[]>();
  for (const row of rows) {
    const key = keys.get(row);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey].map(([key, members]) => {
    const outside = new Map<string, GroupMember>();
    for (const m of members) {
      for (const p of pairExternals(m)) outside.set(`${p.alias}::${p.session}`, { kind: 'outside', alias: p.alias, session: p.session });
    }
    const missing = new Map<string, GroupMember>();
    for (const m of unresolved ? [] : members) {
      for (const address of m.pair_peers ?? []) {
        const separator = address.indexOf('::');
        const serverId = address.slice(0, separator);
        const name = address.slice(separator + 2);
        if (separator <= 0 || !name || outside.has(address) || known.has(serverId)) continue;
        missing.set(address, { kind: 'missing', server_id: serverId, name });
      }
    }
    return {
      key,
      label: members.map(s => s.pair_task?.trim()).find(Boolean) || members.map(s => s.name).join(', '),
      members: [...members.map((s): GroupMember => ({ kind: 'here', server: s.serverId, name: s.name })), ...missing.values(), ...outside.values()],
    };
  });
}
