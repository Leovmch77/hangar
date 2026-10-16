// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const drawer = vi.hoisted(() => ({ progress: { value: 0 }, reactions: [] as (() => void)[] }));
vi.mock('react-native-reanimated', async (original) => {
  const { useEffect, useRef } = await import('react');
  return {
    ...(await original<object>()),
    // Roda na montagem e a cada `drawer.reactions` disparado pelo teste, como a thread de UI faria.
    useAnimatedReaction: (prepare: () => unknown, react: (now: unknown, before: unknown) => void) => {
      const before = useRef<unknown>(null);
      useEffect(() => {
        const run = () => { const now = prepare(); react(now, before.current); before.current = now; };
        drawer.reactions.push(run);
        run();
      }, []);
    },
  };
});
vi.mock('react-native-gesture-handler/ReanimatedDrawerLayout', () => ({
  default: ({ renderNavigationView, children }: {
    renderNavigationView: (p: { value: number }) => ReactNode; children: (p: { value: number }) => ReactNode;
  }) => createElement('div', null, renderNavigationView(drawer.progress), children(drawer.progress)),
  DrawerType: {}, DrawerKeyboardDismissMode: {},
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../ui/Glass', () => ({ Glass: () => createElement('span', { 'data-testid': 'glass' }) }));
vi.mock('./SessionList', () => ({ SessionList: () => createElement('span', { 'data-testid': 'list' }) }));

import { SessionsDrawer } from './SessionsDrawer';

it('vidro e lista da gaveta só existem depois que ela começa a abrir', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(SessionsDrawer, { onClose: () => {}, onOpenServers: () => {}, children: 'tela' })));
  const glass = () => container.querySelector('[data-testid="glass"]');
  const list = () => container.querySelector('[data-testid="list"]');
  expect(glass()).toBeNull();
  expect(list()).toBeNull();
  drawer.progress.value = 0.2;
  await act(async () => drawer.reactions.forEach((r) => r()));
  expect(glass()).not.toBeNull();
  expect(list()).not.toBeNull();
  drawer.progress.value = 0;
  await act(async () => drawer.reactions.forEach((r) => r()));
  expect(list()).toBeNull();
  act(() => root.unmount());
});
