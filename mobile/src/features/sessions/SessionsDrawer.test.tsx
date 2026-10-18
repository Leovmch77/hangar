// @vitest-environment happy-dom
import { act, createElement, createRef, useEffect, useImperativeHandle, type ReactNode, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DrawerLayoutMethods, DrawerLayoutProps } from 'react-native-gesture-handler/ReanimatedDrawerLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const route = vi.hoisted(() => ({ focused: true, back: vi.fn(), dismissTo: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
const nativeBack = vi.hoisted(() => ({
  listeners: new Set<() => boolean>(),
  exitApp: vi.fn(),
  press() {
    const handled = [...this.listeners].reverse().some((listener) => listener());
    if (!handled) this.exitApp();
    return handled;
  },
}));
const drawer = vi.hoisted(() => ({ progress: { value: 0 }, reactions: [] as (() => void)[], openDrawer: vi.fn(), closeDrawer: vi.fn() }));
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => route.focused ? effect() : undefined, [effect, route.focused]),
}));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Platform: { get OS() { return platform.OS; } },
  BackHandler: {
    addEventListener: (event: string, listener: () => boolean) => {
      if (event === 'hardwareBackPress') nativeBack.listeners.add(listener);
      return { remove: () => { nativeBack.listeners.delete(listener); } };
    },
    exitApp: nativeBack.exitApp,
  },
}));
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
  default: ({ ref, renderNavigationView, children, onDrawerOpen, onDrawerClose }: Pick<DrawerLayoutProps, 'onDrawerOpen' | 'onDrawerClose'> & {
    ref?: Ref<DrawerLayoutMethods>;
    renderNavigationView: (progress: { value: number }) => ReactNode;
    children: ReactNode | ((progress: { value: number }) => ReactNode);
  }) => {
    drawer.openDrawer.mockImplementation(() => {
      drawer.progress.value = 1;
      drawer.reactions.forEach((r) => r());
      onDrawerOpen?.();
    });
    drawer.closeDrawer.mockImplementation(() => {
      drawer.progress.value = 0;
      drawer.reactions.forEach((r) => r());
      onDrawerClose?.();
    });
    useImperativeHandle(ref, () => ({ openDrawer: drawer.openDrawer, closeDrawer: drawer.closeDrawer }), []);
    return createElement('div', null,
      createElement('button', { 'aria-label': 'gesto-abrir', onClick: () => { drawer.progress.value = 1; drawer.reactions.forEach((r) => r()); onDrawerOpen?.(); } }),
      createElement('button', { 'aria-label': 'gesto-fechar', onClick: () => { drawer.progress.value = 0; drawer.reactions.forEach((r) => r()); onDrawerClose?.(); } }),
      renderNavigationView(drawer.progress), typeof children === 'function' ? children(drawer.progress) : children);
  },
  DrawerType: {}, DrawerKeyboardDismissMode: {}, DrawerLockMode: { UNLOCKED: 0, LOCKED_CLOSED: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../ui/Glass', () => ({ Glass: () => createElement('span', { 'data-testid': 'glass' }) }));
vi.mock('./DrawerMenu', async () => {
  const { useContext } = await import('react');
  const { WorkingMarkPaused } = await import('../../ui/WorkingMark');
  return { DrawerMenu: () => createElement('span', { 'data-testid': 'list', 'data-paused': String(useContext(WorkingMarkPaused)) }) };
});

import { BackHandler } from 'react-native';
import { drawerEdgeSlop, SessionsDrawer, shouldOpenDrawer } from './SessionsDrawer';

const roots = new Set<Root>();
beforeEach(() => {
  vi.clearAllMocks();
  route.focused = true;
  platform.OS = 'android';
  nativeBack.listeners.clear();
  drawer.progress.value = 0;
  drawer.reactions = [];
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
});

it.each(['home', 'chat'] as const)('Back fecha só a gaveta de %s; o segundo Back segue a navegação normal', async (screen) => {
  BackHandler.addEventListener('hardwareBackPress', () => {
    if (screen === 'home') return false;
    route.back();
    return true;
  });
  const ref = createRef<DrawerLayoutMethods>();
  const onClose = vi.fn(() => screen === 'home' ? ref.current?.closeDrawer() : route.dismissTo('/'));
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.add(root);
  await act(async () => root.render(createElement(SessionsDrawer, { ref, onClose, onOpenServers: () => {}, children: 'tela' })));
  await act(async () => ref.current!.openDrawer());
  expect(container.querySelector('[data-testid="glass"]')).not.toBeNull();

  await act(async () => { nativeBack.press(); });
  expect(drawer.closeDrawer).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="glass"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(route.dismissTo).not.toHaveBeenCalled();
  expect(route.back).not.toHaveBeenCalled();
  expect(nativeBack.exitApp).not.toHaveBeenCalled();

  await act(async () => { nativeBack.press(); });
  expect(drawer.closeDrawer).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(route.back).toHaveBeenCalledTimes(screen === 'chat' ? 1 : 0);
  expect(nativeBack.exitApp).toHaveBeenCalledTimes(screen === 'home' ? 1 : 0);
});

it('com openOnBack, o Back abre a gaveta fechada e, com ela aberta, segue a navegação normal', async () => {
  const ref = createRef<DrawerLayoutMethods>();
  const root = createRoot(document.createElement('div'));
  roots.add(root);
  await act(async () => root.render(createElement(SessionsDrawer, { ref, openOnBack: true, onClose: () => {}, onOpenServers: () => {}, children: 'tela' })));

  await act(async () => { nativeBack.press(); });
  expect(drawer.openDrawer).toHaveBeenCalledTimes(1);
  expect(nativeBack.exitApp).not.toHaveBeenCalled();

  await act(async () => { nativeBack.press(); });
  expect(drawer.closeDrawer).not.toHaveBeenCalled();
  expect(nativeBack.exitApp).toHaveBeenCalledTimes(1);
});

it('openOnBack não intercepta o Back fora de foco nem no iOS', async () => {
  const root = createRoot(document.createElement('div'));
  roots.add(root);
  const render = () => act(async () => root.render(createElement(SessionsDrawer, { openOnBack: true, onClose: () => {}, onOpenServers: () => {}, children: 'tela' })));
  route.focused = false;
  await render();
  expect(nativeBack.listeners.size).toBe(0);
  route.focused = true;
  platform.OS = 'ios';
  await render();
  expect(nativeBack.listeners.size).toBe(0);
});

it('Back respeita foco e limpa a interceptação ao perder foco e desmontar', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.add(root);
  const onClose = vi.fn();
  const render = () => act(async () => root.render(createElement(SessionsDrawer, { onClose, onOpenServers: () => {}, children: 'tela' })));
  await render();
  expect(nativeBack.listeners.size).toBe(0);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="gesto-abrir"]')!.click());
  expect(nativeBack.listeners.size).toBe(1);

  route.focused = false;
  await render();
  expect(nativeBack.listeners.size).toBe(0);
  await act(async () => { expect(nativeBack.press()).toBe(false); });
  expect(drawer.closeDrawer).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="glass"]')).not.toBeNull();

  route.focused = true;
  await render();
  expect(nativeBack.listeners.size).toBe(1);
  await act(async () => { expect(nativeBack.press()).toBe(true); });
  expect(drawer.closeDrawer).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="glass"]')).toBeNull();

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="gesto-abrir"]')!.click());
  expect(nativeBack.listeners.size).toBe(1);
  await act(async () => root.unmount());
  roots.delete(root);
  expect(nativeBack.listeners.size).toBe(0);
  await act(async () => { expect(nativeBack.press()).toBe(false); });
  expect(drawer.closeDrawer).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it('Back após fechar por gesto segue normal sem chamar onClose', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.add(root);
  const onClose = vi.fn();
  await act(async () => root.render(createElement(SessionsDrawer, { onClose, onOpenServers: () => {}, children: 'tela' })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="gesto-abrir"]')!.click());
  expect(nativeBack.listeners.size).toBe(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="gesto-fechar"]')!.click());
  expect(nativeBack.listeners.size).toBe(0);
  expect(container.querySelector('[data-testid="glass"]')).toBeNull();
  await act(async () => { expect(nativeBack.press()).toBe(false); });
  expect(nativeBack.exitApp).toHaveBeenCalledTimes(1);
  expect(drawer.closeDrawer).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('iOS não intercepta Back com a gaveta aberta', async () => {
  platform.OS = 'ios';
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.add(root);
  const ref = createRef<DrawerLayoutMethods>();
  const onClose = vi.fn();
  await act(async () => root.render(createElement(SessionsDrawer, { ref, onClose, onOpenServers: () => {}, children: 'tela' })));
  await act(async () => ref.current!.openDrawer());
  expect(nativeBack.listeners.size).toBe(0);
  await act(async () => { expect(nativeBack.press()).toBe(false); });
  expect(container.querySelector('[data-testid="glass"]')).not.toBeNull();
  expect(drawer.closeDrawer).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('vidro só com a gaveta aberta; a lista nasce na primeira abertura e fica, com as marcas paradas fechada', async () => {
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
  expect(list()!.getAttribute('data-paused')).toBe('false');
  drawer.progress.value = 0;
  await act(async () => drawer.reactions.forEach((r) => r()));
  expect(glass()).toBeNull();
  expect(list()).not.toBeNull();
  expect(list()!.getAttribute('data-paused')).toBe('true');
  act(() => root.unmount());
});

it('a faixa de arrasto começa depois da borda reservada ao voltar do iOS e tem a largura padrão do Android', () => {
  // hitSlop do gesture-handler: left negativo desloca a origem para dentro, width fixa a faixa.
  // 20 dp é a faixa do DrawerLayout do Android; mais larga, ela cobre o começo do conteúdo (16 dp).
  expect(drawerEdgeSlop(20)).toEqual({ left: -20, width: 20 });
});

it('abre com arrasto longo ou rápido, não com toque de leve', () => {
  expect(shouldOpenDrawer(41, 0)).toBe(true);
  expect(shouldOpenDrawer(10, 600)).toBe(true);
  expect(shouldOpenDrawer(20, 100)).toBe(false);
});
