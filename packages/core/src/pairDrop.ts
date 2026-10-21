import type { OutsideMark, SessionInfo } from './types';
import { isOrq } from './format';
import { groupKey, identityOf, legacyPair } from './pairGroups';

// Regra pura de "posso soltar a sessão origem sobre o alvo pra formar/entrar num grupo?" — as
// telas (Sidebar/Board/Canvas/celular) só desenham o que esta função responde. Pede só serverId a
// mais que SessionInfo (não AggSession inteiro): o Board só tem serverId na sua linha, sem
// serverLabel/serverColor, e a regra nunca lê esses dois.
type SessaoComServidor = SessionInfo & { serverId: string; outside?: OutsideMark; serverInvite?: boolean };

// A linha de fora entra no grupo pela sessão local que tem o par: o pedido de agrupar vai a ela.
export function pairAnchor<T extends SessaoComServidor>(s: T): T {
  return s.outside ? { ...s, serverId: s.outside.localServerId, name: s.outside.localSession } : s;
}

export type DropReason = 'same' | 'orq' | 'dead' | 'invite' | 'same_group' | 'no_identity' | 'other_owner';
export type DropResult = { ok: true } | { ok: false; reason: DropReason };

// Mesma ordem do `can_pair` do nativo (desktop-native/src/app/grouping.rs); casos em pairGroups.fixtures.json.
// `identities`: máquina do app → identificador (`/api/peers/identificador`). Membro de fora não impede.
export function canPair(de: SessaoComServidor, para: SessaoComServidor, identities: ReadonlyMap<string, string> = new Map()): DropResult {
  const origem = pairAnchor(de);
  const alvo = pairAnchor(para);
  if (origem.serverId === alvo.serverId && origem.name === alvo.name) return { ok: false, reason: 'same' };
  // O grupo da orquestração é montado pelo orq; agrupar a linha dele à mão desfaz a execução.
  if (isOrq(origem) || isOrq(alvo)) return { ok: false, reason: 'orq' };
  if (origem.state === 'dead' || alvo.state === 'dead') return { ok: false, reason: 'dead' };
  // Parear é rota do servidor inteiro do dono; a linha de fora já valeu pela sessão local dela.
  if ((!de.outside && de.serverInvite) || (!para.outside && para.serverInvite)) return { ok: false, reason: 'invite' };
  const chave = groupKey(origem);
  if ((chave && chave === groupKey(alvo)) || legacyPair(origem, alvo, identities)) return { ok: false, reason: 'same_group' };
  const mesmaMaquina = origem.serverId === alvo.serverId;
  // O pedido leva `<identificador>::<nome>` da outra máquina.
  if (!mesmaMaquina && (!identityOf(origem.serverId, identities) || !identityOf(alvo.serverId, identities))) {
    return { ok: false, reason: 'no_identity' };
  }
  // Só grupos da mesma dona se fundem; o grupo de uma máquina só tem ela como dona.
  if (origem.pair_gid && alvo.pair_gid && !(mesmaMaquina && !origem.pair_owner && !alvo.pair_owner)) {
    const dona = (s: SessaoComServidor) => s.pair_owner || identityOf(s.serverId, identities);
    const [a, b] = [dona(origem), dona(alvo)];
    if (!a || !b) return { ok: false, reason: 'no_identity' };
    if (a !== b) return { ok: false, reason: 'other_owner' };
  }
  return { ok: true };
}

// Só pair_gid perde o par cross-server (sem gid comum) e o sidecar legado sem gid
// (`_gid_legado`, pair.py:54) — por isso o teste de "tem vínculo" olha os dois campos.
export function canLeave(s: SessaoComServidor): boolean {
  if (isOrq(s)) return false;
  return s.pair_gid != null || (s.pair_peers?.length ?? 0) > 0;
}
