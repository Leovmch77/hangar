import { describe, test, expect, vi, beforeEach } from 'vitest';

const vault = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import * as SecureStore from 'expo-secure-store';
let useServers: typeof import('./servers').useServers;
let ownServers: typeof import('./servers').ownServers;

beforeEach(async () => {
  vi.resetModules();
  vault.clear();
  vi.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async (k) => vault.get(k) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (k, v) => { vault.set(k, v); });
  vi.mocked(SecureStore.deleteItemAsync).mockReset().mockImplementation(async (k) => { vault.delete(k); });
  ({ useServers, ownServers } = await import('./servers'));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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
    if (rejected) vi.mocked(SecureStore.getItemAsync)
      .mockRejectedValueOnce(new Error('cofre indisponível'))
      .mockRejectedValueOnce(new Error('cofre indisponível'));

    await useServers.getState().load();

    expect(useServers.getState()).toMatchObject({
      ...SAVED, ready: true, vaultReadable: false, aviso: { tipo: 'vault_unread' },
    });
    for (const mutate of mutations) {
      useServers.getState().limparAviso();
      mutate();
      await settle();
      expect(useServers.getState().aviso).toBeNull();
      expect(useServers.getState().vaultReadable).toBe(false);
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
      expect(vault.get(VAULT_KEY)).toBe(raw);
    }
  });

  test('add antes da primeira leitura sobrevive, junta o salvo e deduplica load em voo', async () => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    const read = deferred<string>();
    vi.mocked(SecureStore.getItemAsync).mockReturnValueOnce(read.promise);
    const added = useServers.getState().add({ baseUrl: 'http://10.0.0.4:8765', token: 'memory-token' });
    const loading = useServers.getState().load();
    const again = useServers.getState().load();
    await settle();
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(vault.get(VAULT_KEY)).toBe(JSON.stringify(SAVED));

    read.resolve(JSON.stringify(SAVED));
    await Promise.all([loading, again]);
    expect(useServers.getState()).toMatchObject({
      servers: [SAVED_SERVER, added], activeId: added.id, ready: true, vaultReadable: true, aviso: null,
    });
    expect(JSON.parse(vault.get(VAULT_KEY)!)).toEqual({ servers: [SAVED_SERVER, added], activeId: added.id });
  });

  test('cofre ausente libera escrita e guarda o servidor com seu token', async () => {
    await useServers.getState().load();
    expect(useServers.getState()).toMatchObject({ servers: [], activeId: null, vaultReadable: true, aviso: null });

    const added = useServers.getState().add({ baseUrl: 'http://10.0.0.2:8765', token: 'new-token' });
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await SecureStore.getItemAsync(VAULT_KEY))!)).toEqual({ servers: [added], activeId: added.id });
  });

  test('primeiro add após falha temporária relê o cofre e junta salvo com novo', async () => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('bloqueado'));
    await useServers.getState().load();
    useServers.getState().limparAviso();
    const added = useServers.getState().add({ baseUrl: 'http://10.0.0.3:8765', token: 'memory-token' });
    await settle();

    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
    expect(useServers.getState()).toMatchObject({
      servers: [SAVED_SERVER, added], activeId: added.id, vaultReadable: true, aviso: null,
    });
    expect(JSON.parse(vault.get(VAULT_KEY)!)).toEqual({ servers: [SAVED_SERVER, added], activeId: added.id });
  });

  test('falha persistente não repete leitura nem aviso a cada rememberLan', async () => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error('bloqueado'));
    await useServers.getState().load();
    expect(useServers.getState().aviso).toEqual({ tipo: 'vault_unread' });
    useServers.getState().limparAviso();
    const added = useServers.getState().add({ baseUrl: 'http://10.0.0.3:8765', token: 'memory-token' });
    await settle();
    for (let i = 0; i < 10; i++) {
      useServers.getState().rememberLan(added.id, { url: '', id: '' });
      await settle();
      expect(useServers.getState().aviso).toBeNull();
    }
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(vault.get(VAULT_KEY)).toBe(JSON.stringify(SAVED));
    expect(useServers.getState().vaultReadable).toBe(false);
  });

  test('load público recupera no retorno ao primeiro plano e reavisa apenas uma falha nova', async () => {
    vault.set(VAULT_KEY, '{');
    await useServers.getState().load();
    const added = useServers.getState().add({ baseUrl: 'http://10.0.0.3:8765', token: 'memory-token' });
    await settle();
    useServers.getState().limparAviso();
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    await useServers.getState().load();
    expect(useServers.getState()).toMatchObject({
      servers: [SAVED_SERVER, added], activeId: added.id, vaultReadable: true, aviso: null,
    });
    expect(JSON.parse(vault.get(VAULT_KEY)!)).toEqual({ servers: [SAVED_SERVER, added], activeId: added.id });
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('bloqueado novamente'));
    await useServers.getState().load();
    expect(useServers.getState().aviso).toEqual({ tipo: 'vault_unread' });
    expect(useServers.getState().vaultReadable).toBe(false);
  });

  test('vários adds durante load mantêm tokens novos e o ID salvo para a mesma base', async () => {
    const read = deferred<string>();
    vi.mocked(SecureStore.getItemAsync).mockReturnValueOnce(read.promise);
    const loading = useServers.getState().load();
    const updated = useServers.getState().add({ baseUrl: `${SAVED_SERVER.baseUrl}/`, token: 'fresh-token', label: 'não substituir' });
    const added = useServers.getState().add({ baseUrl: 'http://10.0.0.3:8765', token: 'b' });
    const third = useServers.getState().add({ baseUrl: 'http://10.0.0.4:8765', token: 'c' });
    useServers.getState().add({ baseUrl: SAVED_SERVER.baseUrl, token: 'latest-token' });
    useServers.getState().rememberLan(updated.id, { url: '', id: 'new-lan' });
    useServers.getState().setActive(updated.id);
    read.resolve(JSON.stringify(SAVED));
    await loading;

    const expected = { servers: [{ ...SAVED_SERVER, token: 'latest-token', lan: { url: '', id: 'new-lan' } }, added, third], activeId: SAVED_SERVER.id };
    expect(new Set([updated.id, added.id, third.id]).size).toBe(3);
    expect(useServers.getState()).toMatchObject({ ...expected, vaultReadable: true });
    expect(JSON.parse(vault.get(VAULT_KEY)!)).toEqual(expected);
  });

  test('remove, ativa e LAN pendentes são reaplicados sem perder máquinas desconhecidas', async () => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    await useServers.getState().load();
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('bloqueado'));
    await useServers.getState().load();
    const other = { ...SAVED_SERVER, id: 'other', baseUrl: 'http://10.0.0.5:8765', token: 'other-token' };
    const unseen = { ...SAVED_SERVER, id: 'unseen', baseUrl: 'http://10.0.0.6:8765', token: 'unseen-token' };
    const read = deferred<string>();
    vi.mocked(SecureStore.getItemAsync).mockReturnValueOnce(read.promise);
    useServers.getState().remove(SAVED_SERVER.id);
    useServers.getState().rememberLan(other.id, { url: '', id: 'updated-machine' });
    useServers.getState().setActive(other.id);
    read.resolve(JSON.stringify({ servers: [SAVED_SERVER, other, unseen], activeId: SAVED_SERVER.id }));
    await useServers.getState().load();

    const expected = { servers: [{ ...other, lan: { url: '', id: 'updated-machine' } }, unseen], activeId: other.id };
    expect(useServers.getState()).toMatchObject(expected);
    expect(JSON.parse(vault.get(VAULT_KEY)!)).toEqual(expected);
  });

  test('remover add com ID provisório remove também a base descoberta no cofre', async () => {
    const read = deferred<string>();
    vi.mocked(SecureStore.getItemAsync).mockReturnValueOnce(read.promise);
    const loading = useServers.getState().load();
    const added = useServers.getState().add({ baseUrl: SAVED_SERVER.baseUrl, token: 'fresh' });
    useServers.getState().remove(added.id);
    read.resolve(JSON.stringify(SAVED));
    await loading;
    expect(useServers.getState()).toMatchObject({ servers: [], activeId: null });
    expect(JSON.parse(vault.get(VAULT_KEY)!)).toEqual({ servers: [], activeId: null });
  });

  test('gravação da recuperação nunca termina por cima de alterações posteriores', async () => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('bloqueado'));
    await useServers.getState().load();
    const write = deferred<void>();
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, raw) => {
      await write.promise;
      vault.set(key, raw);
    });
    useServers.getState().add({ baseUrl: 'http://10.0.0.3:8765', token: 'first' });
    await settle();
    const last = useServers.getState().add({ baseUrl: 'http://10.0.0.4:8765', token: 'last' });
    write.resolve();
    await settle();
    expect(JSON.parse(vault.get(VAULT_KEY)!)).toEqual({ servers: useServers.getState().servers, activeId: last.id });
    expect(useServers.getState().servers).toHaveLength(3);
  });
});

function takeWarnings() {
  const warnings = [];
  while (useServers.getState().aviso) {
    warnings.push(useServers.getState().aviso);
    useServers.getState().limparAviso();
  }
  return warnings;
}

describe('avisos independentes', () => {
  test.each([true, false])('token e leitura recusada coexistem, token primeiro: %s', async (tokenFirst) => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    await useServers.getState().load();
    const read = deferred<string>();
    vi.mocked(SecureStore.getItemAsync).mockReturnValueOnce(read.promise).mockRejectedValue(new Error('bloqueado'));
    const loading = useServers.getState().load();
    if (tokenFirst) useServers.getState().markInvalid(SAVED_SERVER.id);
    read.reject(new Error('bloqueado'));
    await loading;
    if (!tokenFirst) useServers.getState().markInvalid(SAVED_SERVER.id);
    await settle();
    const token = { tipo: 'token', label: SAVED_SERVER.label };
    const unread = { tipo: 'vault_unread' };
    expect(takeWarnings()).toEqual(tokenFirst ? [token, unread] : [unread, token]);
    expect(useServers.getState().vaultReadable).toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  test('leitura válida apaga só aviso do cofre, não o token pendente', async () => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    await useServers.getState().load();
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('bloqueado'));
    await useServers.getState().load();
    useServers.getState().markInvalid(SAVED_SERVER.id);
    await useServers.getState().load();
    expect(takeWarnings()).toEqual([{ tipo: 'token', label: SAVED_SERVER.label }]);
    expect(useServers.getState().servers).toEqual([]);
  });

  test.each([true, false])('token e persistência recusada coexistem, token primeiro: %s', async (tokenFirst) => {
    vault.set(VAULT_KEY, JSON.stringify(SAVED));
    await useServers.getState().load();
    const write = deferred<void>();
    vi.mocked(SecureStore.setItemAsync).mockReturnValueOnce(write.promise).mockRejectedValue(new Error('disco cheio'));
    useServers.getState().setActive(SAVED_SERVER.id);
    if (tokenFirst) useServers.getState().markInvalid(SAVED_SERVER.id);
    write.reject(new Error('disco cheio'));
    await settle();
    if (!tokenFirst) useServers.getState().markInvalid(SAVED_SERVER.id);
    await settle();
    const token = { tipo: 'token', label: SAVED_SERVER.label };
    const failed = { tipo: 'persistencia' };
    expect(takeWarnings()).toEqual(tokenFirst ? [token, failed] : [failed, token]);
    useServers.getState().setActive(SAVED_SERVER.id);
    await settle();
    expect(takeWarnings()).toEqual([]);
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, raw) => { vault.set(key, raw); });
    useServers.getState().setActive(SAVED_SERVER.id);
    await settle();
    useServers.getState().setActive(SAVED_SERVER.id);
    await settle();
    expect(takeWarnings()).toEqual([failed]);
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
