import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { criarPanePoller, type PaneSnapshot } from './usePanePoll';
import { configureApi, getPane as fetchPane, type Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

const server: Server = { id: 'a', label: 'A', baseUrl: 'https://a.test', token: 'token-a' };

// Conta quantas vezes o TEXTO mudou (o diff-gate existe pra isso não subir a cada tick).
function espiao() {
  const vistos: PaneSnapshot[] = [];
  let ultimo = '';
  let mudancas = 0;
  return {
    vistos,
    onSnapshot: (s: PaneSnapshot) => {
      vistos.push(s);
      if (s.text !== ultimo) { ultimo = s.text; mudancas++; }
    },
    get mudancas() { return mudancas; },
    get atual() { return vistos[vistos.length - 1]; },
  };
}

describe('criarPanePoller — porte de TerminalMirror.svelte:75-100', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('primeiro tick pinta', async () => {
    const getPane = vi.fn(async () => ({ text: 'ola', scrollback: 10 }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(e.atual.text).toBe('ola');
    expect(e.atual.scrollback).toBe(10);
    expect(e.atual.err).toBe('');
    p.stop();
  });

  it('a leitura e o refresh ficam no servidor A mesmo com B ativo', async () => {
    configureApi({ getBaseUrl: () => 'https://b.test', getToken: () => 'token-b', onUnauthorized: () => {},
      origin: null, createEventSource: () => { throw new Error('unexpected SSE'); } });
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'A', scrollback: 0 }) });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
    const e = espiao();
    const p = criarPanePoller(fetchPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await p.refresh();
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://a.test/api/sessions/sess/pane?lines=200');
      expect(init.headers.Authorization).toBe('Bearer token-a');
    }
    p.stop();
  });

  it('sem servidor não lê nem inicia outro tick, inclusive no refresh', async () => {
    const getPane = vi.fn();
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, null);
    p.start();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p.refresh()).rejects.toThrow(m.servidor_nao_existe());
    expect(getPane).not.toHaveBeenCalled();
    expect(e.atual.err).toBe(m.servidor_nao_existe());
    expect(vi.getTimerCount()).toBe(0);
    p.stop();
  });

  it('texto igual não re-renderiza (contador de publicações)', async () => {
    let ret = 'mesmo';
    const getPane = vi.fn(async () => ({ text: ret, scrollback: 0 }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(e.mudancas).toBe(1);
    expect(e.vistos.length).toBe(1);
    await vi.advanceTimersByTimeAsync(450);
    expect(getPane).toHaveBeenCalledTimes(2);
    expect(e.mudancas).toBe(1);
    expect(e.vistos.length).toBe(1);   // tick sem mudança não publica nada
    ret = 'outro';
    await vi.advanceTimersByTimeAsync(450);
    expect(e.mudancas).toBe(2);
    p.stop();
  });

  it('stop cancela o próximo tick', async () => {
    const getPane = vi.fn(async () => ({ text: 'x', scrollback: 0 }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getPane).toHaveBeenCalledTimes(1);
    p.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(getPane).toHaveBeenCalledTimes(1);
  });

  it('resposta que chega DEPOIS do stop não publica (alive)', async () => {
    let resolver: ((v: { text: string; scrollback: number }) => void) | undefined;
    const getPane = vi.fn(() => new Promise<{ text: string; scrollback: number }>((r) => { resolver = r; }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
    resolver!({ text: 'chegou tarde', scrollback: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(e.vistos.length).toBe(0);
  });

  it('erro vira err e o poll continua (finally)', async () => {
    let fail = true;
    const getPane = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return { text: 'ok', scrollback: 0 };
    });
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(e.atual.err).toBe('boom');
    expect(e.atual.text).toBe('');
    fail = false;
    await vi.advanceTimersByTimeAsync(450);
    expect(e.atual.err).toBe('');
    expect(e.atual.text).toBe('ok');
    p.stop();
  });

  it('refresh publica e rejeita erro atual sem apagar o texto anterior', async () => {
    const getPane = vi.fn().mockResolvedValueOnce({ text: 'initial', scrollback: 10 });
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const error = new Error('refresh-failed');
    getPane.mockRejectedValueOnce(error);

    await expect(p.refresh()).rejects.toBe(error);

    expect(e.atual.text).toBe('initial');
    expect(e.atual.err).toBe('refresh-failed');
    p.stop();
  });

  it.each(['generation', 'lines', 'stop'])('refresh descarta erro antigo por %s sem rejeitar nem publicar', async (reason) => {
    let reject!: (error: Error) => void;
    const getPane = vi.fn().mockResolvedValueOnce({ text: 'initial', scrollback: 10 })
      .mockReturnValueOnce(new Promise((_done, fail) => { reject = fail; }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const pending = p.refresh();
    if (reason === 'generation') p.setActive(false);
    else if (reason === 'lines') p.setLines(600);
    else p.stop();
    const publications = e.vistos.length;
    reject(new Error('late-refresh-failed'));

    await expect(pending).resolves.toBeUndefined();

    expect(e.vistos).toHaveLength(publications);
    expect(e.atual.text).toBe('initial');
    expect(e.atual.err).toBe('');
    p.stop();
  });

  it('pausa cancela timer e HTTP, inclusive refresh, e retomar lê imediatamente', async () => {
    const getPane = vi.fn(async () => ({ text: 'pane', scrollback: 10 }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getPane).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    p.setActive(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(900);
    await p.refresh();
    expect(getPane).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    p.setActive(true);
    expect(getPane).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    p.setActive(true);
    expect(getPane).toHaveBeenCalledTimes(2);
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('começar em segundo plano não lê até retomar', async () => {
    const getPane = vi.fn(async () => ({ text: 'active', scrollback: 10 }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.setActive(false);
    p.start();
    await p.refresh();
    await vi.advanceTimersByTimeAsync(900);
    expect(getPane).not.toHaveBeenCalled();
    expect(e.vistos).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    p.setActive(true);
    expect(getPane).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(e.atual.text).toBe('active');
    p.stop();
  });

  it.each([
    { lateError: false, afterResume: false },
    { lateError: true, afterResume: false },
    { lateError: false, afterResume: true },
    { lateError: true, afterResume: true },
  ])('ignora leitura anterior à pausa (erro: $lateError, após retomar: $afterResume) sem publicar nem rearmar', async ({ lateError, afterResume }) => {
    let resolve!: (value: { text: string; scrollback: number }) => void;
    let reject!: (error: Error) => void;
    const getPane = vi.fn().mockResolvedValue({ text: 'resumed', scrollback: 10 })
      .mockResolvedValueOnce({ text: 'initial', scrollback: 10 })
      .mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail; }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(450);
    expect(getPane).toHaveBeenCalledTimes(2);
    p.setActive(false);
    if (afterResume) {
      p.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(e.atual.text).toBe('resumed');
    }
    const publications = e.vistos.length;

    if (lateError) reject(new Error('late-failure'));
    else resolve({ text: 'late-response', scrollback: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(e.vistos).toHaveLength(publications);
    expect(e.atual.err).toBe('');
    expect(vi.getTimerCount()).toBe(afterResume ? 1 : 0);
    if (!afterResume) {
      expect(e.atual.text).toBe('initial');
      p.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(e.atual.text).toBe('resumed');
    expect(getPane).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(450);
    expect(getPane).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('congelado: tick não troca o texto, refresh (ação do usuário) troca', async () => {
    let ret = 'um';
    const getPane = vi.fn(async () => ({ text: ret, scrollback: 0 }));
    const e = espiao();
    const p = criarPanePoller(getPane, 'sess', 200, e.onSnapshot, server);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.setAtBottom(false);
    ret = 'dois';
    await vi.advanceTimersByTimeAsync(450);
    expect(e.atual.text).toBe('um');       // poll congelado
    expect(e.atual.pending).toBe(true);
    await p.refresh();                      // ação deliberada passa por cima
    expect(e.atual.text).toBe('dois');
    expect(e.atual.pending).toBe(false);
    p.stop();
  });
});
