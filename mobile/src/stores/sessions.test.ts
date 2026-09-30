import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureApi, configureDiag, _resetRotasForTests } from '@hangar/core';
import { useServers } from './servers';
import { useSessions, _resetSessionsForTests } from './sessions';

// mock SecureStore para useServers não quebrar se load for chamado
vi.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    getItemAsync: async (k: string) => m.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => { m.set(k, v); },
    deleteItemAsync: async (k: string) => { m.delete(k); },
  };
});

// fábrica de EventSource falso injetada via configureApi
type FakeES = {
  url: string;
  opts: Record<string, unknown>;
  listeners: Record<string, ((e: { data: string }) => void)[]>;
  close: ReturnType<typeof vi.fn>;
  trigger: (type: string, data: string) => void;
  onerror: ((e: unknown) => void) | null;
};

let created: FakeES[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function response(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeCreateEventSource(url: string, opts: { withCredentials: boolean; headers?: Record<string, string> }): FakeES & { addEventListener: any; removeEventListener: any; close: any; onerror: any; onopen: any; readyState: number } {
  const fake: FakeES = {
    url,
    opts,
    listeners: {},
    close: vi.fn(),
    onerror: null,
    trigger(type, data) {
      (this.listeners[type] ?? []).forEach((fn) => fn({ data }));
    },
  };
  const wrapper = {
    get url() { return fake.url; },
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      (fake.listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    close: fake.close,
    get onerror() { return fake.onerror; },
    set onerror(fn: ((e: unknown) => void) | null) { fake.onerror = fn; },
    get onopen() { return null; },
    set onopen(_: unknown) {},
    get readyState() { return 1; },
    trigger: fake.trigger.bind(fake),
    listeners: fake.listeners,
    opts: fake.opts,
  } as unknown as FakeES & { addEventListener: any; removeEventListener: any; close: any; onerror: any; onopen: any; readyState: number };
  created.push(wrapper as unknown as FakeES);
  return wrapper as any;
}

beforeEach(() => {
  created = [];
  _resetSessionsForTests();
  _resetRotasForTests();
  fetchMock = vi.fn(async () => response([]));
  vi.stubGlobal('fetch', fetchMock);
  useServers.setState({ servers: [], activeId: null, ready: true });
  configureApi({
    getBaseUrl: () => useServers.getState().active()?.baseUrl ?? '',
    getToken: () => useServers.getState().active()?.token ?? null,
    onUnauthorized: () => {},
    origin: null,
    createEventSource: fakeCreateEventSource as any,
  });
  // um servidor ativo
  const s = { id: 'srv1', label: 'srv1', baseUrl: 'http://localhost:8765', token: 'tok' };
  useServers.setState({ servers: [s], activeId: s.id, ready: true });
});

afterEach(() => {
  configureDiag({ registrar: () => {}, novoReq: () => '' });
  _resetSessionsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('dois retain() = um createEventSource; release dos dois = close() uma vez', async () => {
  const rel1 = useSessions.getState().retain();
  await settle();
  expect(created.length).toBe(1);
  const rel2 = useSessions.getState().retain();
  expect(created.length).toBe(1); // segundo retain não abre novo stream
  // ainda aberto
  expect(created[0].close).not.toHaveBeenCalled();
  rel1();
  expect(created[0].close).not.toHaveBeenCalled(); // ainda tem 1 consumidor
  rel2();
  expect(created[0].close).toHaveBeenCalledTimes(1);
});

test('um message com 2 sessões → order() com 2 slots ordenados como o front (aggregateSessions + sortSessions)', async () => {
  useSessions.getState().retain();
  await settle();
  const es = created[0] as unknown as FakeES & { trigger: (t: string, d: string) => void };
  const payload = JSON.stringify([
    { name: 'beta', state: 'idle', jsonl: '/tmp/beta.jsonl' },
    { name: 'alpha', state: 'awaiting_input', jsonl: '/tmp/alpha.jsonl' },
  ]);
  es.trigger('sessions', payload);
  const ordered = useSessions.getState().order();
  expect(ordered).toHaveLength(2);
  // sortSessions: awaiting_input primeiro, depois alfabético
  expect(ordered.map((s) => s.name)).toEqual(['alpha', 'beta']);
  // rows também deve ter 2
  expect(useSessions.getState().rows).toHaveLength(2);
});

test('mensagem malformada mantém slot carregado e marca offline sem quebrar', async () => {
  useSessions.getState().retain();
  await settle();
  const es = created[0] as unknown as FakeES & { trigger: (t: string, d: string) => void };
  const good = JSON.stringify([{ name: 'x', state: 'idle', jsonl: '/j/x.jsonl' }]);
  es.trigger('sessions', good);
  expect(useSessions.getState().rows).toHaveLength(1);
  es.trigger('sessions', 'not-json');
  // O core conserva o slot carregado, mas tira servidores offline da lista agregada.
  expect(useSessions.getState().byServer[0].loaded).toBe(true);
  expect(useSessions.getState().rows).toHaveLength(0);
  expect(useSessions.getState().byServer[0].error).toBeTruthy();
});

test('backoff respeitado: mudança de activeId não reabre stream em retry; add de servidor abre só o novo', async () => {
  const registrar = vi.fn();
  configureDiag({ registrar, novoReq: () => 'lista-teste' });
  const rel = useSessions.getState().retain();
  await settle();
  expect(created.length).toBe(1);
  const es = created[0] as unknown as FakeES & { trigger: (t: string, d: string) => void; onerror: ((e: unknown) => void) | null };
  // simula queda: dispara onerror → store fecha stream e agenda retry 5s
  (es as unknown as { onerror: (e: unknown) => void }).onerror?.({});
  expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ evento: 'lista.retentativa', espera_ms: 5000 }), 'http://localhost:8765');
  expect(created[0].close).toHaveBeenCalled();
  // em backoff, streams foi removido, mas retryTimer pendente
  expect(created.length).toBe(1);
  // mudança irrelevante (activeId) não deve reabrir
  useServers.setState({ activeId: 'outro' });
  expect(created.length).toBe(1);
  // mudança real: adiciona servidor novo → deve abrir só para o novo
  const s2 = { id: 'srv2', label: 'srv2', baseUrl: 'http://localhost:8766', token: 'tok2' };
  const cur = useServers.getState().servers;
  useServers.setState({ servers: [...cur, s2] });
  await settle();
  expect(created.length).toBe(2);
  expect((created[1] as unknown as { url: string }).url).toContain('localhost:8766');
  rel();
});

test('fundo preserva lista e hidden; volta sincroniza uma vez com refs compartilhadas', async () => {
  const first = [
    { name: 'visible', state: 'idle', jsonl: '/j/visible.jsonl' },
    { name: 'hidden', state: 'idle', jsonl: '/j/hidden.jsonl' },
  ];
  fetchMock.mockResolvedValue(response(first));
  const rel1 = useSessions.getState().retain();
  const rel2 = useSessions.getState().retain();
  await settle();
  useSessions.getState().markDeleting('srv1', 'hidden');
  useSessions.getState().setForeground(false);
  expect(created[0].close).toHaveBeenCalledTimes(1);
  expect(useSessions.getState().rows.map((s) => s.name)).toEqual(['visible']);
  expect(useSessions.getState().byServer[0].error).toBeNull();
  rel1();
  useSessions.getState().reconnect();
  useSessions.getState().refreshServers();
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(created).toHaveLength(1);
  fetchMock.mockResolvedValue(response([...first, { name: 'new', state: 'working', jsonl: '/j/new.jsonl' }]));
  useSessions.getState().setForeground(true);
  useSessions.getState().setForeground(true);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(created).toHaveLength(2);
  expect(useSessions.getState().rows.map((s) => s.name)).toEqual(['visible', 'new']);
  rel2();
  expect(created[1].close).toHaveBeenCalledTimes(1);
});

test('retain no fundo e retorno sem consumidores não conectam', async () => {
  useSessions.getState().setForeground(false);
  const rel = useSessions.getState().retain();
  useSessions.getState().refreshServers();
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(created).toHaveLength(0);
  rel();
  useSessions.getState().setForeground(true);
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  const next = useSessions.getState().retain();
  await settle();
  expect(created).toHaveLength(1);
  next();
});

test('pausa cancela retry; erro tardio do stream fechado não agenda outro', async () => {
  vi.useFakeTimers();
  const rel = useSessions.getState().retain();
  await settle();
  const old = created[0];
  old.onerror?.({});
  useSessions.getState().setForeground(false);
  old.onerror?.({});
  vi.advanceTimersByTime(60_000);
  await settle();
  expect(created).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  useSessions.getState().setForeground(true);
  await settle();
  expect(created).toHaveLength(2);
  old.trigger('sessions', JSON.stringify([{ name: 'late', state: 'idle' }]));
  expect(useSessions.getState().rows).toHaveLength(0);
  rel();
});

test('GET antigo é abortado e não publica lista nem stream após a volta', async () => {
  const old = deferred<Response>();
  fetchMock.mockReturnValueOnce(old.promise);
  const rel = useSessions.getState().retain();
  await settle();
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  useSessions.getState().setForeground(false);
  expect(signal.aborted).toBe(true);
  useSessions.getState().setForeground(true);
  old.resolve(response([{ name: 'late', state: 'idle' }]));
  await settle();
  expect(useSessions.getState().rows).toHaveLength(0);
  expect(created).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  rel();
});

test.each([false, true])('rota antiga é descartada mesmo com retorno antes de resolver: %s', async (resumeEarly) => {
  const route = deferred<Response>();
  const target = { id: 'srv1', label: 'srv1', baseUrl: 'http://10.0.0.1:8765', token: 'tok' };
  useServers.setState({ servers: [target], activeId: target.id });
  fetchMock.mockReturnValueOnce(route.promise);
  const rel = useSessions.getState().retain();
  useSessions.getState().setForeground(false);
  if (resumeEarly) useSessions.getState().setForeground(true);
  route.resolve(response({}));
  await settle();
  if (!resumeEarly) {
    expect(created).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    useSessions.getState().setForeground(true);
  }
  await settle();
  expect(created).toHaveLength(1);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    'http://10.0.0.1:8765/api/peers/identificador',
    'http://10.0.0.1:8765/api/peers/identificador',
    'http://10.0.0.1:8765/api/sessions',
  ]);
  rel();
});

test('troca de token durante GET descarta resposta antiga e usa destino capturado', async () => {
  const old = deferred<Response>();
  fetchMock.mockReturnValueOnce(old.promise);
  const rel = useSessions.getState().retain();
  await settle();
  const target = { ...useServers.getState().servers[0], token: 'new-token' };
  useServers.setState({ servers: [target], activeId: 'other' });
  old.resolve(response([{ name: 'late', state: 'idle' }]));
  await settle();
  expect(useSessions.getState().rows).toHaveLength(0);
  expect(created).toHaveLength(1);
  expect(created[0].url).toContain('token=new-token');
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token');
  rel();
});

test('remoção no fundo conserva outro servidor e retoma um stream por servidor restante', async () => {
  const first = useServers.getState().servers[0];
  const second = { ...first, id: 'srv2', baseUrl: 'http://localhost:8766', token: 'tok2' };
  useServers.setState({ servers: [first, second] });
  fetchMock.mockImplementation(async (url: string) => response([
    { name: url.includes('8766') ? 'second' : 'first', state: 'idle', jsonl: url },
  ]));
  const rel = useSessions.getState().retain();
  await settle();
  expect(created).toHaveLength(2);
  useSessions.getState().setForeground(false);
  useServers.setState({ servers: [second], activeId: second.id });
  expect(useSessions.getState().rows.map((s) => s.name)).toEqual(['second']);
  useSessions.getState().setForeground(true);
  await settle();
  expect(created).toHaveLength(3);
  expect(created[2].url).toContain('localhost:8766');
  expect(fetchMock).toHaveBeenCalledTimes(3);
  rel();
});

test('REST sem rede permite SSE recuperar e erro repetido agenda somente um retry', async () => {
  vi.useFakeTimers();
  fetchMock.mockRejectedValueOnce(new TypeError('offline'));
  const rel = useSessions.getState().retain();
  await settle();
  expect(useSessions.getState().byServer[0].error).toBe('offline');
  expect(created).toHaveLength(1);
  created[0].onerror?.({});
  created[0].onerror?.({});
  vi.advanceTimersByTime(5000);
  await settle();
  expect(created).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  created[1].trigger('sessions', JSON.stringify([{ name: 'back', state: 'working' }]));
  expect(useSessions.getState().rows.map((s) => s.name)).toEqual(['back']);
  expect(useSessions.getState().byServer[0].error).toBeNull();
  rel();
});
