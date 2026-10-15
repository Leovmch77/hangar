import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { reconcilePairEntries } from '@hangar/core';
import type { ExternalPair, LanInfo, PairAttach, Server } from '@hangar/core';

const KEY = 'cp_servers_v1';

type Persisted = { servers: Server[]; activeId: string | null };

function isPersisted(value: unknown): value is Persisted {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (p.activeId === null || typeof p.activeId === 'string')
    && Array.isArray(p.servers)
    && p.servers.every((s: unknown) => {
      if (!s || typeof s !== 'object') return false;
      const server = s as Record<string, unknown>;
      if (!['id', 'label', 'baseUrl', 'token'].every((key) => typeof server[key] === 'string')) return false;
      if (!['disabled', 'invite', 'inviteEnded', 'removed', 'ephemeral'].every((key) => server[key] === undefined || typeof server[key] === 'boolean')) return false;
      if (server.lan === undefined) return true;
      if (!server.lan || typeof server.lan !== 'object') return false;
      const lan = server.lan as Record<string, unknown>;
      return typeof lan.url === 'string' && typeof lan.id === 'string';
    });
}

const hostLabel = (u: string) => {
  try {
    return new URL(u).hostname.split('.')[0] || u;
  } catch {
    return u;
  }
};

// Por que estes dois avisos existem: as duas formas de perder um servidor eram mudas. A gravação
// no keystore podia falhar (keystore invalidado depois de restaurar backup, disco cheio) com a
// tela seguindo em frente como se tivesse salvo — e no próximo boot o pareamento não estava lá; e
// um 401 apagava o servidor da lista sem uma palavra, deixando "nenhum servidor" no lugar de
// "o token desta máquina não vale mais".
export type AvisoServidores =
  | { tipo: 'persistencia' }
  | { tipo: 'vault_unread' }
  | { tipo: 'token'; label: string };

export interface ServersState {
  servers: Server[];
  activeId: string | null;
  ready: boolean;
  vaultReadable: boolean;
  aviso: AvisoServidores | null;
  load(): Promise<void>;
  add(s: Omit<Server, 'id' | 'label'> & { label?: string }): Server;
  remove(id: string): void;
  setActive(id: string): void;
  active(): Server | null;
  markInvalid(id: string): void;
  ensureActive(id: string): boolean;
  limparAviso(): void;
  rememberLan(id: string, lan: LanInfo): void;
  applyPairs(pairs: ExternalPair[]): PairAttach[];
  markEnded(id: string): void;
  ensureOwnActive(): void;
}

// Máquinas desta pessoa: a entrada de convite é da máquina de outra pessoa e não vira escolha.
export const ownServers = (list: Server[]) => list.filter((s) => !s.invite);

// A ativa guardada é sempre uma máquina própria: a entrada do par não é gravada e some ao reabrir.
let lastOwnActive: string | null = null;

export const useServers = create<ServersState>((set, get) => ({
  servers: [],
  activeId: null,
  ready: false,
  vaultReadable: false,
  aviso: null,
  async load() {
    set({ vaultReadable: false });
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      const p: unknown = raw === null ? { servers: [], activeId: null } : JSON.parse(raw);
      if (!isPersisted(p)) throw new Error('invalid_server_vault');
      lastOwnActive = p.activeId;
      set({ servers: p.servers, activeId: p.activeId, ready: true, vaultReadable: true, aviso: null });
    } catch {
      set({ ready: true, vaultReadable: false, aviso: { tipo: 'vault_unread' } });
    }
  },
  add({ baseUrl, token, label }) {
    const base = baseUrl.replace(/\/+$/, '');
    // Só máquina própria troca o token: a entrada do par no mesmo endereço tem o token de convidado.
    const existing = get().servers.find((s) => s.baseUrl === base && !s.invite);
    const s: Server = existing
      ? { ...existing, token }
      : { id: `s_${Date.now().toString(36)}`, label: label ?? hostLabel(base), baseUrl: base, token };
    const servers = existing ? get().servers.map((x) => (x.id === s.id ? s : x)) : [...get().servers, s];
    void persistir(set, get, { servers, activeId: s.id });
    set({ servers, activeId: s.id });
    return s;
  },
  remove(id) {
    const servers = get().servers.filter((s) => s.id !== id);
    const activeId = get().activeId === id ? (ownServers(servers)[0]?.id ?? null) : get().activeId;
    void persistir(set, get, { servers, activeId });
    set({ servers, activeId });
  },
  setActive(id) {
    void persistir(set, get, { servers: get().servers, activeId: id });
    set({ activeId: id });
  },
  active() {
    return get().servers.find((s) => s.id === get().activeId) ?? null;
  },
  markInvalid(id) {
    // Convite recusado é par/compartilhamento que acabou, não máquina a remover.
    if (get().servers.find((s) => s.id === id)?.invite) { get().markEnded(id); return; }
    const label = get().servers.find((s) => s.id === id)?.label ?? '';
    get().remove(id);
    set({ aviso: { tipo: 'token', label } });
  },
  ensureActive(id) {
    if (!get().servers.some((s) => s.id === id)) return false;
    if (get().activeId !== id) get().setActive(id);
    return true;
  },
  limparAviso() {
    set({ aviso: null });
  },
  applyPairs(pairs) {
    const { servers, attach } = reconcilePairEntries(get().servers, pairs, () => `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    const activeId = servers.some((s) => s.id === get().activeId) ? get().activeId : lastOwnActive;
    set({ servers, activeId });
    return attach;
  },
  ensureOwnActive() {
    const list = get().servers;
    if (!list.find((s) => s.id === get().activeId)?.invite) return;
    const own = list.find((s) => s.id === lastOwnActive && !s.invite) ?? list.find((s) => !s.invite);
    if (own) set({ activeId: own.id });
  },
  markEnded(id) {
    set({ servers: get().servers.map((s) => (s.id === id && s.invite ? { ...s, inviteEnded: true } : s)) });
  },
  rememberLan(id, lan) {
    const servers = get().servers.map((s) => (s.id === id ? { ...s, lan } : s));
    void persistir(set, get, { servers, activeId: get().activeId });
    set({ servers });
  },
}));

// A escrita continua sem `await` nos chamadores de propósito — a tela não deve travar esperando o
// keystore. O que mudou é que a falha vira estado, em vez de sumir num catch vazio: o estado em
// memória segue certo, a pessoa é avisada de que aquilo não sobreviveu a fechar o app, e não
// descobre isso só no próximo boot com a lista vazia.
function persistir(set: (p: Partial<ServersState>) => void, get: () => ServersState, p: Persisted): Promise<void> {
  if (!get().vaultReadable) {
    set({ aviso: { tipo: 'vault_unread' } });
    return Promise.resolve();
  }
  const servers = p.servers.filter((s) => !s.ephemeral);
  if (servers.some((s) => s.id === p.activeId) || p.activeId === null) lastOwnActive = p.activeId;
  const salvo: Persisted = { servers, activeId: servers.some((s) => s.id === lastOwnActive) ? lastOwnActive : (servers[0]?.id ?? null) };
  return SecureStore.setItemAsync(KEY, JSON.stringify(salvo)).catch(() => {
    set({ aviso: { tipo: 'persistencia' } });
  });
}
