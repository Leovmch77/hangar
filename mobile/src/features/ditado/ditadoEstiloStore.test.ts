import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock do core antes de importar o store
vi.mock('@hangar/core', async () => {
  const actual = await vi.importActual<typeof import('@hangar/core')>('@hangar/core');
  return {
    ...actual,
    getConfig: vi.fn(),
    getConfigForServer: vi.fn(),
    patchConfig: vi.fn(),
    patchConfigForServer: vi.fn(),
    fetchDictationOrganization: vi.fn(),
  };
});

import { dictationStyleStore, useDitadoEstiloStore } from './ditadoEstiloStore';
import * as core from '@hangar/core';
import { useDictationOrganizationStore } from './dictationOrganization';

const a: core.Server = { id: 'a', label: 'A', baseUrl: 'https://a.test', token: 'token-a' };
const b: core.Server = { id: 'b', label: 'B', baseUrl: 'https://b.test', token: 'token-b' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function campos(valor: string) {
  return {
    campos: {
      ditado_estilo: { valor, definido: true, origem: 'app' as const },
    },
    somente_leitura: {},
  };
}

beforeEach(() => {
  useDitadoEstiloStore.getState()._zerarParaTeste();
  dictationStyleStore(a).getState()._zerarParaTeste();
  dictationStyleStore(b).getState()._zerarParaTeste();
  dictationStyleStore(null).getState()._zerarParaTeste();
  useDictationOrganizationStore.setState({ byServer: {} });
  vi.resetAllMocks();
  core.configureApi({ getBaseUrl: () => b.baseUrl, getToken: () => b.token, onUnauthorized: () => {},
    origin: null, createEventSource: () => { throw new Error('unexpected SSE'); } });
});

describe('ditadoEstiloStore', () => {
  it('A e B guardam valores separados e usam GET/PATCH explícitos com B ativo', async () => {
    vi.mocked(core.getConfigForServer).mockImplementation(async (server) => campos(server.id === a.id ? 'limpar' : 'briefing') as never);
    vi.mocked(core.patchConfigForServer).mockResolvedValue({ campos: {} } as never);
    const storeA = dictationStyleStore(a);
    const storeB = dictationStyleStore(b);

    await Promise.all([storeA.getState().carregar(), storeB.getState().carregar()]);
    expect(storeA.getState().valor).toBe('limpar');
    expect(storeB.getState().valor).toBe('briefing');
    expect(core.getConfigForServer).toHaveBeenCalledWith(a);
    expect(core.getConfigForServer).toHaveBeenCalledWith(b);
    await storeA.getState().trocar('prosa');
    expect(storeB.getState().valor).toBe('briefing');
    await storeB.getState().trocar('limpar');
    expect(storeA.getState().valor).toBe('prosa');
    expect(core.patchConfigForServer).toHaveBeenNthCalledWith(1, a, { ditado_estilo: 'prosa' });
    expect(core.patchConfigForServer).toHaveBeenNthCalledWith(2, b, { ditado_estilo: 'limpar' });
    expect(core.getConfig).not.toHaveBeenCalled();
    expect(core.patchConfig).not.toHaveBeenCalled();
  });

  it('cargas simultâneas deduplicam só o próprio servidor', async () => {
    const readA = deferred<core.ConfigServidor>();
    const readB = deferred<core.ConfigServidor>();
    vi.mocked(core.getConfigForServer).mockImplementation((server) => server.id === a.id ? readA.promise : readB.promise);
    const storeA = dictationStyleStore(a);
    const storeB = dictationStyleStore(b);
    const loads = [storeA.getState().carregar(), storeA.getState().carregar(), storeB.getState().carregar()];
    expect(core.getConfigForServer).toHaveBeenCalledTimes(2);
    readA.resolve(campos('limpar') as core.ConfigServidor);
    await loads[0];
    expect(storeA.getState().pronto).toBe(true);
    expect(storeB.getState().pronto).toBe(false);
    readB.resolve(campos('briefing') as core.ConfigServidor);
    await Promise.all(loads);
    expect(storeB.getState().valor).toBe('briefing');
  });

  it('GET atrasado de A não desfaz troca em A nem perde a leitura de B', async () => {
    const readA = deferred<core.ConfigServidor>();
    const readB = deferred<core.ConfigServidor>();
    vi.mocked(core.getConfigForServer).mockImplementation((server) => server.id === a.id ? readA.promise : readB.promise);
    vi.mocked(core.patchConfigForServer).mockResolvedValue({ campos: {} } as never);
    const storeA = dictationStyleStore(a);
    const storeB = dictationStyleStore(b);
    const loadA = storeA.getState().carregar();
    const loadB = storeB.getState().carregar();
    await storeA.getState().trocar('briefing');
    readA.resolve(campos('limpar') as core.ConfigServidor);
    readB.resolve(campos('limpar') as core.ConfigServidor);
    await Promise.all([loadA, loadB]);
    expect(storeA.getState().valor).toBe('briefing');
    expect(storeB.getState().valor).toBe('limpar');
  });

  it('falha e rollback de A não afetam B nem são anulados por escrita em B', async () => {
    vi.mocked(core.getConfigForServer).mockImplementation(async (server) => {
      if (server.id === a.id) throw new Error('502');
      return campos('briefing') as never;
    });
    const storeA = dictationStyleStore(a);
    const storeB = dictationStyleStore(b);
    await Promise.all([storeA.getState().carregar(), storeB.getState().carregar()]);
    expect(storeA.getState()).toMatchObject({ pronto: false, falhou: true, valor: 'prosa' });
    expect(storeB.getState()).toMatchObject({ pronto: true, falhou: false, valor: 'briefing' });
    const writeA = deferred<core.RespostaPatchConfig>();
    vi.mocked(core.patchConfigForServer).mockImplementation((server) => server.id === a.id
      ? writeA.promise : Promise.resolve({ campos: {} } as never));
    const failed = expect(storeA.getState().trocar('limpar')).rejects.toThrow('502');
    await storeB.getState().trocar('limpar');
    writeA.reject(new Error('502'));
    await failed;
    expect(storeA.getState().valor).toBe('prosa');
    expect(storeB.getState()).toMatchObject({ pronto: true, falhou: false, valor: 'limpar' });
  });

  it('falha não confirma estilo local e permite nova leitura do servidor', async () => {
    vi.mocked(core.getConfigForServer).mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce(campos('briefing') as core.ConfigServidor);
    const store = dictationStyleStore(a);
    await store.getState().carregar();
    expect(store.getState()).toMatchObject({ pronto: false, falhou: true });
    await store.getState().revalidar();
    expect(store.getState()).toMatchObject({ pronto: true, falhou: false, valor: 'briefing' });
    expect(core.getConfigForServer).toHaveBeenCalledTimes(2);
  });

  it.each([{}, campos('desconhecido'), { campos: { ditado_estilo: { valor: null } } }])('leitura sem estilo conhecido confirma o padrão Prosa: %j', async (response) => {
    vi.mocked(core.getConfigForServer).mockResolvedValue(response as core.ConfigServidor);
    await dictationStyleStore(a).getState().carregar();
    expect(dictationStyleStore(a).getState()).toMatchObject({ pronto: true, falhou: false, valor: 'prosa' });
  });

  it.each(['read-first', 'write-first'])('leitura e troca sem valor confirmado terminam em falha visível: %s', async (order) => {
    const read = deferred<core.ConfigServidor>();
    const write = deferred<core.RespostaPatchConfig>();
    vi.mocked(core.getConfigForServer).mockReturnValue(read.promise);
    vi.mocked(core.patchConfigForServer).mockReturnValue(write.promise);
    const store = dictationStyleStore(a);
    const loading = store.getState().carregar();
    const failed = expect(store.getState().trocar('briefing')).rejects.toThrow('502');
    if (order === 'read-first') {
      read.resolve(campos('limpar') as core.ConfigServidor);
      await loading;
    }
    write.reject(new Error('502'));
    await failed;
    if (order === 'write-first') {
      read.resolve(campos('limpar') as core.ConfigServidor);
      await loading;
    }
    expect(store.getState()).toMatchObject({ pronto: false, falhou: true, valor: 'prosa' });
  });

  it('revalidar conserva o estilo confirmado durante a leitura e a troca recusada', async () => {
    vi.mocked(core.getConfigForServer).mockResolvedValueOnce(campos('limpar') as core.ConfigServidor);
    const store = dictationStyleStore(a);
    await store.getState().carregar();
    const read = deferred<core.ConfigServidor>();
    vi.mocked(core.getConfigForServer).mockReturnValue(read.promise);
    vi.mocked(core.patchConfigForServer).mockRejectedValue(new Error('502'));
    const loading = store.getState().revalidar();
    expect(store.getState()).toMatchObject({ pronto: true, falhou: false, valor: 'limpar' });
    await expect(store.getState().trocar('briefing')).rejects.toThrow('502');
    read.resolve(campos('prosa') as core.ConfigServidor);
    await loading;
    expect(store.getState()).toMatchObject({ pronto: true, falhou: false, valor: 'limpar' });
  });

  it('GET que falha depois da escolha confirmada não invalida o estilo salvo', async () => {
    const read = deferred<core.ConfigServidor>();
    vi.mocked(core.getConfigForServer).mockReturnValue(read.promise);
    vi.mocked(core.patchConfigForServer).mockResolvedValue({ campos: {} } as core.RespostaPatchConfig);
    const store = dictationStyleStore(a);
    const loading = store.getState().carregar();
    await store.getState().trocar('briefing');
    read.reject(new Error('502'));
    await loading;
    expect(store.getState()).toMatchObject({ pronto: true, falhou: false, valor: 'briefing' });
  });

  it('mesmo ID atualiza token e LAN sem apagar estado nem mudar pedido em voo', async () => {
    const read = deferred<core.ConfigServidor>();
    vi.mocked(core.getConfigForServer).mockReturnValue(read.promise);
    vi.mocked(core.patchConfigForServer).mockResolvedValue({ campos: {} } as never);
    const store = dictationStyleStore(a);
    const load = store.getState().carregar();
    const updated = { ...a, token: 'new-token', lan: { url: 'http://192.168.1.2:8765', id: a.id } };
    expect(dictationStyleStore(updated)).toBe(store);
    expect(core.getConfigForServer).toHaveBeenCalledExactlyOnceWith(a);
    read.resolve(campos('briefing') as core.ConfigServidor);
    await load;
    expect(dictationStyleStore(updated).getState()).toMatchObject({ pronto: true, valor: 'briefing' });
    await store.getState().trocar('limpar');
    expect(core.patchConfigForServer).toHaveBeenCalledExactlyOnceWith(updated, { ditado_estilo: 'limpar' });
    await store.getState().revalidar();
    expect(core.getConfigForServer).toHaveBeenLastCalledWith(updated);
  });

  it('sem argumento preserva o store e as APIs legadas', async () => {
    vi.mocked(core.getConfig).mockResolvedValue(campos('limpar') as never);
    vi.mocked(core.patchConfig).mockResolvedValue({ campos: {} } as never);
    expect(dictationStyleStore()).toBe(useDitadoEstiloStore);
    await dictationStyleStore().getState().carregar();
    await dictationStyleStore().getState().trocar('briefing');
    expect(core.getConfig).toHaveBeenCalledExactlyOnceWith();
    expect(core.patchConfig).toHaveBeenCalledExactlyOnceWith({ ditado_estilo: 'briefing' });
    expect(core.getConfigForServer).not.toHaveBeenCalled();
    expect(core.patchConfigForServer).not.toHaveBeenCalled();
  });

  it('null ou servidor removido não leem nem escrevem no ativo', async () => {
    await dictationStyleStore(null).getState().carregar();
    await dictationStyleStore(null).getState().revalidar();
    await expect(dictationStyleStore(null).getState().trocar('limpar')).rejects.toThrow();
    const removed = { ...a, removed: true };
    await dictationStyleStore(removed).getState().carregar();
    await expect(dictationStyleStore(removed).getState().trocar('briefing')).rejects.toThrow();
    expect(dictationStyleStore(null)).not.toBe(useDitadoEstiloStore);
    expect(dictationStyleStore(null).getState()).toMatchObject({ pronto: false, valor: 'prosa' });
    await useDictationOrganizationStore.getState().load(null);
    await useDictationOrganizationStore.getState().load(removed);
    expect(core.fetchDictationOrganization).not.toHaveBeenCalled();
    expect(core.getConfig).not.toHaveBeenCalled();
    expect(core.getConfigForServer).not.toHaveBeenCalled();
    expect(core.patchConfig).not.toHaveBeenCalled();
    expect(core.patchConfigForServer).not.toHaveBeenCalled();
  });

  it('organização sem servidor explícito mantém a leitura legada', async () => {
    vi.mocked(core.fetchDictationOrganization).mockResolvedValue('off');
    await useDictationOrganizationStore.getState().load(undefined);
    expect(core.fetchDictationOrganization).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(useDictationOrganizationStore.getState().byServer['']).toBe('off');
  });

  it('GET atrasado não sobrescreve troca', async () => {
    const getConfig = vi.mocked(core.getConfig);
    const patchConfig = vi.mocked(core.patchConfig);

    let resolveGet!: (v: unknown) => void;
    const getPromise = new Promise((res) => {
      resolveGet = res;
    });
    getConfig.mockReturnValue(getPromise as unknown as Promise<never>);
    patchConfig.mockResolvedValue({ campos: {} } as never);

    const carga = useDitadoEstiloStore.getState().carregar(); // GET em voo
    await useDitadoEstiloStore.getState().trocar('briefing');
    expect(useDitadoEstiloStore.getState().valor).toBe('briefing');

    // GET resolve tarde com valor antigo
    resolveGet(campos('limpar'));
    await carga;
    expect(useDitadoEstiloStore.getState().valor).toBe('briefing');
  });

  it('carregar pinta valor do servidor quando nenhuma escrita no meio', async () => {
    const getConfig = vi.mocked(core.getConfig);
    getConfig.mockResolvedValue(campos('limpar') as never);
    await useDitadoEstiloStore.getState().carregar();
    expect(useDitadoEstiloStore.getState().valor).toBe('limpar');
    expect(useDitadoEstiloStore.getState().pronto).toBe(true);
  });

  it('trocar reverte em falha quando ainda é a última', async () => {
    const patchConfig = vi.mocked(core.patchConfig);
    patchConfig.mockRejectedValue(new Error('502'));
    // primeiro carrega pra ter pronto
    const getConfig = vi.mocked(core.getConfig);
    getConfig.mockResolvedValue(campos('prosa') as never);
    await useDitadoEstiloStore.getState().carregar();
    expect(useDitadoEstiloStore.getState().valor).toBe('prosa');
    await expect(useDitadoEstiloStore.getState().trocar('briefing')).rejects.toThrow('502');
    expect(useDitadoEstiloStore.getState().valor).toBe('prosa');
  });

  it('revalidar força nova leitura mesmo já pronto', async () => {
    const getConfig = vi.mocked(core.getConfig);
    getConfig.mockResolvedValue(campos('prosa') as never);
    await useDitadoEstiloStore.getState().carregar();
    expect(useDitadoEstiloStore.getState().pronto).toBe(true);
    getConfig.mockResolvedValue(campos('briefing') as never);
    await useDitadoEstiloStore.getState().revalidar();
    expect(useDitadoEstiloStore.getState().valor).toBe('briefing');
  });
});
