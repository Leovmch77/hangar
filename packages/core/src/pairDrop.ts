import type { OutsideMark, SessionInfo } from './types';
import { isOrq } from './format';
import { pairExternals } from './externalPairs';

// Regra pura de "posso soltar a sessão origem sobre o alvo pra formar/entrar num grupo?" — as
// telas (Sidebar/Board/Canvas/celular) só desenham o que esta função responde. Pede só serverId a
// mais que SessionInfo (não AggSession inteiro): o Board só tem serverId na sua linha, sem
// serverLabel/serverColor, e a regra nunca lê esses dois.
type SessaoComServidor = SessionInfo & { serverId: string; outside?: OutsideMark };

// Membro de fora (par externo) também vem como `alias::sessao`, mas grupo misto é permitido.
function temPeerRemoto(s: SessaoComServidor): boolean {
  const fora = new Set(pairExternals(s).map((p) => `${p.alias}::${p.session}`));
  return (s.pair_peers ?? []).some((p) => p.includes('::') && !fora.has(p));
}

// A linha de fora entra no grupo pela sessão local que tem o par: o pedido de agrupar vai a ela.
export function pairAnchor<T extends SessaoComServidor>(s: T): T {
  return s.outside ? { ...s, serverId: s.outside.localServerId, name: s.outside.localSession } : s;
}

export type DropReason = 'same' | 'other_server' | 'dead' | 'same_group' | 'cross_server' | 'orq';
export type DropResult = { ok: true } | { ok: false; reason: DropReason };

export function canPair(de: SessaoComServidor, para: SessaoComServidor): DropResult {
  const origem = pairAnchor(de);
  const alvo = pairAnchor(para);
  if (origem.serverId === alvo.serverId && origem.name === alvo.name) return { ok: false, reason: 'same' };
  // O grupo da orquestração é montado pelo orq; agrupar a linha dele à mão desfaz a execução.
  if (isOrq(origem) || isOrq(alvo)) return { ok: false, reason: 'orq' };
  if (origem.serverId !== alvo.serverId) return { ok: false, reason: 'other_server' };
  if (origem.state === 'dead' || alvo.state === 'dead') return { ok: false, reason: 'dead' };
  if (origem.pair_gid != null && origem.pair_gid === alvo.pair_gid) return { ok: false, reason: 'same_group' };
  if (temPeerRemoto(origem) || temPeerRemoto(alvo)) return { ok: false, reason: 'cross_server' };
  return { ok: true };
}

// Só pair_gid perde o par cross-server (sem gid comum) e o sidecar legado sem gid
// (`_gid_legado`, pair.py:54) — por isso o teste de "tem vínculo" olha os dois campos.
export function canLeave(s: SessaoComServidor): boolean {
  if (isOrq(s)) return false;
  return s.pair_gid != null || (s.pair_peers?.length ?? 0) > 0;
}
