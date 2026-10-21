// @vitest-environment happy-dom
import { act, createElement, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatState } from '../stores/chat';
import type { ChatBodyProps } from './ChatBody';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  size: { width: 390, height: 844, scale: 1, fontScale: 1 },
  retain: vi.fn(), release: vi.fn(), bodyMounts: 0,
  session: { serverId: 'srv', name: 'chat', provider: 'claude', tracked: true, state: 'idle' },
  router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), canGoBack: () => false, back: vi.fn() },
  navigation: { getState: () => ({ routes: [{ key: 'home' }, { key: 'chat' }] }), addListener: () => () => {} },
}));

vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(), useWindowDimensions: () => h.size,
}));
vi.mock('expo-router', () => ({
  useRouter: () => h.router, useIsFocused: () => true,
  useLocalSearchParams: () => ({ server: 'srv', name: 'chat' }),
  useNavigation: () => h.navigation, useRoute: () => ({ key: 'chat' }),
}));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(), fetchSessionsForServer: async () => [h.session],
}));
vi.mock('../stores/chat', () => {
  const use = create<Partial<ChatState>>(() => ({
    events: [], eventsRevision: 0, pending: [], loading: false, error: '',
    stateEvent: { session: 'chat', state: 'idle' }, askOpen: false,
  }));
  const chat = { use, retain: h.retain, release: h.release };
  return { chatStore: () => chat };
});
vi.mock('../stores/servers', () => {
  const state = { ready: true, servers: [{ id: 'srv', label: 'local' }], ensureActive: () => true, ensureOwnActive: () => {} };
  return { useServers: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock('../stores/sessions', () => {
  const state = { rows: [h.session], retain: () => () => {} };
  return { useSessions: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock('../stores/newConversation', () => ({
  useNewConversation: (select: (s: unknown) => unknown) => select({ attempts: {}, busy: {}, issues: {} }),
  readFirstInput: () => null, confirmFirstInput: () => {},
}));
vi.mock('../features/voice/liveVoiceStore', () => ({ useLiveVoice: { getState: () => ({ registerChat: () => () => {} }) } }));
vi.mock('../features/activity/useActivity', () => ({ useActivity: () => ({ agents: [] }) }));
vi.mock('../ui/Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => children }));
vi.mock('../features/sessions/SessionsDrawer', () => ({ SessionsDrawer: ({ children }: { children: ReactNode }) => children }));
vi.mock('../features/sessions/ServerSheet', () => ({ ServerSheet: () => null }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children: ReactNode }) => children }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/EdgeButton', () => ({ EdgeButton: ({ children, onPress, accessibilityLabel }: { children: ReactNode; onPress: () => void; accessibilityLabel: string }) =>
  createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children) }));
vi.mock('../ui/WorkingMark', async () => ({ WorkingMarkPaused: (await import('react')).createContext(false), WorkingMark: () => null }));
vi.mock('../features/sessions/SessionAvatar', () => ({ SessionAvatar: () => null }));
vi.mock('../features/voice/LiveVoiceChatButton', () => ({ LiveVoiceChatButton: () => null }));
vi.mock('./BubbleActions', () => ({ pararTts: () => {} }));
vi.mock('./LoopChip', () => ({ LoopChip: () => null }));
vi.mock('./MessageList', () => ({ MessageList: () => null }));
vi.mock('./ComposerField', () => ({
  ComposerDock: ({ children }: { children: ReactNode }) => children,
  ComposerViewport: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./Composer', () => ({ Composer: function DraftField() {
  const [text, setText] = useState('');
  return createElement('textarea', { value: text, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value) });
} }));
vi.mock('./ComposerStatusLine', () => ({ ComposerStatusLine: () => null }));
vi.mock('./OrqFooter', () => ({ OrqFooter: () => null }));
vi.mock('./TuiPill', () => ({ TuiPill: () => null }));
vi.mock('./RecarregarPill', () => ({ RecarregarPill: () => null }));
vi.mock('./MoreSheet', () => ({ MoreSheet: () => null }));
vi.mock('./PluginUi', () => ({ PluginUi: () => null }));
vi.mock('./OptionButtons', () => ({ OptionButtons: () => null }));
vi.mock('./PendingPlan', () => ({ PendingPlan: () => null }));
vi.mock('./SessionPickerSheet', () => ({ SessionPickerSheet: () => null }));
vi.mock('./PlanActions', () => ({ PlanActions: () => null }));
vi.mock('./ChatBody', async (original) => {
  const { ChatBody } = await original<typeof import('./ChatBody')>();
  return { ChatBody: function ObservedBody(props: ChatBodyProps) {
    const instance = useRef<number | null>(null);
    if (instance.current === null) instance.current = ++h.bodyMounts;
    return createElement('div', { 'data-body-instance': instance.current }, createElement(ChatBody, props));
  } };
});

import ChatScreen from '../../app/s/[server]/[name]/index';
import { ChatBody } from './ChatBody';
import * as m from '../paraglide/messages';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  h.size = { width: 390, height: 844, scale: 1, fontScale: 1 };
  h.bodyMounts = 0;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('girar e estreitar a janela conserva o ChatBody, o rascunho e a conexão', async () => {
  await act(async () => root.render(createElement(ChatScreen)));
  expect(host.querySelector('[data-body-instance]')).not.toBeNull();
  const instance = host.querySelector('[data-body-instance]')!.getAttribute('data-body-instance');
  const field = host.querySelector('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'rascunho ao girar');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(field.value).toBe('rascunho ao girar');
  for (const size of [{ width: 1180, height: 820 }, { width: 507, height: 820 }, { width: 820, height: 1180 }]) {
    h.size = { ...h.size, ...size };
    await act(async () => root.render(createElement(ChatScreen)));
    expect(host.querySelector('[data-body-instance]')!.getAttribute('data-body-instance')).toBe(instance);
    expect(host.querySelector('textarea')).toBe(field);
    expect(host.querySelector('textarea')!.value).toBe('rascunho ao girar');
    expect(h.retain).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
  }
});

it('cabeçalho de tablet troca a navegação pelo painel sem remontar o campo', async () => {
  const onTogglePanel = vi.fn();
  const onOpenMore = vi.fn();
  const props: ChatBodyProps = { serverId: 'srv', name: 'chat', onBack: vi.fn(), deepStack: true, onTogglePanel, onOpenMore };
  await act(async () => root.render(createElement(ChatBody, props)));
  const field = host.querySelector('textarea');
  expect(host.querySelector(`[aria-label="${m.chat_voltar_sessoes()}"]`)).not.toBeNull();
  expect(host.querySelector(`[aria-label="${m.ctx_painel_titulo()}"]`)).toBeNull();
  await act(async () => root.render(createElement(ChatBody, { ...props, header: 'tablet' })));
  const panel = host.querySelector<HTMLButtonElement>(`[aria-label="${m.ctx_painel_titulo()}"]`);
  expect(panel).not.toBeNull();
  expect(host.querySelector(`[aria-label="${m.chat_voltar_sessoes()}"]`)).toBeNull();
  expect(host.querySelector(`[aria-label="${m.chat_ir_inicio()}"]`)).toBeNull();
  act(() => panel!.click());
  act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${m.navbar_mais_acoes()}"]`)!.click());
  expect(onTogglePanel).toHaveBeenCalledTimes(1);
  expect(onOpenMore).toHaveBeenCalledTimes(1);
  expect(host.querySelector('textarea')).toBe(field);
  expect(h.retain).toHaveBeenCalledTimes(1);
});
