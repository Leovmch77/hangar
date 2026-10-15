import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    getItemAsync: vi.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: vi.fn(async (k: string, v: string) => {
      m.set(k, v);
    }),
    deleteItemAsync: vi.fn(async (k: string) => {
      m.delete(k);
    }),
  };
});

import * as SecureStore from 'expo-secure-store';
import { ownServers, useServers } from './servers';

beforeEach(async () => {
  // reset store
  useServers.setState({ servers: [], activeId: null, ready: false, vaultReadable: false, aviso: null });
  // clear mock map by deleting known key
  await SecureStore.deleteItemAsync('cp_servers_v1');
  vi.clearAllMocks();
});

const SAVED_SERVER = {
  id: 'saved', label: 'Servidor salvo', baseUrl: 'http://10.0.0.2:8765', token: 'saved-token',
  disabled: false, invite: false, inviteEnded: false, removed: false, ephemeral: false,
  lan: { url: 'http://192.168.0.2:8765', id: 'saved-machine' },
};
const SAVED = { servers: [SAVED_SERVER], activeId: SAVED_SERVER.id };
const VAULT_KEY = 'cp_servers_v1';

const mutations = [
  () => useServers.getState().add({ baseUrl: 'http://10.0.0.3:8765', token: 'new-token' }),
  () => useServers.getState().remove(SAVED_SERVER.id),
  () => useServers.getState().setActive(SAVED_SERVER.id),
  () => useServers.getState().rememberLan(useServers.getState().servers[0].id, { url: '', id: '' }),
];

describe('proteção do cofre', () => {
  test.each([
    ['leitura rejeitada', JSON.stringify(SAVED), true],
    ['JSON incompleto', '{', false],
    ['texto vazio', '', false],
    ['JSON nulo', 'null', false],
    ['lista no lugar do objeto', '[]', false],
    ['servers ausente', '{"activeId":null}', false],
    ['servers não é array', '{"servers":{},"activeId":null}', false],
    ['servidor nulo', '{"servers":[null],"activeId":null}', false],
    ['token ausente', JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, token: undefined }] }), false],
    ['id inválido', JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, id: 3 }] }), false],
    ['label inválido', JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, label: null }] }), false],
    ['baseUrl inválida', JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, baseUrl: false }] }), false],
    ...['disabled', 'invite', 'inviteEnded', 'removed', 'ephemeral'].map((field) => [
      `${field} inválido`, JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, [field]: 'false' }] }), false,
    ] as const),
    ['lan nula', JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, lan: null }] }), false],
    ['lan sem URL', JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, lan: { id: 'machine' } }] }), false],
    ['lan sem id', JSON.stringify({ ...SAVED, servers: [{ ...SAVED_SERVER, lan: { url: '' } }] }), false],
    ['activeId inválido', JSON.stringify({ ...SAVED, activeId: 3 }), false],
    ['activeId ausente', JSON.stringify({ servers: [] }), false],
  ] as const)('%s conserva estado e bloqueia todas as escritas mesmo após limpar aviso', async (_name, raw, rejected) => {
    await SecureStore.setItemAsync(VAULT_KEY, JSON.stringify(SAVED));
    await useServers.getState().load();
    await SecureStore.setItemAsync(VAULT_KEY, raw);
    vi.mocked(SecureStore.setItemAsync).mockClear();
    if (rejected) vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('cofre indisponível'));

    await useServers.getState().load();

    expect(useServers.getState()).toMatchObject({
      ...SAVED, ready: true, vaultReadable: false, aviso: { tipo: 'vault_unread' },
    });
    for (const mutate of mutations) {
      useServers.getState().limparAviso();
      mutate();
      expect(useServers.getState().aviso).toEqual({ tipo: 'vault_unread' });
      expect(useServers.getState().vaultReadable).toBe(false);
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
      expect(await SecureStore.getItemAsync(VAULT_KEY)).toBe(raw);
    }
  });

  test('bloqueia escrita antes da primeira leitura e enquanto ela está pendente', async () => {
    await SecureStore.setItemAsync(VAULT_KEY, JSON.stringify(SAVED));
    vi.mocked(SecureStore.setItemAsync).mockClear();
    useServers.getState().add({ baseUrl: 'http://10.0.0.4:8765', token: 'memory-token' });
    expect(useServers.getState().aviso).toEqual({ tipo: 'vault_unread' });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();

    let resolveRead!: (raw: string) => void;
    vi.mocked(SecureStore.getItemAsync).mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const loading = useServers.getState().load();
    for (const mutate of mutations) {
      useServers.getState().limparAviso();
      mutate();
      expect(useServers.getState().aviso).toEqual({ tipo: 'vault_unread' });
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    }
    expect(await SecureStore.getItemAsync(VAULT_KEY)).toBe(JSON.stringify(SAVED));

    resolveRead(JSON.stringify(SAVED));
    await loading;
    expect(useServers.getState()).toMatchObject({ ...SAVED, ready: true, vaultReadable: true });
    useServers.getState().setActive(SAVED_SERVER.id);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  test('cofre ausente libera escrita e guarda o servidor com seu token', async () => {
    await useServers.getState().load();
    expect(useServers.getState()).toMatchObject({ servers: [], activeId: null, vaultReadable: true, aviso: null });

    const added = useServers.getState().add({ baseUrl: 'http://10.0.0.2:8765', token: 'new-token' });
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await SecureStore.getItemAsync(VAULT_KEY))!)).toEqual({ servers: [added], activeId: added.id });
  });

  test('leitura válida posterior recupera servidores, tokens e campos extras e libera escrita', async () => {
    await SecureStore.setItemAsync(VAULT_KEY, '{');
    await useServers.getState().load();
    useServers.getState().limparAviso();
    useServers.getState().add({ baseUrl: 'http://10.0.0.3:8765', token: 'memory-token' });
    expect(await SecureStore.getItemAsync(VAULT_KEY)).toBe('{');

    await SecureStore.setItemAsync(VAULT_KEY, JSON.stringify(SAVED));
    vi.mocked(SecureStore.setItemAsync).mockClear();
    await useServers.getState().load();
    expect(useServers.getState()).toMatchObject({ ...SAVED, vaultReadable: true, aviso: null });
    useServers.getState().rememberLan(SAVED_SERVER.id, { url: '', id: '' });

    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await SecureStore.getItemAsync(VAULT_KEY))!)).toEqual({
      servers: [{ ...SAVED_SERVER, lan: { url: '', id: '' } }], activeId: SAVED_SERVER.id,
    });
  });
});

test('add/setActive/remove persistem', async () => {
  await useServers.getState().load();
  const s = useServers.getState().add({ baseUrl: 'http://10.0.0.2:8765/', token: 'abc' });
  expect(s.baseUrl).toBe('http://10.0.0.2:8765'); // sem barra final
  expect(useServers.getState().active()?.id).toBe(s.id);
  useServers.getState().remove(s.id);
  expect(useServers.getState().active()).toBeNull();
});

const PAIR = { local_session: 'api', alias: 'casa', owner: 'Ana', session: 'web', address: 'https://casa.ts.net:8443', token: 'tp' };

describe('entradas de par externo', () => {
  test('entrada temporária nunca troca o token do dono no mesmo endereço', async () => {
    await useServers.getState().load();
    useServers.getState().applyPairs([PAIR]);
    const dono = useServers.getState().add({ baseUrl: 'https://casa.ts.net:8443', token: 'dono' });
    const lista = useServers.getState().servers;
    expect(lista).toHaveLength(2);
    expect(lista.find((s) => s.ephemeral)?.token).toBe('tp');
    expect(dono.token).toBe('dono');
    expect(dono.invite).toBeFalsy();
  });

  test('não é gravada, e abrir a sessão dela não troca a ativa guardada', async () => {
    await useServers.getState().load();
    const dono = useServers.getState().add({ baseUrl: 'http://10.0.0.2:8765', token: 'abc' });
    useServers.getState().applyPairs([PAIR]);
    const par = useServers.getState().servers.find((s) => s.ephemeral)!;
    useServers.getState().ensureActive(par.id);
    useServers.getState().rememberLan(dono.id, { url: '', id: '' });
    await Promise.resolve();
    const SecureStore = await import('expo-secure-store');
    const salvo = JSON.parse((await SecureStore.getItemAsync('cp_servers_v1'))!);
    expect(salvo.servers.map((s: { id: string }) => s.id)).toEqual([dono.id]);
    expect(salvo.activeId).toBe(dono.id);
  });

  test('401 em entrada de convite marca encerrado, nunca remove nem acusa o token', async () => {
    await useServers.getState().load();
    useServers.getState().applyPairs([PAIR]);
    const par = useServers.getState().servers.find((s) => s.ephemeral)!;
    useServers.getState().markInvalid(par.id);
    const depois = useServers.getState().servers.find((s) => s.id === par.id);
    expect(depois?.inviteEnded).toBe(true);
    expect(useServers.getState().aviso).toBeNull();
  });

  test('par que acabou leva a entrada embora', async () => {
    await useServers.getState().load();
    useServers.getState().applyPairs([PAIR]);
    useServers.getState().applyPairs([]);
    expect(useServers.getState().servers).toHaveLength(0);
  });

  test('sair da conversa de fora volta a ativa para a máquina própria', async () => {
    await useServers.getState().load();
    const dono = useServers.getState().add({ baseUrl: 'http://10.0.0.2:8765', token: 'abc' });
    useServers.getState().applyPairs([PAIR]);
    useServers.getState().ensureActive(useServers.getState().servers.find((s) => s.ephemeral)!.id);
    useServers.getState().ensureOwnActive();
    expect(useServers.getState().activeId).toBe(dono.id);
  });

  test('remover a ativa nunca escolhe a entrada temporária como nova ativa', async () => {
    await useServers.getState().load();
    useServers.getState().applyPairs([PAIR]);
    const outra = { id: 's_b', label: 'b', baseUrl: 'http://10.0.0.3:8765', token: 'b' };
    const ativa = { id: 's_a', label: 'a', baseUrl: 'http://10.0.0.2:8765', token: 'a' };
    useServers.setState({ servers: [...useServers.getState().servers, outra, ativa], activeId: ativa.id });
    expect(useServers.getState().servers[0].ephemeral).toBe(true);
    useServers.getState().remove(ativa.id);
    expect(useServers.getState().activeId).toBe(outra.id);
    useServers.getState().remove(useServers.getState().servers.find((s) => s.ephemeral)!.id);
    expect(useServers.getState().activeId).toBe(outra.id);
  });

  test('máquinas próprias deixam a entrada temporária de fora', async () => {
    await useServers.getState().load();
    useServers.getState().add({ baseUrl: 'http://10.0.0.2:8765', token: 'abc' });
    useServers.getState().applyPairs([PAIR]);
    expect(ownServers(useServers.getState().servers).map((s) => s.baseUrl)).toEqual(['http://10.0.0.2:8765']);
  });
});
