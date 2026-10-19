/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { FilesState } from './filesStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  let snapshot = {
    ready: false,
    servers: [{ id: 'server-1' }],
  };
  const listeners = new Set<() => void>();
  const ensureActive = vi.fn((id: string) => snapshot.servers.some((server) => server.id === id));
  const setReady = (ready: boolean) => {
    snapshot = { ...snapshot, ready };
    for (const listener of listeners) listener();
  };
  const reset = () => {
    snapshot = { ready: false, servers: [{ id: 'server-1' }] };
    ensureActive.mockClear();
  };
  const useServers = Object.assign(
    (selector: (value: typeof snapshot) => unknown) => {
      const current = React.useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => snapshot,
        () => snapshot,
      );
      return selector(current);
    },
    {
      getState: () => ({ ...snapshot, ensureActive }),
    },
  );
  const fileState: FilesState = {
    abertos: new Set<string>(),
    porPasta: new Map(),
    cortePorPasta: new Map(),
    selecionado: 'README.md',
    conteudo: null,
    diff: null,
    escopo: 'branch' as const,
    resultados: [],
    erro: null,
    soModificados: true,
    buscaCortada: false,
    loading: false,
  };
  const setFileState = (patch: Partial<typeof fileState>) => Object.assign(fileState, patch);
  const use = Object.assign((selector: (value: typeof fileState) => unknown) => selector(fileState), {
    setState: vi.fn(),
  });
  const api = {
    use,
    retain: vi.fn(),
    release: vi.fn(),
    abrir: vi.fn().mockResolvedValue(undefined),
    abrirCitado: vi.fn().mockResolvedValue(undefined),
    buscar: vi.fn().mockResolvedValue(undefined),
    salvar: vi.fn().mockResolvedValue(null),
    recarregar: vi.fn().mockResolvedValue(undefined),
    recarregarDiff: vi.fn().mockResolvedValue(undefined),
    descartar: vi.fn().mockResolvedValue(undefined),
    alternarPasta: vi.fn().mockResolvedValue(undefined),
    setOnlyModified: vi.fn().mockResolvedValue(undefined),
    trocarEscopo: vi.fn().mockResolvedValue(undefined),
  };
  return { get state() { return snapshot; }, reset, setReady, setFileState, useServers, api };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ server: 'server-1', name: 'fixture-files', path: '/tmp/emu/kick.md' }),
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('../../stores/servers', () => ({ useServers: mocks.useServers }));
vi.mock('./filesStore', () => ({
  filesStore: () => mocks.api,
  entriesOf: () => [],
  listaCortadaOf: () => false,
}));
vi.mock('./FileTree', () => ({
  FileTree: ({ onToggleFiltro }: { onToggleFiltro: () => void }) =>
    React.createElement('button', { onClick: onToggleFiltro }, 'toggle-filter'),
}));
vi.mock('./FileSearchBar', () => ({
  FileSearchBar: ({ onBusca }: { onBusca: (q: string, mode: 'names' | 'contents') => void }) =>
    React.createElement('button', { onClick: () => onBusca('', 'contents') }, 'clear-search'),
}));
vi.mock('./FileViewer', () => ({ FileViewer: () => React.createElement('div', null, 'viewer') }));
vi.mock('./FileEditor', () => ({ FileEditor: () => React.createElement('div', null, 'editor') }));
vi.mock('../../paraglide/messages', () => ({
  comum_carregando: () => 'Carregando…',
  chat_servidor_removido: () => 'Servidor removido',
  comum_voltar: () => 'Voltar',
  arq_aba: () => 'Arquivos',
  arq_buscar: () => 'Buscar',
  arq_ver_arquivo: () => 'Arquivo',
  arq_nada_mudou: () => 'Nada mudou',
}));

import FilesSheet from '../../../app/s/[server]/[name]/files';

describe('FilesSheet — deep-link', () => {
  beforeEach(() => {
    mocks.reset();
    mocks.setFileState({ selecionado: 'README.md', erro: null });
    mocks.api.retain.mockClear();
    mocks.api.release.mockClear();
    mocks.api.abrir.mockClear();
    mocks.api.abrirCitado.mockClear();
    mocks.api.buscar.mockClear();
    mocks.api.setOnlyModified.mockClear();
    mocks.api.recarregar.mockClear();
    mocks.api.use.setState.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('espera ready antes de abrir o caminho do deep-link', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(FilesSheet));
    });
    expect(mocks.api.abrirCitado).not.toHaveBeenCalled();

    await act(async () => {
      mocks.setReady(true);
      await Promise.resolve();
    });
    expect(mocks.api.retain).toHaveBeenCalledTimes(1);
    // O caminho vem da citação na conversa: o store resolve antes de ler.
    expect(mocks.api.abrirCitado).toHaveBeenCalledWith('/tmp/emu/kick.md');
    expect(mocks.api.abrir).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Nada mudou');
    // abrir arquivo de outra máquina não troca o servidor ativo
    expect(mocks.useServers.getState().ensureActive).not.toHaveBeenCalled();

    mocks.setFileState({ selecionado: null, erro: 'erro_arq_inexistente' });
    await act(async () => {
      root.render(React.createElement(FilesSheet));
    });
    expect(container.textContent).toContain('erro_arq_inexistente');

    root.unmount();
  });

  it('encaminha busca vazia ao store em vez de limpar apenas a tela', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      mocks.setReady(true);
      root.render(React.createElement(FilesSheet));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Buscar')!.click();
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'clear-search')!.click();
    });

    expect(mocks.api.buscar).toHaveBeenCalledWith('', 'contents');
    expect(mocks.api.use.setState).not.toHaveBeenCalled();
    root.unmount();
  });

  it('encaminha troca de filtro ao store sem alterar estado diretamente', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      mocks.setReady(true);
      root.render(React.createElement(FilesSheet));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Arquivos')!.click();
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'toggle-filter')!.click();
    });

    expect(mocks.api.setOnlyModified).toHaveBeenCalledWith(false);
    expect(mocks.api.use.setState).not.toHaveBeenCalled();
    expect(mocks.api.recarregar).not.toHaveBeenCalled();
    root.unmount();
  });

  it('reserva inset inferior na raiz e mantém filtro funcional', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        mocks.setReady(true);
        root.render(React.createElement(FilesSheet));
      });
      await act(async () => {
        [...container.querySelectorAll('button')].find((button) => button.textContent === 'Arquivos')!.click();
      });
      await act(async () => {
        [...container.querySelectorAll('button')].find((button) => button.textContent === 'toggle-filter')!.click();
      });

      expect(mocks.api.setOnlyModified).toHaveBeenCalledWith(false);
      expect((container.firstElementChild as HTMLElement).style.paddingBottom).toBe('34px');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('servidor fora da lista mostra aviso e não abre nada', async () => {
    mocks.state.servers.length = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      mocks.setReady(true);
      root.render(React.createElement(FilesSheet));
    });
    expect(container.textContent).toContain('Servidor removido');
    expect(mocks.api.retain).not.toHaveBeenCalled();
    expect(mocks.api.abrirCitado).not.toHaveBeenCalled();
    root.unmount();
  });

  it('fechar a rota desmonta o visualizador e libera a retenção do arquivo', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      mocks.setReady(true);
      root.render(React.createElement(FilesSheet));
    });
    expect(container.textContent).toContain('viewer');
    await act(async () => root.unmount());
    expect(container.childElementCount).toBe(0);
    expect(mocks.api.release).toHaveBeenCalledOnce();
    container.remove();
  });
});
