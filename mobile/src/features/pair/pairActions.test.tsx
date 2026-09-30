/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

const mocks = vi.hoisted(() => {
  const deferred = <T,>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const params = { server: 'server-1', name: 'fixture-a' };
  const servers = { ready: true, servers: [{ id: 'server-1' }] };
  let rows = [{ serverId: 'server-1', name: 'fixture-a', pair_peers: [] as string[] }];
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const setPeers = (peers: string[]) => {
    rows = rows.map((row) => (row.name === 'fixture-a' ? { ...row, pair_peers: peers } : row));
    for (const listener of listeners) listener();
  };
  const useSessions = (selector: (value: { rows: typeof rows }) => unknown) => {
    const current = React.useSyncExternalStore(subscribe, () => rows, () => rows);
    return selector({ rows: current });
  };
  const useServers = (selector: (value: typeof servers) => unknown) => selector(servers);
  const back = vi.fn();
  const alert = vi.fn();
  const core = {
    fetchSessionsForServer: vi.fn(),
    getHistory: vi.fn(),
    getPairContract: vi.fn(),
    pairSession: vi.fn(),
    unpairSession: vi.fn(),
    formataErro: (value: unknown) => String(value),
  };
  const reset = (peers: string[]) => {
    params.name = 'fixture-a';
    rows = [{ serverId: 'server-1', name: 'fixture-a', pair_peers: peers }];
    back.mockClear();
    alert.mockClear();
    core.fetchSessionsForServer.mockReset().mockResolvedValue([
      { name: 'fixture-a', state: 'idle' },
      { name: 'fixture-b', state: 'idle' },
    ]);
    core.getHistory.mockReset().mockResolvedValue([]);
    core.getPairContract.mockReset().mockResolvedValue({ path: '/tmp/contrato.md', content: '' });
    core.pairSession.mockReset();
    core.unpairSession.mockReset();
  };
  return { deferred, params, setPeers, useSessions, useServers, back, alert, core, reset };
});

vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Alert: { alert: mocks.alert },
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: (props: { children?: React.ReactNode }) => React.createElement('div', null, props.children),
}));
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: () => null }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ ...mocks.params }),
  useRouter: () => ({ back: mocks.back, push: vi.fn() }),
}));
vi.mock('@hangar/core', () => mocks.core);
vi.mock('../../stores/servers', () => ({ useServers: mocks.useServers }));
vi.mock('../../stores/sessions', () => ({ useSessions: mocks.useSessions }));
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({}) }));
vi.mock('./PairFeed', () => ({ PairFeed: () => null }));
vi.mock('./PairPicker', () => ({
  PairPicker: (props: { busy: boolean; loading: boolean; error: string; onToggle: (peer: string) => void; onPair: () => void }) =>
    React.createElement('div', { 'data-testid': 'picker', 'data-busy': String(props.busy), 'data-loading': String(props.loading) },
      React.createElement('button', { 'data-testid': 'pick', onClick: () => props.onToggle('fixture-b') }),
      React.createElement('button', { 'data-testid': 'pair', onClick: props.onPair })),
}));
vi.mock('./PairMembers', () => ({
  PairMembers: (props: { busy: boolean; onLeave: () => void }) =>
    React.createElement('div', { 'data-testid': 'members', 'data-busy': String(props.busy) },
      React.createElement('button', { 'data-testid': 'leave', onClick: props.onLeave })),
}));
vi.mock('../../paraglide/messages', () => ({
  comum_carregando: () => 'Carregando…',
  comum_voltar: () => 'Voltar',
  comum_cancelar: () => 'Cancelar',
  comum_confirmar: () => 'Confirmar',
  comandos_confirmar: () => 'Confirmar?',
  par_sair_grupo: () => 'Sair do grupo',
  par_contrato_titulo: () => 'Contrato',
  par_contrato_falhou: () => 'Contrato falhou',
  forward_nao_listou: () => 'Não listou',
  compare_servidor_nao_encontrado: () => 'Servidor não encontrado',
  par_falhou_pareamento: ({ nomes }: { nomes: string }) => `Falhou o pareamento com ${nomes}.`,
  par_falhou_saida: () => 'Falhou a saída do grupo.',
}));

import PairSheet from '../../../app/s/[server]/[name]/pair';

let root: Root;
let container: HTMLDivElement;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = (id: string) => act(() => { byTestId(id)!.click(); });

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(PairSheet)); });
  await flush();
}

async function startPair<T>() {
  const pending = mocks.deferred<T>();
  mocks.core.pairSession.mockReturnValue(pending.promise);
  await mount();
  click('pick');
  click('pair');
  expect(mocks.core.pairSession).toHaveBeenCalledTimes(1);
  expect(byTestId('picker')!.dataset.busy).toBe('true');
  return pending;
}

describe('PairSheet — ação em voo sobrevive à atualização de pair_peers', () => {
  beforeEach(() => {
    mocks.reset([]);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
  });

  it('falha do pareamento aparece mesmo com pair_peers mudando no meio do POST', async () => {
    const pending = await startPair<{ warning?: string }>();
    await act(async () => { mocks.setPeers(['fixture-b']); });
    await flush();
    expect(byTestId('members')!.dataset.busy).toBe('true');

    await act(async () => { pending.reject(new Error('restore')); });
    await flush();

    expect(container.textContent).toContain('Falhou o pareamento com fixture-b.');
    expect(byTestId('members')!.dataset.busy).toBe('false');
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it('aviso de entrega parcial aparece após a lista atualizar', async () => {
    const pending = await startPair<{ warning?: string }>();
    await act(async () => { mocks.setPeers(['fixture-b']); });
    await flush();

    await act(async () => { pending.resolve({ warning: 'entrega parcial para fixture-b' }); });
    await flush();

    expect(container.textContent).toContain('entrega parcial para fixture-b');
    expect(byTestId('members')!.dataset.busy).toBe('false');
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it('sucesso fecha a folha mesmo com a lista atualizada durante o POST', async () => {
    const pending = await startPair<{ warning?: string }>();
    await act(async () => { mocks.setPeers(['fixture-b']); });
    await flush();

    await act(async () => { pending.resolve({}); });
    await flush();

    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it('desmontar a tela descarta o retorno do pareamento', async () => {
    const pending = await startPair<{ warning?: string }>();
    act(() => root.unmount());

    await act(async () => { pending.resolve({}); });
    await flush();

    expect(mocks.back).not.toHaveBeenCalled();
  });

  it('trocar a rota descarta o retorno e libera o botão da rota nova', async () => {
    const pending = await startPair<{ warning?: string }>();
    mocks.params.name = 'fixture-c';
    await act(async () => { root.render(React.createElement(PairSheet)); });
    await flush();
    expect(byTestId('picker')!.dataset.busy).toBe('false');

    await act(async () => { pending.reject(new Error('rota antiga')); });
    await flush();

    expect(container.textContent).not.toContain('Falhou o pareamento');
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it('falha ao sair do grupo aparece mesmo com pair_peers esvaziando no meio do POST', async () => {
    mocks.reset(['fixture-b']);
    const pending = mocks.deferred<{ warning?: string }>();
    mocks.core.unpairSession.mockReturnValue(pending.promise);
    await mount();

    click('leave');
    const buttons = mocks.alert.mock.calls[0][2] as Array<{ onPress?: () => void }>;
    act(() => { buttons[1].onPress?.(); });
    expect(mocks.core.unpairSession).toHaveBeenCalledTimes(1);

    await act(async () => { mocks.setPeers([]); });
    await flush();
    expect(byTestId('picker')!.dataset.busy).toBe('true');

    await act(async () => { pending.reject(new Error('saída')); });
    await flush();

    expect(container.textContent).toContain('Falhou a saída do grupo.');
    expect(byTestId('picker')!.dataset.busy).toBe('false');
  });

  it('confirmar a saída depois da lista atualizar ainda dispara a ação', async () => {
    mocks.reset(['fixture-b']);
    mocks.core.unpairSession.mockResolvedValue({});
    await mount();

    click('leave');
    await act(async () => { mocks.setPeers(['fixture-b', 'fixture-c']); });
    await flush();
    const buttons = mocks.alert.mock.calls[0][2] as Array<{ onPress?: () => void }>;
    act(() => { buttons[1].onPress?.(); });
    await flush();

    expect(mocks.core.unpairSession).toHaveBeenCalledTimes(1);
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });
});
