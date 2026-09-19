import type { AggSession } from './types';

// Regra pura de "posso soltar a sessão origem sobre o alvo pra formar/entrar num grupo?" — as
// telas (Sidebar/Board/Canvas/celular) só desenham o que esta função responde.
export type DropMotivo = 'mesma' | 'outro_servidor' | 'morta' | 'mesmo_grupo' | 'cross_server';
export type DropResultado = { ok: true } | { ok: false; motivo: DropMotivo };

function temPeerRemoto(s: AggSession): boolean {
  return (s.pair_peers ?? []).some((p) => p.includes('::'));
}

export function podeAgrupar(origem: AggSession, alvo: AggSession): DropResultado {
  if (origem.serverId === alvo.serverId && origem.name === alvo.name) return { ok: false, motivo: 'mesma' };
  if (origem.serverId !== alvo.serverId) return { ok: false, motivo: 'outro_servidor' };
  if (origem.state === 'dead' || alvo.state === 'dead') return { ok: false, motivo: 'morta' };
  if (origem.pair_gid != null && origem.pair_gid === alvo.pair_gid) return { ok: false, motivo: 'mesmo_grupo' };
  if (temPeerRemoto(origem) || temPeerRemoto(alvo)) return { ok: false, motivo: 'cross_server' };
  return { ok: true };
}

// Só pair_gid perde o par cross-server (sem gid comum) e o sidecar legado sem gid
// (`_gid_legado`, pair.py:54) — por isso o teste de "tem vínculo" olha os dois campos.
export function podeSair(s: AggSession): boolean {
  return s.pair_gid != null || (s.pair_peers?.length ?? 0) > 0;
}
