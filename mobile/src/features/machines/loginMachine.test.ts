import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureApi } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { verifyLoginMachine } from './loginMachine';
import * as m from '../../paraglide/messages';

const mocks = vi.hoisted(() => ({ vault: new Map<string, string>(), fetch: vi.fn(), warning: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mocks.vault.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.vault.set(key, value); },
}));
vi.mock('sonner-native', () => ({ toast: mocks.warning, Toaster: () => null }));

const baseUrl = 'http://10.0.2.2:8765';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const addMachine = (label: string = m.native_settings_group_server()) => useServers.getState().add({ baseUrl, token: 'machine-token', label });

beforeEach(async () => {
  mocks.vault.clear();
  mocks.fetch.mockReset();
  mocks.warning.mockClear();
  await useServers.getState().load();
  configureApi({
    getBaseUrl: () => useServers.getState().active()?.baseUrl ?? '',
    getToken: () => useServers.getState().active()?.token ?? null,
    onUnauthorized: () => { throw new Error('unexpected_active_auth_reset'); },
    origin: null,
    createEventSource: () => { throw new Error('unexpected_stream'); },
  });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(async () => {
  await useServers.getState().load();
  vi.unstubAllGlobals();
});

function loginNetwork(handle: (url: string, init: RequestInit) => Response | Promise<Response>) {
  mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/peers')) return json([]);
    if (url.endsWith('/api/peers/app-list')) return json({ rev: 'r1', servers: [] });
    return handle(url, init);
  });
}

describe('verifyLoginMachine', () => {
  test.each([true, false])('descobre após autenticar, inclusive cadastro existente: resolveName=%s', async (resolveName) => {
    const machine = addMachine('fixture-preserved');
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === `${baseUrl}/api/peers/app-list`) return json({ rev: 'r1', servers: [
        { id: 'found', label: 'fixture-found', address: 'https://found.test', token: 'found-token', disabled: false, invite: false },
      ] });
      if (url.endsWith('/api/peers')) return json([]);
      if (url.endsWith('/api/sessions')) return json([]);
      return json({ identificador: url.startsWith(baseUrl) ? 'machine-home' : 'found-name', lan_url: '' });
    });
    await verifyLoginMachine(machine, resolveName);
    await new Promise<void>((r) => setImmediate(r));
    expect(useServers.getState().servers.find((s) => s.baseUrl === 'https://found.test'))
      .toMatchObject({ label: 'found-name', token: 'found-token' });
    expect(useServers.getState().activeId).toBe(machine.id);
    if (!resolveName) expect(useServers.getState().servers[0].label).toBe('fixture-preserved');
  });

  test('falha auxiliar avisa sem rejeitar login nem remover máquina autenticada', async () => {
    const machine = addMachine();
    mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/api/sessions')
      ? json([]) : json({ detail: 'do-not-show-machine-token' }, 503));
    await expect(verifyLoginMachine(machine, false)).resolves.toBeUndefined();
    await new Promise<void>((r) => setImmediate(r));
    expect(useServers.getState().servers).toEqual([machine]);
    expect(mocks.warning).toHaveBeenCalled();
    expect(JSON.stringify(mocks.warning.mock.calls)).not.toContain('do-not-show-machine-token');
  });
  test('autenticação recusada propaga o erro sem consultar identidade', async () => {
    const machine = addMachine();
    const paths: string[] = [];
    loginNetwork(async (url: string) => {
      paths.push(url);
      return json({ detail: 'invalid-token' }, 401);
    });

    await expect(verifyLoginMachine(machine, true)).rejects.toMatchObject({ status: 401 });

    expect(paths).toEqual([`${baseUrl}/api/sessions`]);
    expect(useServers.getState().servers).toEqual([machine]);
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  test('verifica a máquina passada mesmo com outra ativa e persiste o identificador do IP', async () => {
    const machine = addMachine();
    const other = useServers.getState().add({ baseUrl: 'https://other.test', token: 'other-token', label: 'fixture-other' });
    const paths: string[] = [];
    loginNetwork(async (url: string, init: RequestInit) => {
      paths.push(url);
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer machine-token');
      if (url === `${baseUrl}/api/sessions`) return json([]);
      if (url === `${baseUrl}/api/peers/identificador`) return json({ identificador: 'machine-home', lan_url: '' });
      throw new Error(`unexpected_url: ${url}`);
    });

    await verifyLoginMachine(machine, true);
    await useServers.getState().load();

    expect(paths).toEqual([`${baseUrl}/api/sessions`, `${baseUrl}/api/peers/identificador`]);
    expect(useServers.getState().servers).toEqual([{ ...machine, label: 'machine-home' }, other]);
    expect(useServers.getState().activeId).toBe(other.id);
    expect(JSON.parse(mocks.vault.get('cp_servers_v1')!).servers[0]).toEqual({ ...machine, label: 'machine-home' });
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  test('identificador vazio mantém rótulo neutro e avisa resposta inválida', async () => {
    const machine = addMachine();
    loginNetwork(async (url: string) => url.endsWith('/api/sessions')
      ? json([]) : json({ identificador: '  ', lan_url: '' }));

    await verifyLoginMachine(machine, true);

    expect(useServers.getState().servers).toEqual([machine]);
    expect(useServers.getState().servers[0].label).toBe(m.native_settings_group_server());
    expect(mocks.warning).toHaveBeenCalledExactlyOnceWith(m.mobile_machines_invalid_response(), expect.any(Object));
  });

  test('cadastro existente preserva o apelido e não consulta identidade', async () => {
    addMachine('fixture-nickname');
    const machine = useServers.getState().add({ baseUrl, token: 'renewed-token', label: '10.0.2.2' });
    const paths: string[] = [];
    loginNetwork(async (url: string) => { paths.push(url); return json([]); });

    await verifyLoginMachine(machine, false);
    await useServers.getState().load();

    expect(paths).toEqual([`${baseUrl}/api/sessions`]);
    expect(useServers.getState().servers).toEqual([{ ...machine, label: 'fixture-nickname', token: 'renewed-token' }]);
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  test.each([
    ['token recusado na identidade', () => json({ detail: 'identity-token-refused' }, 401), '401: identity-token-refused'],
    ['JSON malformado', () => new Response('{'), /JSON|property|position/i],
    ['identificador de tipo inválido', () => json({ identificador: 10 }), /resposta inválida|invalid response/i],
    ['identificador ausente', () => json({}), /resposta inválida|invalid response/i],
    ['tempo esgotado', () => { throw new DOMException('identity-timeout', 'TimeoutError'); }, 'identity-timeout'],
  ] as const)('%s avisa a causa sem desfazer login nem usar IP como nome', async (_name, identity, cause) => {
    const machine = addMachine();
    loginNetwork(async (url: string) => url.endsWith('/api/sessions') ? json([]) : identity());

    await expect(verifyLoginMachine(machine, true)).resolves.toBeUndefined();

    expect(useServers.getState().servers).toEqual([machine]);
    expect(useServers.getState().servers[0].label).toBe(m.native_settings_group_server());
    expect(useServers.getState().activeId).toBe(machine.id);
    expect(mocks.warning).toHaveBeenCalledWith(cause instanceof RegExp ? expect.stringMatching(cause) : cause, expect.any(Object));
  });
});
