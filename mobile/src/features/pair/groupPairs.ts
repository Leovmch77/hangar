import { canPair, groupGlobal, pairExternals, type AggSession, type State } from '@hangar/core';

/** Membro de fora (`alias::sessao`) é aberto pela entrada do par, não pelo servidor do grupo. */
export function outsideRow(rows: AggSession[], peer: string): AggSession | null {
  return rows.find((r) => r.outside && `${r.outside.alias}::${r.name}` === peer) ?? null;
}

// Cópia do `split_code` do nativo (desktop-native/src/app/grouping.rs): "ABC-12 tela" → "ABC-12".
export function ticketCode(task: string | null | undefined): string | null {
  return task?.match(/^[A-Za-z][A-Za-z0-9_.]*-\d+(?![A-Za-z0-9_])/)?.[0] ?? null;
}

/** Selo do grupo na linha: entre máquinas leva o ticket ou o número de máquinas, como o nativo. */
export function groupBadge(s: AggSession): { text: string | null; machines: number } | null {
  const peers = s.pair_peers ?? [];
  if (!peers.length) return null;
  const outside = new Set(pairExternals(s).map((p) => `${p.alias}::${p.session}`));
  const servers = new Set(peers.filter((p) => p.indexOf('::') > 0 && !outside.has(p)).map((p) => p.slice(0, p.indexOf('::'))));
  if (s.pair_owner || servers.size) return { text: ticketCode(s.pair_task), machines: servers.size + 1 };
  // o rótulo do grupo (ex.: o ticket) diz mais que o nome do par; sem ele, o par ou o tamanho
  return { text: s.pair_task ?? (peers.length === 1 ? peers[0] : String(peers.length + 1)), machines: 1 };
}

export const pickKey = (serverId: string, name: string) => `${serverId}::${name}`;

export type Candidate = { key: string; row: AggSession; refusal: 'other_owner' | null };
export type MachineCandidates = { serverId: string; label: string; status: 'loading' | 'no_identity' | 'ready'; candidates: Candidate[] };

/** Candidatas por máquina para entrar no grupo de `current`. Máquina sem identificador lido não lista ninguém. */
export function pairCandidates(
  current: AggSession,
  buckets: Array<{ serverId: string; label: string; rows: AggSession[] }>,
  identities: ReadonlyMap<string, string>,
  loading: ReadonlySet<string>,
): MachineCandidates[] {
  const peers = current.pair_peers ?? [];
  const out: MachineCandidates[] = [];
  for (const { serverId, label, rows } of buckets) {
    const other = serverId !== current.serverId;
    let status: MachineCandidates['status'] = 'ready';
    const candidates: Candidate[] = [];
    for (const row of rows) {
      // par sem gid (sidecar antigo) só aparece em pair_peers
      if (row.outside || (!other && peers.includes(row.name))) continue;
      const verdict = canPair(row, current, identities);
      if (verdict.ok) candidates.push({ key: pickKey(serverId, row.name), row, refusal: null });
      else if (verdict.reason === 'other_owner') candidates.push({ key: pickKey(serverId, row.name), row, refusal: 'other_owner' });
      // na própria máquina só a fusão de grupos pede identificador: some só a linha
      else if (verdict.reason === 'no_identity' && other) status = 'no_identity';
    }
    // identificador ainda em leitura não é recusa
    if (status === 'no_identity' && (loading.has(serverId) || loading.has(current.serverId))) status = 'loading';
    if (status !== 'ready') out.push({ serverId, label, status, candidates: [] });
    else if (candidates.length) out.push({ serverId, label, status, candidates });
  }
  return out;
}

/** Nomes do pedido ao servidor da âncora: outra máquina vai como `<identificador>::<nome>`. */
export function pairTargets(picked: string[], serverId: string, identities: ReadonlyMap<string, string>): string[] {
  return picked.map((key) => {
    const at = key.indexOf('::');
    const server = key.slice(0, at);
    const name = key.slice(at + 2);
    return server === serverId ? name : `${identities.get(server)}::${name}`;
  });
}

export type MemberView = {
  key: string;
  name: string;
  machine: string | null;
  state: State | null;
  // ausente = só texto (máquina sem conexão aqui, ou membro de fora sem entrada)
  target: { server: string; name: string } | null;
  missing: boolean;
};

/** Membros do grupo da sessão aberta, de todas as máquinas, sem ela. Fora do modelo global (par sem gid), `pair_peers`. */
export function groupMembers(serverId: string, name: string, rows: AggSession[], identities: ReadonlyMap<string, string>): MemberView[] {
  const rowOf = (server: string, n: string) => rows.find((r) => !r.outside && r.serverId === server && r.name === n);
  const self = (m: { kind: string; server?: string; name?: string }) => m.kind === 'here' && m.server === serverId && m.name === name;
  const group = groupGlobal(rows, identities).find((g) => g.members.some(self));
  if (!group) {
    return (rowOf(serverId, name)?.pair_peers ?? []).map((peer) => {
      const fora = outsideRow(rows, peer);
      const target = fora ? { server: fora.serverId, name: fora.name } : { server: serverId, name: peer };
      return { key: peer, name: peer, machine: null, state: (fora ?? rowOf(serverId, peer))?.state ?? null, target, missing: false };
    });
  }
  return group.members.filter((m) => !self(m)).map((m): MemberView => {
    if (m.kind === 'here') {
      const row = rowOf(m.server, m.name);
      return { key: pickKey(m.server, m.name), name: m.name, machine: m.server === serverId ? null : row?.serverLabel ?? m.server, state: row?.state ?? null, target: { server: m.server, name: m.name }, missing: false };
    }
    if (m.kind === 'missing') return { key: `missing:${m.server_id}::${m.name}`, name: m.name, machine: m.server_id, state: null, target: null, missing: true };
    const address = `${m.alias}::${m.session}`;
    const fora = outsideRow(rows, address);
    return { key: address, name: address, machine: null, state: fora?.state ?? null, target: fora ? { server: fora.serverId, name: fora.name } : null, missing: false };
  });
}
