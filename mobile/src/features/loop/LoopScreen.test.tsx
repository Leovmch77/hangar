// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const route = vi.hoisted(() => ({ params: { server: 'a', name: 'session' }, back: vi.fn(), screen: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => route, useLocalSearchParams: () => route.params, Stack: { Screen: ({ options }: { options: object }) => { route.screen(options); return null; } } }));
vi.mock('react-native-unistyles', async (original) => {
  const module = await original<typeof import('react-native-unistyles')>();
  return { ...module, useUnistyles: () => { const value = module.useUnistyles(); return { ...value, theme: new Proxy(value.theme, {}) }; } };
});
vi.mock('../../stores/servers', () => ({ useServers: Object.assign((select: (state: { servers: [] }) => unknown) => select({ servers: [] }), { getState: () => ({ servers: [] }) }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children: ReactNode }) => children }));
vi.mock('./LoopForm', () => ({ LoopForm: () => null }));
vi.mock('./LoopStatus', () => ({ LoopStatus: () => null }));
import LoopScreen from '../../../app/s/[server]/[name]/loop';

it('preserva opções da folha ao redesenhar sem alteração', async () => {
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(LoopScreen)));
    const initial = route.screen.mock.calls.at(-1)![0];
    await act(async () => root.render(createElement(LoopScreen)));
    expect(route.screen.mock.calls.at(-1)![0]).toBe(initial);
  } finally {
    await act(async () => root.unmount());
  }
});
