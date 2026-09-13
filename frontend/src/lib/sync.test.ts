import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { overwriteGetLocale as overwriteFront } from '../paraglide/runtime';
import { configureLocale, configureApi } from '@hangar/core';
function overwriteGetLocale(fn: () => 'en' | 'pt') {
  overwriteFront(fn);
  configureLocale({ getLocale: fn });
}

// O import de './sync' puxa '@hangar/core' -> './auth', que roda migrate() no import-time e precisa de
// localStorage/document/window (mesmo stub do api.test.ts, antes do import DINAMICO — import
// estatico e hoisted e executaria antes destes stubs).
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, String(v)),
  removeItem: (k: string) => store.delete(k),
};
(globalThis as any).document = { cookie: '' };
(globalThis as any).window = { location: { origin: 'https://app.test' } };

const { deriveKeys, encryptList, decryptList, register, syncStatus, cachedSyncStatus, activateSync, disableSync, loadKey, getVault, isSyncUnauthorized } = await import('./sync');

beforeEach(() => {
  store.clear();
  configureApi({ getBaseUrl: () => 'https://app.test', getToken: () => 'token',
    origin: 'https://app.test', onUnauthorized: () => {},
    createEventSource: () => { throw new Error('SSE inesperado'); } });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// Node 20+ exposes WebCrypto at globalThis.crypto; ensure it for the module under test.
if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

describe('sync crypto', () => {
  it('round-trips a server list through derive/encrypt/decrypt', async () => {
    const salt = btoa('0123456789abcdef');
    const { authHash, encKey } = await deriveKeys('hunter2', salt, 600000);
    expect(typeof authHash).toBe('string');
    expect(authHash.length).toBeGreaterThan(0);

    const servers = [{ id: 'a', label: 'casa', baseUrl: 'http://h:1', token: 't1' }];
    const blob = await encryptList(encKey, servers);
    expect(blob.iv).toBeTruthy();
    expect(blob.data).toBeTruthy();

    const out = await decryptList(encKey, blob);
    expect(out).toEqual(servers);
  });

  it('derives the same authHash for the same password+salt', async () => {
    const salt = btoa('0123456789abcdef');
    const a = await deriveKeys('pw', salt, 600000);
    const b = await deriveKeys('pw', salt, 600000);
    expect(a.authHash).toBe(b.authHash);
  });

  it('produces a different authHash for a different password', async () => {
    const salt = btoa('0123456789abcdef');
    const a = await deriveKeys('pw1', salt, 600000);
    const b = await deriveKeys('pw2', salt, 600000);
    expect(a.authHash).not.toBe(b.authHash);
  });
});

// Parecer task 10, bloqueador 1: register lia `(await r.json()).detail` cru — com o backend novo
// mandando dict {code, params, msg} (backend/app/mensagens.py), new Error(dict).message vira
// '[object Object]' na tela. Agora passa pelo MESMO errorDetail do api.ts (um parser so, o do
// endpoint migrado e o do sync nao divergem) e o texto sai legivel.
describe('register (erro da API de sync)', () => {
  it('detail em dict {code,params,msg} vira a mensagem traduzida, nunca [object Object]', async () => {
    overwriteGetLocale(() => 'pt');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'erro_bootstrap_invalido', params: {}, msg: 'bad bootstrap' } }), { status: 400 }),
    );
    await expect(register('u', 'p', 'b')).rejects.toThrow('bootstrap inválido');
  });

  it('detail em string (endpoint antigo) continua funcionando como hoje', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'register failed' }), { status: 400 }),
    );
    await expect(register('u', 'p', 'b')).rejects.toThrow('register failed');
  });
});

it('só libera acesso direto após 404 confirmado', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
  expect(cachedSyncStatus()).toBeNull();
  await expect(syncStatus()).resolves.toEqual({ enabled: false, registered: false });
  expect(cachedSyncStatus()?.enabled).toBe(false);
  fetchMock.mockRejectedValue(new TypeError('offline'));
  await expect(syncStatus()).resolves.toBeNull();
  store.clear();
  await expect(syncStatus()).resolves.toBeNull();
  expect(cachedSyncStatus()).toBeNull();
});

it('distingue sessão expirada de falhas temporárias ao abrir o cofre', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
  const unauthorized = await getVault().catch((error) => error);
  expect(isSyncUnauthorized(unauthorized)).toBe(true);

  fetchMock.mockRejectedValueOnce(new TypeError('offline'));
  const offline = await getVault().catch((error) => error);
  expect(isSyncUnauthorized(offline)).toBe(false);

  fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
  const serverError = await getVault().catch((error) => error);
  expect(isSyncUnauthorized(serverError)).toBe(false);
});

it('consulta pendurada termina no prazo e não é gravada como modo direto', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const first = syncStatus();
  const second = syncStatus();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(8000);
  await expect(first).resolves.toBeNull();
  await expect(second).resolves.toBeNull();
  expect(cachedSyncStatus()).toBeNull();
});

it('cria conta com lista cifrada, autentica na mesma origem e desativa sem apagar a chave', async () => {
  const servers = [{ id: 'a', label: 'PC', baseUrl: 'https://app.test', token: 'segredo-do-pc' }];
  store.set('cp_servers', JSON.stringify(servers));
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => new Response(JSON.stringify({
    enabled: !String(url).endsWith('/disable'), registered: true, user: 'jefferson',
  })));
  await activateSync(servers[0], { user: 'jefferson', password: 'senha-comprida' });
  const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
  expect(JSON.stringify(body)).not.toContain('senha-comprida');
  expect(JSON.stringify(body)).not.toContain('segredo-do-pc');
  const key = await loadKey();
  expect(await decryptList(key!, body.enc_blob)).toEqual(servers);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/sync/login');
  expect(cachedSyncStatus()?.enabled).toBe(true);
  const notify = vi.fn();
  window.dispatchEvent = notify;
  await disableSync(servers[0]);
  expect(notify.mock.calls[0][0].type).toBe('hangar-sync-disabled');
  expect(cachedSyncStatus()?.enabled).toBe(false);
  expect(await loadKey()).not.toBeNull();
  expect(JSON.parse(store.get('cp_servers')!)).toEqual(servers);
});

it('configurar outra máquina não troca o login nem o modo de abertura deste endereço', async () => {
  const server = { id: 'b', label: 'Outro PC', baseUrl: 'https://other.test', token: 'token-b' };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ enabled: true, registered: true, user: 'u' })));
  await activateSync(server, { user: 'u', password: 'senha-comprida' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('https://other.test/api/sync/setup');
  expect(cachedSyncStatus()).toBeNull();
  expect(await loadKey()).toBeNull();
});
