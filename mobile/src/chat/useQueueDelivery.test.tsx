// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureApi, type Server } from '@hangar/core';
import { useDeliveryMode, useQueueDelivery } from './useQueueDelivery';
import { QueuePanel } from './QueuePanel';
import * as m from '../paraglide/messages';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('../stores/prefs', () => ({ prefs: { getString: (key: string) => disk.get(key), set: (key: string, value: string) => disk.set(key, value) } }));
vi.mock('@react-native-menu/menu', () => ({ MenuView: () => null }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Glass', () => ({ Glass: ({ children }: { children: React.ReactNode }) => createElement('div', null, children) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const first: Server = { id: 'one', label: 'one', baseUrl: 'https://one.test', token: 'one-token' };
const second: Server = { id: 'two', label: 'two', baseUrl: 'https://two.test', token: 'two-token' };
function Controls({ server = first }: { server?: Server }) {
  const delivery = useQueueDelivery(server, true);
  return createElement(QueuePanel, { panel: { entries: [], actions: true }, delivery, editingId: null, busy: false,
    onModeChange: useDeliveryMode.getState().setMode, onEdit: vi.fn(), onCancelEdit: vi.fn(), onSteer: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() });
}
let root: Root;
let container: HTMLDivElement;
const button = (name: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
beforeEach(() => {
  useDeliveryMode.setState({ mode: 'queued' }); disk.clear();
  configureApi({ getBaseUrl: () => 'https://wrong.test', getToken: () => 'wrong', onUnauthorized: vi.fn(), origin: null, createEventSource: vi.fn() });
  vi.stubGlobal('fetch', vi.fn());
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('troca Direto/Jev sem fechar o painel e grava uma única escolha', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('{"available":true}'));
  await act(async () => root.render(createElement(Controls)));
  act(() => button(m.native_queue_panel_direct()).click());
  expect(useDeliveryMode.getState().mode).toBe('direct');
  act(() => button(m.native_queue_jev()).click());
  expect(useDeliveryMode.getState().mode).toBe('jev');
  expect(disk.get('queue.deliveryMode')).toBe('jev');
  act(() => button(m.native_queue_jev()).click());
  expect(useDeliveryMode.getState().mode).toBe('queued');
  expect(container.textContent).toContain(m.queue_panel_title());
});

it('mudança de servidor invalida disponibilidade e ignora a resposta antiga', async () => {
  let resolveFirst!: (response: Response) => void;
  let resolveSecond!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation((url) => new Promise<Response>((resolve) => {
    if (String(url).startsWith('https://one.test')) resolveFirst = resolve;
    else resolveSecond = resolve;
  }));
  await act(async () => root.render(createElement(Controls)));
  expect(button(m.native_queue_jev()).disabled).toBe(true);
  expect(container.textContent).toContain(m.native_queue_jev_loading());
  await act(async () => root.render(createElement(Controls, { server: second })));
  await act(async () => resolveSecond(new Response('{"available":false}')));
  expect(container.textContent).toContain(m.native_queue_jev_setup());
  await act(async () => resolveFirst(new Response('{"available":true}')));
  expect(button(m.native_queue_jev()).disabled).toBe(true);
  expect(container.textContent).toContain(m.native_queue_jev_setup());
});

it.each([404, 503])('explica falha %s e deixa Direto disponível', async (status) => {
  vi.mocked(fetch).mockResolvedValue(new Response('{"detail":"fixture-error"}', { status }));
  await act(async () => root.render(createElement(Controls)));
  expect(button(m.native_queue_jev()).disabled).toBe(true);
  expect(button(m.native_queue_panel_direct()).disabled).toBe(false);
  expect(container.textContent).toContain(status === 404 ? m.native_queue_jev_unsupported() : 'fixture-error');
});

it('reconfere configuração depois de trinta segundos e limpa o timer ao sair', async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementation(async () => new Response('{"available":true}'));
  await act(async () => root.render(createElement(Controls)));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(2);
  act(() => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(fetch).toHaveBeenCalledTimes(2);
});
