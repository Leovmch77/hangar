import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    getItemAsync: async (k: string) => m.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => {
      m.set(k, v);
    },
    deleteItemAsync: async (k: string) => {
      m.delete(k);
    },
  };
});

import { ownServers, useServers } from './servers';

beforeEach(async () => {
  // reset store
  useServers.setState({ servers: [], activeId: null, ready: false, aviso: null });
  const SecureStore = await import('expo-secure-store');
  // clear mock map by deleting known key
  await SecureStore.deleteItemAsync('cp_servers_v1');
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
