import type { AggSession } from './types';

// Regra pura de "posso soltar a sessão origem sobre o alvo pra formar/entrar num grupo?" — as
// telas (Sidebar/Board/Canvas/celular) só desenham o que esta função responde.
export type DropReason = 'same' | 'other_server' | 'dead' | 'same_group' | 'cross_server';
export type DropResult = { ok: true } | { ok: false; reason: DropReason };

function temPeerRemoto(s: AggSession): boolean {
  return (s.pair_peers ?? []).some((p) => p.includes('::'));
}

export function canPair(origem: AggSession, alvo: AggSession): DropResult {
  if (origem.serverId === alvo.serverId && origem.name === alvo.name) return { ok: false, reason: 'same' };
  if (origem.serverId !== alvo.serverId) return { ok: false, reason: 'other_server' };
  if (origem.state === 'dead' || alvo.state === 'dead') return { ok: false, reason: 'dead' };
  if (origem.pair_gid != null && origem.pair_gid === alvo.pair_gid) return { ok: false, reason: 'same_group' };
  if (temPeerRemoto(origem) || temPeerRemoto(alvo)) return { ok: false, reason: 'cross_server' };
  return { ok: true };
}

// Só pair_gid perde o par cross-server (sem gid comum) e o sidecar legado sem gid
// (`_gid_legado`, pair.py:54) — por isso o teste de "tem vínculo" olha os dois campos.
export function canLeave(s: AggSession): boolean {
  return s.pair_gid != null || (s.pair_peers?.length ?? 0) > 0;
}
