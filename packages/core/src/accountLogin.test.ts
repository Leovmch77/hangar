import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi } from './apiEnv';
import { _limparEsfriamentoParaTestes } from './esfriamento';
import { cancelClaudeAccountLoginForServer, getClaudeAccountLoginStepForServer,
  startClaudeAccountLoginForServer, submitClaudeAccountLoginCodeForServer } from './index';

const server = { id: 'b', label: 'B', baseUrl: 'https://b.test', token: 'token-b' };
const unauthorized = vi.fn();

beforeEach(() => {
  configureApi({ getBaseUrl: () => 'https://a.test', getToken: () => 'token-a',
    onUnauthorized: unauthorized, origin: null, createEventSource: () => { throw new Error('unused'); } });
  unauthorized.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _limparEsfriamentoParaTestes();
});

const actions = [
  { name: 'início', request: () => startClaudeAccountLoginForServer(server, 'work'), timeout: 30_000 },
  { name: 'passo', request: () => getClaudeAccountLoginStepForServer(server, 'work'), timeout: 10_000 },
  { name: 'código', request: () => submitClaudeAccountLoginCodeForServer(server, 'work', 'code'), timeout: 310_000 },
  { name: 'cancelamento', request: () => cancelClaudeAccountLoginForServer(server, 'work'), timeout: 15_000 },
];

function pendingFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
}

describe('login Claude por servidor', () => {
  it('inicia no servidor capturado com o rótulo codificado e bearer próprio', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await expect(startClaudeAccountLoginForServer(server, 'work /')).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith('https://b.test/api/conta-estado/work%20%2F/login', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer token-b' }),
      signal: expect.any(AbortSignal),
    }));
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it.each(['idle', 'aguardando', 'concluido'] as const)('lê o passo %s com os campos do servidor', async (etapa) => {
    const step = { etapa, url: etapa === 'aguardando' ? 'https://claude.ai/login' : null,
      email: etapa === 'concluido' ? 'user@example.test' : null, plano: etapa === 'concluido' ? 'max' : null };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(step));

    await expect(getClaudeAccountLoginStepForServer(server, 'work /')).resolves.toEqual(step);

    expect(fetcher).toHaveBeenCalledWith('https://b.test/api/conta-estado/work%20%2F/login/passo', expect.objectContaining({
      method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer token-b' }),
    }));
  });

  it('envia o código no corpo e preserva email e plano confirmados', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      ok: true, email: 'user@example.test', plano: 'max',
    }));

    await expect(submitClaudeAccountLoginCodeForServer(server, 'work /', 'code/?#')).resolves.toEqual({
      ok: true, email: 'user@example.test', plano: 'max',
    });

    expect(fetcher).toHaveBeenCalledWith('https://b.test/api/conta-estado/work%20%2F/login/codigo', expect.objectContaining({
      method: 'POST', body: '{"codigo":"code/?#"}',
      headers: expect.objectContaining({ Authorization: 'Bearer token-b', 'Content-Type': 'application/json' }),
    }));
  });

  it('cancela no servidor capturado sem inventar attempt_id', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));

    await expect(cancelClaudeAccountLoginForServer(server, 'work /')).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith('https://b.test/api/conta-estado/work%20%2F/login/cancelar', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer token-b' }),
    }));
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
  });

  it.each(actions)('401 no $name de B preserva a credencial de A e informa status e causa', async ({ request }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ detail: 'token de B recusado' }, { status: 401 }));

    await expect(request()).rejects.toMatchObject({ status: 401, message: '401: token de B recusado' });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('preserva a causa de um erro HTTP sem JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('janela indisponível', { status: 503 }));

    await expect(submitClaudeAccountLoginCodeForServer(server, 'work', 'code')).rejects.toMatchObject({
      status: 503, message: '503: janela indisponível',
    });
  });

  it.each([null, false, {}, { ok: false, erro: 'login recusado' }, { erro: 'janela fechada' },
    { ok: 'true' }, { ok: true, email: 42 }])('não confirma uma resposta inválida: %j', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));

    await expect(startClaudeAccountLoginForServer(server, 'work')).rejects.toMatchObject({ status: 200 });
  });

  it.each(actions.filter(({ name }) => name !== 'passo'))('rejeita ok falso no $name sem esconder a causa', async ({ request }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: false, erro: 'janela fechada' }));

    await expect(request()).rejects.toMatchObject({ status: 200, message: expect.stringContaining('janela fechada') });
  });

  it('não confirma corpo que não é JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('resposta inválida'));

    await expect(startClaudeAccountLoginForServer(server, 'work')).rejects.toMatchObject({
      status: 200, message: '200: resposta inválida',
    });
  });

  it.each([null, {}, { etapa: 'erro', url: null, email: null, plano: null },
    { etapa: 'concluido', email: null, plano: null },
    { etapa: 'concluido', url: null, email: 42, plano: null }])('rejeita um passo fora do contrato: %j', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));

    await expect(getClaudeAccountLoginStepForServer(server, 'work')).rejects.toMatchObject({ status: 200 });
  });

  it.each([false, true])('respeita cancelamento da leitura, inclusive já cancelada: %s', async (cancelledBefore) => {
    const fetcher = pendingFetch();
    const controller = new AbortController();
    const reason = new DOMException('troca de tela', 'AbortError');
    if (cancelledBefore) controller.abort(reason);
    const result = getClaudeAccountLoginStepForServer(server, 'work', controller.signal);
    const rejected = expect(result).rejects.toBe(reason);

    if (!cancelledBefore) controller.abort(reason);

    await rejected;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('preserva o cancelamento depois dos cabeçalhos, durante a leitura do JSON', async () => {
    const controller = new AbortController();
    const reason = new DOMException('troca de tela', 'AbortError');
    let abortBody: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"etapa":'));
        abortBody = () => stream.error(reason);
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => abortBody(), { once: true });
      return new Response(body);
    });
    const result = getClaudeAccountLoginStepForServer(server, 'work', controller.signal);
    const rejected = expect(result).rejects.toBe(reason);
    await vi.waitFor(() => expect(body.locked).toBe(true));

    controller.abort(reason);

    await rejected;
  });

  it.each(actions)('mantém $name pendente até seu prazo e aborta ao atingir $timeout ms', async ({ request, timeout }) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('prazo esgotado', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetcher = pendingFetch();
    const result = request();
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    const signal = fetcher.mock.calls[0][1]?.signal;

    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(signal?.aborted).toBe(true);
  });
});
