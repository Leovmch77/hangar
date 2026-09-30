import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureApi, configureDiag } from '@hangar/core';
import type { ChatEvent } from '@hangar/core';
import { chatStore, _resetChatsForTests, filaCount } from './chat';
const servidores = vi.hoisted(() => ({
  lista: [] as { id: string; label: string; baseUrl: string; token: string }[],
}));
vi.mock('./servers', () => ({ useServers: { getState: () => ({ servers: servidores.lista }) } }));

// EventSource falso injetado via configureApi (mesmo padrão de sessions.test.ts)
type FakeES = {
  url: string;
  listeners: Record<string, ((e: { data: string; lastEventId?: string }) => void)[]>;
  close: ReturnType<typeof vi.fn>;
  trigger: (type: string, data: string, lastEventId?: string) => void;
  fail: (error?: unknown) => void;
  readyState: number;
  onerror: ((e: unknown) => void) | null;
};

let created: FakeES[] = [];

function fakeCreateEventSource(url: string): unknown {
  const fake: FakeES = {
    url,
    listeners: {},
    close: vi.fn(),
    trigger(type, data, lastEventId) {
      (this.listeners[type] ?? []).forEach((fn) =>
        fn({ data, ...(lastEventId ? { lastEventId } : {}) }),
      );
    },
    fail(error = new Error('tcp')) {
      this.onerror?.(error);
    },
    readyState: 1,
    onerror: null as ((e: unknown) => void) | null,
  };
  created.push(fake);
  return {
    addEventListener(type: string, fn: (e: never) => void) {
      (fake.listeners[type] ??= []).push(fn as never);
    },
    removeEventListener() {},
    close: fake.close,
    // setter do store escreve AQUI; fake.fail() lê daqui
    get onerror() {
      return fake.onerror;
    },
    set onerror(fn: ((e: unknown) => void) | null) {
      fake.onerror = fn;
    },
    get onopen() {
      return (fake as unknown as { _onopen: ((e: unknown) => void) | null })._onopen ?? null;
    },
    set onopen(fn: ((e: unknown) => void) | null) {
      (fake as unknown as { _onopen: ((e: unknown) => void) | null })._onopen = fn;
      if (fn) (fake.listeners['open'] ??= []).push(fn as never);
    },
    get readyState() {
      return fake.readyState;
    },
  };
}

// fetch falso pro /history — pilha de respostas por ordem de chamada
let historyResponses: ChatEvent[][] = [];
let historyCalls = 0;

function ev(partial: Partial<ChatEvent> & { id: string }): ChatEvent {
  return { kind: 'user_msg', text: partial.id, ts: 1_700_000_000, ...partial } as ChatEvent;
}

beforeEach(() => {
  servidores.lista = [
    { id: 'srv1', label: 'um', baseUrl: 'http://10.0.0.1:8765', token: 'tok' },
    { id: 'srv2', label: 'dois', baseUrl: 'http://10.0.0.2:8765', token: 'tok2' },
  ];
  created = [];
  historyCalls = 0;
  historyResponses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = historyResponses[Math.min(historyCalls, historyResponses.length - 1)] ?? [];
      historyCalls++;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  configureApi({
    getBaseUrl: () => 'http://10.0.0.1:8765',
    getToken: () => 'tok',
    onUnauthorized: () => {},
    origin: null,
    createEventSource: fakeCreateEventSource as never,
  });
});

afterEach(() => {
  configureDiag({ registrar: () => {}, novoReq: () => '' });
  _resetChatsForTests();
  vi.unstubAllGlobals();
});

test('(a) history inicial + message novo via SSE = N+1 com ids únicos', async () => {
  vi.useFakeTimers();
  try {
    const e1 = ev({ id: 'a:1', kind: 'user_msg', text: 'oi' });
    const e2 = ev({ id: 'a:2', kind: 'assistant_msg', text: 'olá' });
    historyResponses = [[e1, e2]];

    const chat = chatStore('srv1', 'sess');
    chat.retain();
    await vi.advanceTimersByTimeAsync(0); // loadHistory + connectSSE
    expect(chat.use.getState().events).toHaveLength(2);
    expect(created).toHaveLength(1);

    const e3 = ev({ id: 'a:3', kind: 'assistant_msg', text: 'terceiro' });
    created[0].trigger('message', JSON.stringify(e3), 'a:3');
    const events = chat.use.getState().events;
    expect(events).toHaveLength(3);
    expect(new Set(events.map((x) => x.id)).size).toBe(3);

    // retomada: a PRÓXIMA conexão (pós-erro) nasce com last_event_id do último transcript —
    // a primeira nunca tem (?last_event_id só entra na reconexão)
    created[0].fail();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(created).toHaveLength(2);
    expect(created[1].url).toContain('last_event_id=a%3A3');

    chat.release();
  } finally {
    vi.useRealTimers();
  }
});

test('confirmação retira apenas o eco da fila e preserva índices no próximo evento', async () => {
  historyResponses = [[ev({ id: 'queued-a' }), ev({ id: 'real' }), ev({ id: 'queued-b' })]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  created[0].trigger('queue_confirmed', JSON.stringify(ev({ id: 'queued-a', queued_confirmed: true })));
  expect(chat.use.getState().events.map(e => e.id)).toEqual(['real', 'queued-b']);
  created[0].trigger('message', JSON.stringify(ev({ id: 'real', text: 'atualizado' })));
  expect(chat.use.getState().events.map(e => e.id)).toEqual(['real', 'queued-b']);
  expect(chat.use.getState().events[0].text).toBe('atualizado');
  created[0].trigger('queue_confirmed', JSON.stringify(ev({ id: 'queued-a', queued_confirmed: true })));
  expect(chat.use.getState().events).toHaveLength(2);
});

test('(b) reset zera tudo e recarrega o history novo', async () => {
  historyResponses = [
    [ev({ id: 'old:1' })],
    [ev({ id: 'new:1' })],
  ];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  expect(chat.use.getState().events[0]?.id).toBe('old:1');

  created[0].trigger('message', JSON.stringify(ev({ id: 'old:2' })), 'old:2');
  expect(chat.use.getState().events).toHaveLength(2);

  created[0].trigger('reset', '{}');
  await tick();
  const s = chat.use.getState();
  expect(s.events).toHaveLength(1);
  expect(s.events[0]?.id).toBe('new:1');
  expect(s.stateEvent).toBeNull();
  expect(s.statusLine).toBeNull();
  expect(s.loading).toBe(false);
  // id do transcript antigo não sobrevive ao reset
  expect(created[0].url).not.toContain('last_event_id=old%3A2');
});

test('(c) preview some quando o assistant_msg real chega', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();

  created[0].trigger('state', JSON.stringify({ session: 'sess', state: 'working' }));
  created[0].trigger('preview', JSON.stringify({ text: 'pensando…', md: true, full: true }));
  expect(chat.use.getState().preview).toBe('pensando…');

  created[0].trigger('preview', JSON.stringify({ text: 'pensando mais', md: true, full: true }));
  expect(chat.use.getState().preview).toBe('pensando mais');

  created[0].trigger(
    'message',
    JSON.stringify(ev({ id: 'm:1', kind: 'assistant_msg', text: 'resposta final' })),
  );
  expect(chat.use.getState().preview).toBe('');
  expect(chat.use.getState().events).toHaveLength(1);
});

test('(c2) preview vazio durante working NÃO apaga a bolha; sair de working apaga', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();

  created[0].trigger('state', JSON.stringify({ session: 'sess', state: 'working' }));
  created[0].trigger('preview', JSON.stringify({ text: 'rascunho' }));
  expect(chat.use.getState().preview).toBe('rascunho');

  // entre ferramentas o extrator manda "" — bolha fica
  created[0].trigger('preview', JSON.stringify({ text: '' }));
  expect(chat.use.getState().preview).toBe('rascunho');

  created[0].trigger('state', JSON.stringify({ session: 'sess', state: 'idle' }));
  expect(chat.use.getState().preview).toBe('');
});

test('(d) message duplicado (mesmo id) não entra; conteúdo novo substitui', async () => {
  historyResponses = [[ev({ id: 'a:1', text: 'v1' })]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();

  // replay do SSE re-emitindo o MESMO id com texto diferente -> substitui, não duplica
  created[0].trigger('message', JSON.stringify(ev({ id: 'a:1', text: 'v2' })));
  let events = chat.use.getState().events;
  expect(events).toHaveLength(1);
  expect(events[0]?.text).toBe('v2');

  created[0].trigger('message', JSON.stringify(ev({ id: 'a:1', text: 'v3' })));
  events = chat.use.getState().events;
  expect(events).toHaveLength(1);
  expect(events[0]?.text).toBe('v3');
});

test('state atualiza statusLine; release fecha o stream', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();

  created[0].trigger(
    'state',
    JSON.stringify({ session: 'sess', state: 'working', status_line: '🤖 modelo' }),
  );
  expect(chat.use.getState().statusLine).toBe('🤖 modelo');

  chat.release();
  expect(created[0].close).toHaveBeenCalled();
});

test('aviso do Codex acompanha o estado sem virar pergunta', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  created[0].trigger('state', JSON.stringify({ session: 'sess', state: 'working', codex_buffering: true }));
  expect(chat.use.getState().stateEvent?.codex_buffering).toBe(true);
  expect(chat.use.getState().stateEvent?.state).toBe('working');
  expect(chat.use.getState().askOpen).toBe(false);
  created[0].trigger('state', JSON.stringify({ session: 'sess', state: 'working', codex_buffering: false }));
  expect(chat.use.getState().stateEvent?.codex_buffering).toBe(false);
  chat.release();
});

test('loadOlder prependa o histórico antigo; sem costura marca unjoinable', async () => {
  historyResponses = [
    [ev({ id: 't:5' }), ev({ id: 't:6' })],
    [ev({ id: 't:1' }), ev({ id: 't:2' }), ev({ id: 't:5' })],
  ];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  expect(chat.use.getState().events).toHaveLength(2);

  chat.loadOlder();
  await tick();
  expect(chat.use.getState().events.map((e) => e.id)).toEqual(['t:1', 't:2', 't:5', 't:6']);
  expect(chat.use.getState().olderFailed).toBe('');

  // segunda busca sem nenhum id em comum -> costura quebrada, avisa
  historyCalls = 99; // fetch devolve a última resposta configurada
  historyResponses[1] = [ev({ id: 'outro:9' })];
  chat.loadOlder();
  await tick();
  expect(chat.use.getState().olderFailed).toBe('unjoinable');
});

test('(e) user_msg da fila (queued-) sai quando o real chega com o mesmo texto', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();

  // cp-send enfileira: backend emite o sintético ANTES do transcript gravar o real
  created[0].trigger(
    'message',
    JSON.stringify(ev({ id: 'queued-42', text: 'oi tudo bem' })),
  );
  expect(chat.use.getState().events).toHaveLength(1);

  // prompt real commitado, texto igual: a bolha sintética é substituída pela real
  created[0].trigger('message', JSON.stringify(ev({ id: 'a:9', text: 'oi tudo bem' })));
  const events = chat.use.getState().events;
  expect(events).toHaveLength(1);
  expect(events[0]?.id).toBe('a:9');
});

test('(f) filaCount conta pending + queued-* e zera quando o real chega', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  const origFetch = global.fetch;
  // send() usa sendInput -> fetch POST; stub pra sucesso
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const p = chat.send('oi tudo bem');
  // eco local já entrou
  expect(chat.use.getState().pending).toHaveLength(1);
  expect(filaCount(chat.use.getState())).toBe(1);
  // sintético queued-* chega com mesmo texto -> pending reconciliado, queued entra
  // restaura fetch falso de history pra não quebrar o SSE trigger, mas mantém send mock
  // o trigger não depende de fetch, só do store
  created[0].trigger('message', JSON.stringify(ev({ id: 'queued-1', text: 'oi tudo bem' })));
  await tick();
  expect(chat.use.getState().pending).toHaveLength(0);
  expect(filaCount(chat.use.getState())).toBe(1);
  // render queued translúcido: events contém queued-*
  expect(chat.use.getState().events.some((e) => e.id.startsWith('queued-'))).toBe(true);
  // real chega -> queued sai, fila zera
  created[0].trigger('message', JSON.stringify(ev({ id: 'a:10', text: 'oi tudo bem' })));
  await tick();
  expect(filaCount(chat.use.getState())).toBe(0);
  expect(chat.use.getState().events.some((e) => e.id.startsWith('queued-'))).toBe(false);
  await p;
  vi.stubGlobal('fetch', origFetch as never);
});

test('onerror fecha e reconecta com backoff crescente', async () => {
  vi.useFakeTimers();
  const registrar = vi.fn();
  configureDiag({ registrar, novoReq: () => 'chat-teste' });
  try {
    historyResponses = [[]];
    const chat = chatStore('srv1', 'sess');
    chat.retain();
    await vi.advanceTimersByTimeAsync(0); // loadHistory + connectSSE

    expect(created).toHaveLength(1);
    created[0].fail(); // erro real: fecha
    expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ evento: 'sse.retentativa', espera_ms: 3000 }), 'http://10.0.0.1:8765');
    expect(created[0].close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000); // primeiro backoff
    expect(created).toHaveLength(2);

    created[1].fail();
    await vi.advanceTimersByTimeAsync(6_000); // backoff dobrou
    expect(created).toHaveLength(3);

    chat.release();
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  { type: 'timeout' }, { type: 'close' }, { type: 'error' },
  { type: 'error', xhrStatus: 408 }, { type: 'error', xhrStatus: 429 },
  { type: 'error', xhrStatus: 503 },
])('fonte fechada por $type/$xhrStatus recupera uma vez sem marcar recusa', async (error) => {
  vi.useFakeTimers();
  try {
    const chat = chatStore('srv1', 'sess');
    chat.retain();
    await vi.advanceTimersByTimeAsync(0);
    const source = created[0];
    source.readyState = 2;
    source.fail(error);
    expect(chat.use.getState().sseRecusado).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    source.fail(error); // repetição atrasada não desloca o timer nem duplica a reconexão.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(created).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(created).toHaveLength(2);
    expect(source.close).toHaveBeenCalledTimes(1);
    chat.release();
  } finally {
    vi.useRealTimers();
  }
});

test.each([400, 401, 403, 404, 405, 410])('HTTP %i mantém recusa visível até retry manual', async (xhrStatus) => {
  vi.useFakeTimers();
  try {
    historyResponses = [[ev({ id: 'recusa:1', text: 'conversa preservada' })]];
    const chat = chatStore('srv1', 'sess');
    chat.retain();
    await vi.advanceTimersByTimeAsync(0);
    const source = created[0];
    source.fail({ type: 'error', xhrStatus });
    expect(chat.use.getState().sseRecusado).toBe(true);
    expect(chat.use.getState().events[0].text).toBe('conversa preservada');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(created).toHaveLength(1);
    chat.retry();
    expect(chat.use.getState().sseRecusado).toBe(false);
    expect(created).toHaveLength(2);
    source.fail({ type: 'error', xhrStatus });
    expect(chat.use.getState().sseRecusado).toBe(false);
    expect(created[1].close).not.toHaveBeenCalled();
    chat.release();
  } finally {
    vi.useRealTimers();
  }
});

test('loadOlder abortado por reset não marca failed (B4)', async () => {
  historyResponses = [[ev({ id: 'a:1' })]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  expect(chat.use.getState().olderFailed).toBe('');
  // forçar o próximo getHistory a rejeitar com AbortError (reset aborta o signal)
  const abortErr = Object.assign(new Error('abort'), { name: 'AbortError' });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(abortErr)),
  );
  chat.loadOlder();
  // simula o reset que aborta o histAbort enquanto loadOlder está em voo
  created[0].trigger('reset', '{}');
  await tick();
  expect(chat.use.getState().olderFailed).toBe('');
});

test('onopen reseta backoff para 3s (B5)', async () => {
  vi.useFakeTimers();
  try {
    historyResponses = [[]];
    const chat = chatStore('srv1', 'sess');
    chat.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);
    created[0].fail();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(created).toHaveLength(2);
    created[1].fail();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(created).toHaveLength(3);
    // conexão 3 abre com sucesso → onopen reseta delay
    created[2].trigger('open', '{}');
    // próxima queda deve usar 3s de novo, não 12s
    created[2].fail();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(created).toHaveLength(4);
    chat.release();
  } finally {
    vi.useRealTimers();
  }
});

test('ask_question via SSE abre o stepper', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  const payload = { questions: [{ header: 'H', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: 'desc' }] }] };
  created[0].trigger('ask_question', JSON.stringify(payload));
  await tick();
  const s = chat.use.getState();
  expect(s.askOpen).toBe(true);
  expect(s.askPayload?.questions).toHaveLength(1);
});

test('pergunta Codex mantém identidade na reconexão e fecha na resolução', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  const payload = { provider: 'codex', request_id: 1, questions: [
    { id: 'choice', header: 'H', question: 'Q?', multiSelect: false, options: [{ label: 'A' }] },
  ] };
  created[0].trigger('ask_question', JSON.stringify(payload));
  const original = chat.use.getState().askPayload;
  chat.closeAsk();
  created[0].trigger('ask_question', JSON.stringify(payload));
  expect(chat.use.getState().askOpen).toBe(false);
  expect(chat.use.getState().askPayload).toBe(original);
  created[0].trigger('ask_question', JSON.stringify({ ...payload, request_id: 2 }));
  expect(chat.use.getState().askOpen).toBe(true);
  expect(chat.use.getState().askPayload?.request_id).toBe(2);
  created[0].trigger('ask_question', 'null');
  expect(chat.use.getState().askOpen).toBe(false);
  expect(chat.use.getState().askPayload).toBeNull();
});

test('preview md flag espelha no store', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  created[0].trigger('preview', JSON.stringify({ text: 'a', md: true }));
  await tick();
  expect(chat.use.getState().previewMd).toBe(true);
  expect(chat.use.getState().preview).toBe('a');
});

test('closeAsk marca askPiDismissed', async () => {
  historyResponses = [[]];
  const chat = chatStore('srv1', 'sess');
  chat.retain();
  await tick();
  const payload = { questions: [{ header: 'H', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: '' }] }] };
  chat.openAsk(payload as never, 't1');
  expect(chat.use.getState().askPiId).toBe('t1');
  expect(chat.use.getState().askOpen).toBe(true);
  chat.closeAsk();
  const s = chat.use.getState();
  expect(s.askOpen).toBe(false);
  expect(s.askPiDismissed).toBe('t1');
  expect(s.askPiId).toBeNull();
});

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('send vai ao servidor da conversa', () => {
  test('sessão de mesmo nome em outra máquina: POST sai para o servidor do store, não para o ativo', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await chatStore('srv2', 'sess').send('oi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://10.0.0.2:8765/api/sessions/sess/input');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok2');
  });

  test('servidor removido: erro visível e nenhum POST cai no ativo', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const chat = chatStore('sumiu', 'sess');
    await expect(chat.send('oi')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chat.use.getState().pending).toHaveLength(0);
  });

  test('rede cai com o POST em voo: erro de envio incerto e nenhuma segunda tentativa', async () => {
    servidores.lista.push({ id: 'srv3', label: 'tres', baseUrl: 'http://10.0.0.3:8765', token: 'tok3' });
    const fetchMock = vi.fn(async () => { throw new TypeError('Network request failed'); });
    vi.stubGlobal('fetch', fetchMock);
    const chat = chatStore('srv3', 'sess');
    const err = await chat.send('oi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).not.toBe('Network request failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chat.use.getState().pending).toHaveLength(0);
  });

  test('recusa HTTP continua como erro com status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"x"}', { status: 404 })));
    const err = await chatStore('srv1', 'sess').send('oi').catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(404);
  });
});
