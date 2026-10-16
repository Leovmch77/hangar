// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppState, type AppStateStatus } from 'react-native';
import type { LiveVoiceDestination } from './liveVoiceStore';
import type { LiveVoiceView } from './LiveVoiceSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  params: { server: 'saved-a', name: 'session / a' } as { server?: string; name?: string },
  segments: ['s', '[server]', '[name]'] as string[],
  replace: vi.fn(), push: vi.fn(), start: vi.fn(), stop: vi.fn(), setRoute: vi.fn(), foreground: vi.fn(),
  loadSettings: vi.fn(), openFor: vi.fn(), reconcile: vi.fn(), dismissed: vi.fn(), ensureActive: vi.fn(),
  navigate: null as ((destination: LiveVoiceDestination) => void) | null,
}));
vi.mock('expo-router', () => {
  const router = { replace: harness.replace, push: harness.push };
  return { useRouter: () => router, useSegments: () => harness.segments, useGlobalSearchParams: () => harness.params };
});
vi.mock('../../stores/servers', async () => {
  const { create } = await import('zustand');
  return { useServers: create(() => ({ servers: [], ensureActive: harness.ensureActive })) };
});
vi.mock('./liveVoiceStore', async () => {
  const { create } = await import('zustand');
  return { useLiveVoice: create(() => ({
    open: false, view: {} as LiveVoiceView, chatControls: null, settingsByServer: {},
    start: harness.start, stop: harness.stop, setRoute: harness.setRoute, setForeground: harness.foreground,
    loadSettings: harness.loadSettings, openFor: harness.openFor, reconcileServers: harness.reconcile,
    dismiss: harness.dismissed, toggleMute: vi.fn(), setMode: vi.fn(), retry: vi.fn(), saveSettings: vi.fn(), openSettings: vi.fn(), forgetMemory: vi.fn(),
    registerNavigation(navigate: (destination: LiveVoiceDestination) => void) {
      harness.navigate = navigate;
      return () => { if (harness.navigate === navigate) harness.navigate = null; };
    },
  })) };
});
vi.mock('./LiveVoiceSheet', () => ({ LiveVoiceSheet: ({ open, onStop }: { open: boolean; onStop(): void }) => open
  ? <button aria-label="stop-call" onClick={onStop} /> : null }));
vi.mock('./LiveVoiceButton', () => ({ LiveVoiceButton: ({ visible, onPress, error }: { visible: boolean; onPress(): void; error: boolean }) => visible
  ? <button aria-label="open-call" data-error={error} onClick={onPress} /> : null }));

import { useServers } from '../../stores/servers';
import { useLiveVoice } from './liveVoiceStore';
import { LiveVoiceRoot } from './LiveVoiceRoot';
import { LiveVoiceChatButton } from './LiveVoiceChatButton';

const a = { id: 'saved-a', label: 'a', baseUrl: 'https://a.example', token: 'a-token' };
const b = { id: 'saved-b', label: 'b', baseUrl: 'https://b.example', token: 'b-token' };
const idle = (): LiveVoiceView => ({ phase: 'idle', serverLabel: '', state: null, error: null, muted: false,
  levels: { input: 0, output: 0 }, liveSince: null,
  settings: { loading: false, reply: null, error: null, saving: false, saveError: null, accounts: [], models: [], modelsError: null },
  memory: { loading: false, entries: [], error: null, forgetError: null } });

const roots = new Set<Root>();
async function mount(element: ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.add(root);
  await act(async () => root.render(element));
  return { container, root };
}
const button = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  vi.clearAllMocks();
  harness.ensureActive.mockReturnValue(true);
  harness.params = { server: a.id, name: 'session / a' };
  harness.segments = ['s', '[server]', '[name]'];
  harness.navigate = null;
  act(() => {
    useServers.setState({ servers: [a, b], activeId: b.id });
    useLiveVoice.setState({ open: false, view: idle(), chatControls: null, settingsByServer: {} });
  });
});
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.clear();
  vi.restoreAllMocks();
});

test('navegação usa pathname tipado com params, e só a rota refletida publica a tela', async () => {
  const { root } = await mount(<LiveVoiceRoot />);
  expect(harness.setRoute).toHaveBeenLastCalledWith({ serverId: a.id, name: 'session / a', kind: 'chat' });
  harness.setRoute.mockClear();
  await act(async () => harness.navigate!({ kind: 'session', serverId: b.id, name: 'escaped / ? name' }));
  expect(harness.replace).toHaveBeenLastCalledWith({ pathname: '/s/[server]/[name]', params: { server: b.id, name: 'escaped / ? name' } });
  expect(harness.setRoute).not.toHaveBeenCalled();
  harness.params = { server: b.id, name: 'escaped / ? name' };
  await act(async () => root.render(<LiveVoiceRoot />));
  expect(harness.setRoute).toHaveBeenLastCalledWith({ serverId: b.id, name: 'escaped / ? name', kind: 'chat' });
  await act(async () => harness.navigate!({ kind: 'session', serverId: b.id, name: 'escaped / ? name', panel: 'activity' }));
  expect(harness.push).toHaveBeenLastCalledWith({ pathname: '/s/[server]/[name]/activity', params: { server: b.id, name: 'escaped / ? name' } });
  await act(async () => root.unmount());
  roots.delete(root);
  expect(harness.navigate).toBeNull();
});

test('configurações de A com B ativo alinham destino explicitamente; servidor ausente não navega', async () => {
  await mount(<LiveVoiceRoot />);
  harness.ensureActive.mockImplementation((id: string) => { useServers.setState({ activeId: id }); return true; });
  await act(async () => harness.navigate!({ kind: 'settings', serverId: a.id, section: 'voice' }));
  expect(harness.ensureActive).toHaveBeenCalledWith(a.id);
  expect(useServers.getState().activeId).toBe(a.id);
  expect(harness.push).toHaveBeenLastCalledWith('/config/voice');
  harness.push.mockClear();
  harness.ensureActive.mockReturnValue(false);
  await act(async () => harness.navigate!({ kind: 'settings', serverId: b.id, section: null }));
  expect(harness.push).not.toHaveBeenCalled();
});

test('AppState não encerra chamada; controle global continua alcançável sem Composer, inclusive em convite', async () => {
  let onAppState: ((value: AppStateStatus) => void) | undefined;
  const remove = vi.fn();
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onAppState = listener; return { remove };
  });
  act(() => {
    useServers.setState({ servers: [a, { ...b, invite: true }] });
    useLiveVoice.setState({ view: { ...idle(), phase: 'live', serverLabel: a.label } });
  });
  const { container, root } = await mount(<LiveVoiceRoot />);
  await act(async () => onAppState!('background'));
  expect(harness.foreground).toHaveBeenLastCalledWith(false);
  expect(harness.stop).not.toHaveBeenCalled();
  await act(async () => onAppState!('active'));
  expect(harness.foreground).toHaveBeenLastCalledWith(true);
  await act(async () => button(container, 'open-call').click());
  await act(async () => button(container, 'stop-call').click());
  expect(harness.stop).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  roots.delete(root);
  expect(remove).toHaveBeenCalledOnce();
});

test('botão da conversa usa A com B ativo; falha de settings continua visível e convite não liga', async () => {
  act(() => useLiveVoice.setState({ settingsByServer: { [a.id]: { server: a, view: { ...idle().settings, error: 'settings_failed' } } } }));
  const { container, root } = await mount(<LiveVoiceChatButton serverId={a.id} name="session-a" />);
  expect(harness.loadSettings).toHaveBeenCalledWith(a);
  expect(button(container, 'open-call').getAttribute('data-error')).toBe('true');
  await act(async () => button(container, 'open-call').click());
  expect(harness.openFor).toHaveBeenCalledWith(a.id, 'session-a');
  harness.loadSettings.mockClear();
  await act(async () => {
    useServers.setState({ servers: [a, { ...b, invite: true }] });
    root.render(<LiveVoiceChatButton serverId={b.id} name="guest" />);
  });
  expect(button(container, 'open-call')).toBeNull();
  expect(harness.loadSettings).not.toHaveBeenCalled();
});
