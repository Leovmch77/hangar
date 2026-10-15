import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureApi, configureDiag, definirArmazem, _resetRotasForTests, estaDesligado, registrarFalha, registrarSucesso, retryAfterMs } from '@hangar/core';
import { prefs } from './prefs';
import * as m from '../paraglide/messages';

const { memory } = vi.hoisted(() => ({ memory: new Map<string, string>() }));
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => memory.get(key),
    set: (key: string, value: string) => { memory.set(key, value); },
    remove: (key: string) => { memory.delete(key); },
  }),
}));
import { useServers } from './servers';
import { useSessions, _resetSessionsForTests, markLeavingPair, setPairNotice } from './sessions';

const avisos: string[] = [];
const cooldownStorage = {
  getItem: (key: string) => prefs.getString(key) ?? null,
  setItem: (key: string, value: string) => prefs.set(key, value),
  removeItem: (key: string) => { prefs.remove(key); },
};

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

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
  memory.clear();
  definirArmazem(cooldownStorage);
  fetchMock = vi.fn(async () => response([]));
  vi.stubGlobal('fetch', fetchMock);
  useServers.setState({ servers: [], activeId: null, ready: true, aviso: null });
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

test('mensagem malformada mantém última lista e mostra erro de dados, não queda de rede', async () => {
  useSessions.getState().retain();
  await settle();
  const es = created[0] as unknown as FakeES & { trigger: (t: string, d: string) => void };
  const good = JSON.stringify([{ name: 'x', state: 'idle', jsonl: '/j/x.jsonl' }]);
  es.trigger('sessions', good);
  expect(useSessions.getState().rows).toHaveLength(1);
  es.trigger('sessions', 'not-json');
  expect(useSessions.getState().byServer[0].loaded).toBe(true);
  expect(useSessions.getState().rows).toHaveLength(1);
  expect(useSessions.getState().byServer[0].error).toBe(m.sessao_erro_servidor());
  expect(estaDesligado('srv1')).toBe(false);
});

test('troca para outro activeId preserva retry; servidor novo abre só a própria conexão', async () => {
  const registrar = vi.fn();
  configureDiag({ registrar, novoReq: () => 'lista-teste' });
  const rel = useSessions.getState().retain();
  await settle();
  expect(created.length).toBe(1);
  const es = created[0] as unknown as FakeES & { trigger: (t: string, d: string) => void; onerror: ((e: unknown) => void) | null };
  // O ativo usa a espera curta em memória, sem prazo persistido.
  (es as unknown as { onerror: (e: unknown) => void }).onerror?.({});
  expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ evento: 'lista.retentativa', espera_ms: 1000 }), 'http://localhost:8765');
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
  vi.advanceTimersByTime(999);
  await settle();
  expect(created).toHaveLength(1);
  vi.advanceTimersByTime(1);
  await settle();
  expect(created).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  created[1].trigger('sessions', JSON.stringify([{ name: 'back', state: 'working' }]));
  expect(useSessions.getState().rows.map((s) => s.name)).toEqual(['back']);
  expect(useSessions.getState().byServer[0].error).toBeNull();
  rel();
});

describe('recusas e recuperação da lista', () => {
  const outageKey = 'hangar_servidores_desligados';
  const repliesKey = 'hangar_servidores_responderam';
  const second = { id: 'srv2', label: 'srv2', baseUrl: 'http://localhost:8766', token: 'tok2' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  });

  async function advance(ms: number) {
    vi.advanceTimersByTime(ms);
    await settle();
  }

  test.each(['REST', 'SSE'])('401 %s remove só o destino não ativo e deixa aviso de token, sem retry', async (transport) => {
    const first = useServers.getState().servers[0];
    useServers.setState({ servers: [first, second] });
    if (transport === 'REST') fetchMock.mockImplementation(async (url: string) => response([], url.includes('8766') ? 401 : 200));
    const rel = useSessions.getState().retain();
    await settle();
    if (transport === 'SSE') created.find((es) => es.url.includes('8766'))!.onerror?.({ xhrStatus: 401 });
    await settle();
    expect(useServers.getState().servers).toEqual([first]);
    expect(useServers.getState().aviso).toEqual({ tipo: 'token', label: second.label });
    expect(created[0].close).not.toHaveBeenCalled();
    const calls = fetchMock.mock.calls.length;
    await advance(1_800_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    rel();
  });

  test('401 antigo não remove token substituído enquanto o GET estava em voo', async () => {
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const rel = useSessions.getState().retain();
    await settle();
    const server = { ...useServers.getState().servers[0], token: 'fresh' };
    useServers.setState({ servers: [server] });
    old.resolve(response({}, 401));
    await settle();
    expect(useServers.getState().servers).toEqual([server]);
    expect(useServers.getState().aviso).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0].url).toContain('token=fresh');
    rel();
  });

  test.each(['REST', 'SSE'])('403 %s conserva servidor/token, esconde sessões velhas e só retenta por ação explícita', async (transport) => {
    const first = useServers.getState().servers[0];
    useServers.setState({ servers: [first, second] });
    fetchMock.mockImplementation(async (url: string) => response([{ name: url.includes('8766') ? 'stale-second' : 'first', state: 'idle' }], transport === 'REST' && url.includes('8766') ? 403 : 200));
    let rel = useSessions.getState().retain();
    await settle();
    if (transport === 'SSE') created.find((es) => es.url.includes('8766'))!.onerror?.({ xhrStatus: 403 });
    expect(useServers.getState().servers).toEqual([first, second]);
    expect(useServers.getState().aviso).toBeNull();
    expect(useSessions.getState().byServer.find((b) => b.server.id === second.id)?.error).toBe(m.lista_acesso_recusado());
    expect(useSessions.getState().rows.some((r) => r.serverId === second.id)).toBe(false);
    expect(estaDesligado(second.id)).toBe(false);
    const callsToSecond = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('8766')).length;
    const calls = callsToSecond();
    useSessions.getState().setForeground(false);
    useSessions.getState().setForeground(true);
    await settle();
    rel();
    rel = useSessions.getState().retain();
    await advance(1_800_000);
    expect(callsToSecond()).toBe(calls);
    fetchMock.mockResolvedValue(response([]));
    useSessions.getState().reconnect();
    await settle();
    expect(callsToSecond()).toBe(calls + 1);
    rel();
  });

  test.each([404, 405])('SSE %s permanece recusado até trocar a credencial', async (status) => {
    const rel = useSessions.getState().retain();
    await settle();
    created[0].onerror?.({ xhrStatus: status });
    await advance(1_800_000);
    expect(created).toHaveLength(1);
    expect(estaDesligado('srv1')).toBe(false);
    useServers.setState({ servers: [{ ...useServers.getState().servers[0], token: 'fresh' }] });
    await settle();
    expect(created).toHaveLength(2);
    rel();
  });

  test.each(['REST', 'SSE'])('401/410 de convite %s encerra sem apagar entrada nem aviso de token', async (transport) => {
    const invite = { ...second, invite: true };
    useServers.setState({ servers: [invite], activeId: null });
    if (transport === 'REST') fetchMock.mockResolvedValue(response({}, 401));
    const rel = useSessions.getState().retain();
    await settle();
    if (transport === 'SSE') created[0].onerror?.({ xhrStatus: 410 });
    await advance(1_800_000);
    expect(useServers.getState().servers).toEqual([{ ...invite, inviteEnded: true }]);
    expect(useServers.getState().aviso).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rel();
  });

  test('ativo espera 1, 2, 4, 8, 16 e 30s sem persistir nem dobrar falha REST + SSE', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    let rel = useSessions.getState().retain();
    await settle();
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      created[index].onerror?.({});
      if (index === 1) {
        rel();
        rel = useSessions.getState().retain();
        await settle();
      }
      await advance(delay - 1);
      expect(created).toHaveLength(index + 1);
      await advance(1);
      expect(created).toHaveLength(index + 2);
      expect(estaDesligado('srv1')).toBe(false);
      expect(prefs.getString(outageKey)).toBeUndefined();
    }
    created.at(-1)!.trigger('ping', '');
    created.at(-1)!.onerror?.({});
    await advance(1000);
    expect(created).toHaveLength(9);
    rel();
  });

  test('inativo sem resposta respeita sequência persistida de 2s até teto de 30min, uma queda por tentativa', async () => {
    useServers.setState({ activeId: null });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const rel = useSessions.getState().retain();
    await settle();
    const delays = [2000, 5000, 30000, 60000, 120000, 240000, 300000, 600000, 1800000, 1800000];
    for (const [index, delay] of delays.entries()) {
      created[index].onerror?.({});
      created[index].onerror?.({});
      expect(retryAfterMs('srv1')).toBe(delay);
      expect(JSON.parse(prefs.getString(outageKey)!).srv1.failures).toBe(Math.min(index + 1, 9));
      await advance(delay - 1);
      expect(created).toHaveLength(index + 1);
      await advance(1);
      expect(created).toHaveLength(index + 2);
    }
    rel();
  });

  test('falha REST já contada não sobe de novo se SSE falhar depois de expirar o prazo', async () => {
    useServers.setState({ activeId: null });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const rel = useSessions.getState().retain();
    await settle();
    await advance(3000);
    created[0].onerror?.({});
    expect(JSON.parse(prefs.getString(outageKey)!).srv1.failures).toBe(1);
    rel();
  });

  test('prazo guardado sobrevive à recarga, pausa e retain; expirar não comprova recuperação', async () => {
    useServers.setState({ activeId: null });
    prefs.set(outageKey, JSON.stringify({ srv1: { failures: 4, retryAt: Date.now() + 60_000 } }));
    let rel = useSessions.getState().retain();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    useSessions.getState().setForeground(false);
    await advance(10_000);
    useSessions.getState().setForeground(true);
    rel();
    rel = useSessions.getState().retain();
    await advance(49_999);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estaDesligado('srv1')).toBe(true);
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(prefs.getString(outageKey)!).srv1.failures).toBe(5);
    rel();
  });

  test('primeira abertura após carregar servidores libera recente, mas retain seguinte conserva nova espera', async () => {
    const first = useServers.getState().servers[0];
    useServers.setState({ servers: [], activeId: null, ready: false });
    prefs.set(outageKey, JSON.stringify(Object.fromEntries([first, second].map((s) => [s.id, { failures: 4, retryAt: Date.now() + 60_000 }]))));
    prefs.set(repliesKey, JSON.stringify({ srv1: Date.now() - 1000 }));
    fetchMock.mockRejectedValue(new TypeError('offline'));
    let rel = useSessions.getState().retain();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    useServers.setState({ servers: [first, second], ready: true });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('8765/api/sessions');
    expect(retryAfterMs('srv1')).toBe(2000);
    expect(retryAfterMs('srv2')).toBe(60_000);
    created[0].onerror?.({});
    rel();
    rel = useSessions.getState().retain();
    await advance(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retryAfterMs('srv1')).toBe(5000);
    rel();
  });

  test('volta tenta ativo/recente na hora, antigo espera; fundo ignora falhas e não grava', async () => {
    const first = useServers.getState().servers[0];
    const third = { ...second, id: 'srv3', baseUrl: 'http://localhost:8767' };
    useServers.setState({ servers: [first, second, third] });
    prefs.set(outageKey, JSON.stringify(Object.fromEntries([first, second, third].map((s) => [s.id, { failures: 4, retryAt: Date.now() + 60_000 }]))));
    prefs.set(repliesKey, JSON.stringify({ srv2: Date.now() - 1000, srv3: Date.now() - 25 * 60 * 60_000 }));
    const late = deferred<Response>();
    fetchMock.mockReturnValueOnce(late.promise);
    const rel = useSessions.getState().retain();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    useSessions.getState().setForeground(false);
    const stored = prefs.getString(outageKey);
    late.reject(new TypeError('late network failure'));
    await settle();
    registrarFalha('srv2');
    expect(prefs.getString(outageKey)).toBe(stored);
    await advance(5000);
    useSessions.getState().setForeground(true);
    await settle();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:8765/api/sessions',
      'http://localhost:8766/api/sessions',
      'http://localhost:8765/api/sessions',
      'http://localhost:8766/api/sessions',
    ]);
    expect(retryAfterMs('srv3')).toBe(55_000);
    rel();
  });

  test.each([false, true])('GET inativo cancelado não grava queda, inclusive se rejeitar após voltar: %s', async (resumeEarly) => {
    useServers.setState({ activeId: null });
    const late = deferred<Response>();
    fetchMock.mockReturnValueOnce(late.promise);
    const rel = useSessions.getState().retain();
    await settle();
    useSessions.getState().setForeground(false);
    if (resumeEarly) useSessions.getState().setForeground(true);
    late.reject(new TypeError('late offline'));
    await settle();
    expect(estaDesligado('srv1')).toBe(false);
    expect(prefs.getString(outageKey)).toBeUndefined();
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(resumeEarly ? 2 : 1);
    fetchMock.mockRejectedValue(new TypeError('offline'));
    if (resumeEarly) useSessions.getState().reconnect();
    else useSessions.getState().setForeground(true);
    await settle();
    expect(retryAfterMs('srv1')).toBe(2000);
    expect(JSON.parse(prefs.getString(outageKey)!).srv1.failures).toBe(1);
    rel();
  });

  test('recarregar módulos restaura o prazo MMKV em vez de iniciar outra tentativa', async () => {
    const server = useServers.getState().servers[0];
    useServers.setState({ activeId: null });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const release = useSessions.getState().retain();
    await settle();
    created[0].onerror?.({});
    release();
    const stored = prefs.getString(outageKey);
    vi.resetModules();
    const core = await import('@hangar/core');
    const reopenedServers = (await import('./servers')).useServers;
    const reopened = await import('./sessions');
    reopenedServers.setState({ servers: [server], activeId: null, ready: true });
    core.definirArmazem(cooldownStorage);
    core.configureApi({
      getBaseUrl: () => '', getToken: () => null, onUnauthorized: () => {}, origin: null,
      createEventSource: fakeCreateEventSource as any,
    });
    const rel = reopened.useSessions.getState().retain();
    await settle();
    expect(prefs.getString(outageKey)).toBe(stored);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(core.retryAfterMs(server.id)).toBe(5000);
    rel();
    reopened._resetSessionsForTests();
  });

  test('máquina recente limita espera a 30s e ping confirma recuperação sem reabrir stream saudável', async () => {
    useServers.setState({ activeId: null });
    registrarSucesso('srv1');
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const rel = useSessions.getState().retain();
    await settle();
    for (const delay of [2000, 5000, 30000, 30000]) {
      created.at(-1)!.onerror?.({});
      expect(retryAfterMs('srv1')).toBe(delay);
      await advance(delay);
    }
    const count = created.length;
    expect(estaDesligado('srv1')).toBe(true);
    created.at(-1)!.trigger('ping', '');
    await settle();
    expect(estaDesligado('srv1')).toBe(false);
    expect(created).toHaveLength(count);
    expect(created.at(-1)!.close).not.toHaveBeenCalled();
    created.at(-1)!.onerror?.({});
    expect(retryAfterMs('srv1')).toBe(2000);
    rel();
  });

  test.each([408, 429, 500])('HTTP %s responde vivo, sem esfriamento; parse/list_error também não são rede', async (status) => {
    useServers.setState({ activeId: null });
    fetchMock.mockResolvedValue(response({}, status));
    const rel = useSessions.getState().retain();
    await settle();
    expect(estaDesligado('srv1')).toBe(false);
    created[0].onerror?.({ xhrStatus: status });
    expect(estaDesligado('srv1')).toBe(false);
    await advance(1000);
    expect(created).toHaveLength(2);
    created[1].trigger('sessions', 'broken-json');
    created[1].trigger('list_error', '{}');
    expect(estaDesligado('srv1')).toBe(false);
    expect(useSessions.getState().byServer[0].error).toBe(m.sessao_erro_servidor());
    rel();
  });

  test('novo ativo sai do prazo antigo sem reabrir o stream saudável do outro', async () => {
    const first = useServers.getState().servers[0];
    useServers.setState({ servers: [first, second] });
    prefs.set(outageKey, JSON.stringify({ srv2: { failures: 9, retryAt: Date.now() + 1_800_000 } }));
    const rel = useSessions.getState().retain();
    await settle();
    expect(created).toHaveLength(1);
    useServers.getState().setActive(second.id);
    await settle();
    expect(created).toHaveLength(2);
    expect(created[0].close).not.toHaveBeenCalled();
    rel();
  });

  test('recuperação externa libera só o timer do destino e remoção/token novo esquecem só sua marca', async () => {
    const first = useServers.getState().servers[0];
    useServers.setState({ servers: [first, second], activeId: null });
    prefs.set(outageKey, JSON.stringify(Object.fromEntries([first, second].map((s) => [s.id, { failures: 4, retryAt: Date.now() + 60_000 }]))));
    const rel = useSessions.getState().retain();
    await settle();
    registrarSucesso('srv1');
    await settle();
    expect(created).toHaveLength(1);
    expect(retryAfterMs('srv2')).toBe(60_000);
    useServers.setState({ servers: [first, { ...second, token: 'new' }] });
    await settle();
    expect(created).toHaveLength(2);
    expect(created[0].close).not.toHaveBeenCalled();
    useServers.getState().remove('srv2');
    expect(estaDesligado('srv2')).toBe(false);
    rel();
  });
});

describe('pares de fora', () => {
  const CASA = 'https://casa.ts.net:8443';
  const pair = (token = 'tp', session = 'web') => ({ local_session: 'api', alias: 'casa', owner: 'Ana', session, address: CASA, token });
  const minha = (externals: unknown[]) => [{ name: 'api', state: 'idle', jsonl: '/j/api.jsonl', pair_gid: 'g1',
    pair_externals: externals }];
  let pares: unknown[];
  let deFora: unknown;
  let encerrado = false;

  beforeEach(() => {
    avisos.length = 0;
    setPairNotice((t) => avisos.push(t));
    encerrado = false;
    pares = [pair()];
    deFora = [{ name: 'web', state: 'working', jsonl: '/c/web.jsonl', guest_kind: 'pair' }];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/external-pairs')) return response(pares);
      if (url.includes('/api/guest/attach')) return response({ ok: true });
      if (url.startsWith(CASA)) return encerrado ? ({ ok: false, status: 410, json: async () => ({}) } as Response) : response(deFora);
      return response(minha([{ alias: 'casa', owner: 'Ana', session: 'web', address: CASA, level: 'view', pending: false }]));
    });
  });

  test('a sessão de fora entra no grupo do servidor próprio, sem seção da entrada temporária', async () => {
    const rel = useSessions.getState().retain();
    for (let i = 0; i < 4; i++) await settle();
    const { rows, byServer } = useSessions.getState();
    expect(byServer.map((b) => b.server.id)).toEqual(['srv1']);
    const web = rows.find((r) => r.name === 'web');
    expect(web?.outside).toMatchObject({ owner: 'Ana', localServerId: 'srv1', localSession: 'api' });
    expect(web?.pair_gid).toBe('g1');
    expect(useServers.getState().servers.find((s) => s.ephemeral)?.token).toBe('tp');
    rel();
  });

  test('segundo par na mesma máquina liga o token dele à entrada que já existe', async () => {
    pares = [pair('t1'), pair('t2', 'docs')];
    const rel = useSessions.getState().retain();
    for (let i = 0; i < 4; i++) await settle();
    const attach = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/guest/attach'));
    expect(attach?.[0]).toContain(CASA);
    expect(JSON.parse(String((attach?.[1] as RequestInit).body))).toEqual({ token: 't2' });
    rel();
  });

  test('par que some entre duas leituras avisa que o dono saiu', async () => {
    const rel = useSessions.getState().retain();
    for (let i = 0; i < 4; i++) await settle();
    pares = [];
    created[0].trigger('sessions', JSON.stringify(minha([])));
    for (let i = 0; i < 4; i++) await settle();
    expect(avisos.some((t) => t.includes('Ana'))).toBe(true);
    expect(useServers.getState().servers.some((s) => s.ephemeral)).toBe(false);
    rel();
  });

  test('quem saiu pelo próprio menu não recebe o aviso', async () => {
    const rel = useSessions.getState().retain();
    for (let i = 0; i < 4; i++) await settle();
    markLeavingPair('casa', 'web');
    pares = [];
    created[0].trigger('sessions', JSON.stringify(minha([])));
    for (let i = 0; i < 4; i++) await settle();
    expect(avisos).toEqual([]);
    rel();
  });

  test('410 na entrada do par marca encerrado e não fica tentando', async () => {
    encerrado = true;
    const rel = useSessions.getState().retain();
    for (let i = 0; i < 4; i++) await settle();
    expect(useServers.getState().servers.find((s) => s.ephemeral)?.inviteEnded).toBe(true);
    expect(created.filter((e) => e.url.startsWith(CASA))).toHaveLength(0);
    rel();
  });
});
