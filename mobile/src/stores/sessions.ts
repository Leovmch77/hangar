import { create } from 'zustand';
import { openSessionsStream, aggregateSessions, jsonlDaSessao, sweepHidden, registrarDiag, decidirRota, esquecerRota, rotaDecidida, probeServerResponse, comTeto } from '@hangar/core';
import type { SessionInfo, Server, AggSession } from '@hangar/core';
import { sortSessions } from '@hangar/core';
import type { Slot, ServerBucket, Aggregate } from '@hangar/core';
import { useServers } from './servers';

// Store vivo da lista de sessões — porte de frontend/src/lib/sessionsStore.svelte.ts
// para zustand. Um EventSource por servidor, refcount compartilhado, agregação via
// aggregateSessions (pura) e ordenação via sortSessions.
//
// Watchdog: o adapter mobile/src/net/sse.ts JÁ tem watchdog de 25s (fecha + onerror type
// timeout quando 25s sem evento; ping a cada ~10s rearma via wrap). Duplicar o relógio aqui
// fecharia o MESMO stream duas vezes e dispararia reconexão dupla. Este store CONFIA no
// adapter: não cria timer próprio de inatividade; apenas trata o onerror (inclui timeout do
// adapter) com backoff e rearma via evento 'ping' para que o wrap do adapter re-arme.

export interface SessionsState {
  rows: AggSession[];
  byServer: ServerBucket[];
  // conveniência para o que a Task descreve como Record<serverId, SessionInfo[]>
  byServerRecord: Record<string, AggSession[]>;
  loading: boolean;
  servers: Server[];
  retain: () => () => void;
  release: () => void;
  order: () => AggSession[];
  reconnect: () => void;
  setForeground: (active: boolean) => void;
  refreshServers: () => void;
  markDeleting: (serverId: string, name: string) => void;
  unmarkDeleting: (serverId: string, name: string) => void;
}

// internas — fora do set() para não virar proxy
const slots = new Map<string, Slot>();
const streams = new Map<string, ReturnType<typeof openSessionsStream>>();
type ConnectionAttempt = { server: Server; generation: number; abort: AbortController };
const connecting = new Map<string, ConnectionAttempt>();
const retryDelays = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let hidden = new Map<string, string | null>();
let serversCache: Server[] = [];
let refs = 0;
let foreground = true;
let generation = 0;
let unsubServers: (() => void) | null = null;
let aggCache: Aggregate = { rows: [], byServer: [], loading: false };

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

function hasServer(server: Server) {
  return serversCache.some((s) => s.id === server.id && s.baseUrl === server.baseUrl && s.token === server.token);
}

function isCurrent(attempt: ConnectionAttempt) {
  return foreground && refs > 0 && attempt.generation === generation && !attempt.abort.signal.aborted && hasServer(attempt.server);
}

function disconnect(id: string) {
  const stream = streams.get(id);
  streams.delete(id);
  stream?.close();
  clearTimeout(retryTimers.get(id));
  retryTimers.delete(id);
  retryDelays.delete(id);
  connecting.get(id)?.abort.abort();
  esquecerRota(id);
}

function pause() {
  generation++;
  for (const id of new Set([...streams.keys(), ...retryTimers.keys(), ...connecting.keys()])) disconnect(id);
}

function scheduleRetry(id: string, get: () => SessionsState, set: (p: Partial<SessionsState>) => void) {
  if (!foreground || refs === 0 || retryTimers.has(id)) return;
  const delay = retryDelays.get(id) ?? RETRY_MIN_MS;
  const servidor = serversCache.find((s) => s.id === id);
  if (servidor) registrarDiag({ evento: 'lista.retentativa', tela: 'lista', espera_ms: delay }, servidor.baseUrl);
  retryDelays.set(id, Math.min(delay * 2, RETRY_MAX_MS));
  clearTimeout(retryTimers.get(id));
  retryTimers.set(
    id,
    setTimeout(() => {
      retryTimers.delete(id);
      if (foreground && refs > 0 && serversCache.some((s) => s.id === id)) {
        connect(serversCache, get, set);
      }
    }, delay),
  );
}

function recompute(set: (p: Partial<SessionsState>) => void) {
  hidden = sweepHidden(hidden, slots);
  aggCache = aggregateSessions(serversCache, slots, hidden);
  const byServerRecord: Record<string, AggSession[]> = {};
  for (const b of aggCache.byServer) byServerRecord[b.server.id] = b.sessions;
  set({
    rows: aggCache.rows,
    byServer: aggCache.byServer,
    byServerRecord,
    loading: aggCache.loading,
    servers: serversCache,
  });
}

function connect(list: Server[], get: () => SessionsState, set: (p: Partial<SessionsState>) => void) {
  for (const id of slots.keys()) if (!list.some((s) => s.id === id)) slots.delete(id);
  if (!foreground || refs === 0) { recompute(set); return; }
  for (const s of list) {
    if (streams.has(s.id)) continue;
    if (retryTimers.has(s.id)) continue;
    if (connecting.has(s.id)) continue;
    const attempt = { server: { ...s }, generation, abort: new AbortController() };
    connecting.set(s.id, attempt);
    void synchronize(attempt, get, set);
  }
  recompute(set);
}

async function synchronize(attempt: ConnectionAttempt, get: () => SessionsState, set: (p: Partial<SessionsState>) => void) {
  const s = attempt.server;
  try {
    if (!rotaDecidida(s.id)) await decidirRota(s);
    if (!isCurrent(attempt)) return;
    try {
      const response = await probeServerResponse(s, '/api/sessions', { signal: comTeto(attempt.abort.signal, 4000) });
      if (!response.ok) throw new Error(String(response.status));
      const sessions = await response.json() as SessionInfo[];
      if (!isCurrent(attempt)) return;
      if (!Array.isArray(sessions)) throw new Error('invalid_sessions');
      slots.set(s.id, { sessions, error: null });
      recompute(set);
    } catch (error) {
      if (!isCurrent(attempt)) return;
      registrarDiag({ evento: 'lista.falhou', nivel: 'erro', tela: 'lista', codigo: 'sincronia',
        detalhe: error instanceof Error ? error.name : 'erro' }, s.baseUrl);
      slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
      recompute(set);
    }
    if (!isCurrent(attempt)) return;
    const es = openSessionsStream(s);
    const active = () => isCurrent(attempt) && streams.get(s.id) === es;
    let falhaDados = false;
    // ping mantém o watchdog do adapter vivo (wrap rearma). Sem listener,
    // ping não rearma e o adapter fecharia stream saudável.
    es.addEventListener('ping', () => {});
    es.addEventListener('sessions', (e) => {
      if (!active()) return;
      retryDelays.delete(s.id);
      try {
        slots.set(s.id, { sessions: JSON.parse(e.data) as SessionInfo[], error: null });
        if (falhaDados) registrarDiag({ evento: 'lista.voltou', tela: 'lista' }, s.baseUrl);
        falhaDados = false;
      } catch {
        falhaDados = true;
        registrarDiag({ evento: 'lista.falhou', nivel: 'erro', tela: 'lista', codigo: 'json_invalido' }, s.baseUrl);
        slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
      }
      recompute(set);
    });
    es.addEventListener('list_error', () => {
      if (!active()) return;
      falhaDados = true;
      registrarDiag({ evento: 'lista.falhou', nivel: 'erro', tela: 'lista', codigo: 'produtor_falhou' }, s.baseUrl);
      // resposta viva, só list falhou — mantém última lista boa, marca erro distinto
      // mas também consideramos como sinal de vida para não derrubar por watchdog
      // (o adapter já rearmou via wrap)
      slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
      recompute(set);
    });
    es.onerror = () => {
      if (!active()) return;
      slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
      recompute(set);
      streams.delete(s.id);
      es.close();
      esquecerRota(s.id);
      scheduleRetry(s.id, get, set);
    };
    streams.set(s.id, es);
  } catch (error) {
    if (!isCurrent(attempt)) return;
    registrarDiag({ evento: 'lista.falhou', nivel: 'erro', tela: 'lista', codigo: 'conexao',
      detalhe: error instanceof Error ? error.name : 'erro' }, s.baseUrl);
    slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
    recompute(set);
    esquecerRota(s.id);
    scheduleRetry(s.id, get, set);
  } finally {
    if (connecting.get(s.id) === attempt) {
      connecting.delete(s.id);
      if (!isCurrent(attempt)) {
        // A decisão compartilhada de rota não aceita abort; só a geração atual pode usá-la.
        esquecerRota(s.id);
        if (foreground && refs > 0) connect(serversCache, get, set);
      }
    }
  }
}

function start(get: () => SessionsState, set: (p: Partial<SessionsState>) => void) {
  serversCache = useServers.getState().servers.slice();
  connect(serversCache, get, set);
  // observa mudanças de servidores (useServers é zustand)
  unsubServers = useServers.subscribe((state) => {
    const next = (state as unknown as { servers: Server[] }).servers;
    const igual =
      next.length === serversCache.length &&
      next.every((s, i) => s.id === serversCache[i]?.id && s.baseUrl === serversCache[i]?.baseUrl && s.token === serversCache[i]?.token);
    const previous = serversCache;
    serversCache = next.slice();
    if (igual) return;
    for (const s of previous) if (!hasServer(s)) disconnect(s.id);
    connect(serversCache, get, set);
  });
}

function stop(set: (p: Partial<SessionsState>) => void) {
  unsubServers?.();
  unsubServers = null;
  pause();
  slots.clear();
  // hidden mantém? Não — limpa ao parar para próximo retain começar limpo
  hidden = new Map<string, string | null>();
  recompute(set);
}

export const useSessions = create<SessionsState>((set, get) => ({
  rows: [],
  byServer: [],
  byServerRecord: {},
  loading: false,
  servers: [],
  retain() {
    if (++refs === 1) start(get, set);
    // retorna release para uso como cleanup de useEffect
    return () => get().release();
  },
  release() {
    if (refs > 0 && --refs === 0) stop(set);
  },
  order() {
    return sortSessions(get().rows);
  },
  reconnect() {
    if (refs === 0 || !foreground) return;
    pause();
    connect(serversCache, get, set);
  },
  setForeground(active) {
    if (active === foreground) return;
    foreground = active;
    if (!active) pause();
    else get().reconnect();
  },
  refreshServers() {
    const previous = serversCache;
    serversCache = useServers.getState().servers.slice();
    for (const s of previous) if (!hasServer(s)) disconnect(s.id);
    connect(serversCache, get, set);
  },
  markDeleting(serverId: string, name: string) {
    hidden.set(`${serverId}::${name}`, jsonlDaSessao(slots, serverId, name));
    recompute(set);
  },
  unmarkDeleting(serverId: string, name: string) {
    hidden.delete(`${serverId}::${name}`);
    recompute(set);
  },
}));

// expõe reset apenas para testes (isso não vai para produção)
export function _resetSessionsForTests() {
  pause();
  connecting.clear();
  foreground = true;
  retryTimers.clear();
  retryDelays.clear();
  streams.clear();
  slots.clear();
  hidden = new Map<string, string | null>();
  serversCache = [];
  aggCache = { rows: [], byServer: [], loading: false };
  refs = 0;
  unsubServers?.();
  unsubServers = null;
  useSessions.setState({ rows: [], byServer: [], byServerRecord: {}, loading: false, servers: [] });
}
