// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AggSession } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ui = vi.hoisted(() => ({
  reduced: false,
  shared: [] as { value: number }[],
  styles: [] as (() => { opacity?: number; transform: unknown[] })[],
  timing: vi.fn(), repeat: vi.fn(), cancel: vi.fn(), frame: vi.fn(),
}));
vi.mock('react-native-reanimated', async () => {
  const { useState, createElement } = await import('react');
  const { View } = await import('react-native');
  return {
    default: {
      View: ({ children, ...props }: import('react-native').ViewProps) => createElement(View, { ...props, ...{ 'data-animated-view': true } }, children),
      createAnimatedComponent: (component: unknown) => component,
    },
    Easing: { linear: (x: number) => x, inOut: (fn: unknown) => fn, quad: (x: number) => x * x, bezierFn: () => (x: number) => x },
    useAnimatedProps: (fn: () => unknown) => fn(),
    useAnimatedStyle: (fn: () => { opacity?: number; transform: unknown[] }) => { ui.styles.push(fn); return fn(); },
    useReducedMotion: () => ui.reduced,
    useSharedValue: (v: number) => useState(() => {
      let current = v;
      const shared = {
        get value() { return current; },
        set value(next: number) { if (typeof next === 'number') current = next; },
      };
      ui.shared.push(shared);
      return shared;
    })[0],
    withTiming: (...args: unknown[]) => { ui.timing(...args); return { timing: args }; },
    withRepeat: (...args: unknown[]) => { ui.repeat(...args); return { repeat: args }; },
    cancelAnimation: (value: unknown) => ui.cancel(value),
    useFrameCallback: (...args: unknown[]) => { ui.frame(...args); return { setActive: () => {} }; },
  };
});

vi.mock('../../ui/ProviderGlyph', async () => {
  const { createElement } = await import('react');
  return { ProviderGlyph: ({ provider, color }: { provider: string; color?: string }) => createElement('span', { 'data-glyph': provider, 'data-color': color ?? '' }) };
});

import { SessionAvatar } from './SessionAvatar';
import { WorkingMarkPaused } from '../../ui/WorkingMark';

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;
const session: AggSession = { name: 'api', provider: 'claude', state: 'working', last_activity: 0, serverId: 's1', serverLabel: 'casa', serverColor: '#00f' };
function render(paused = false, state = session.state, extra: Partial<AggSession> = {}) {
  if (!root) {
    container = document.createElement('div');
    root = createRoot(container);
  }
  act(() => root!.render(createElement(WorkingMarkPaused.Provider, { value: paused }, createElement(SessionAvatar, { session: { ...session, ...extra, state } }))));
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  ui.shared.length = 0;
  ui.styles.length = 0;
  ui.reduced = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('trabalhando respira em 1,6 s e orbita em 1,4 s na UI, sem quadro JS nem transform no SVG', () => {
  const raf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  render();
  expect(ui.timing).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ duration: 800 }));
  expect(ui.repeat).toHaveBeenCalledWith(expect.anything(), -1, true);
  expect(ui.timing).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ duration: 1400 }));
  expect(ui.repeat).toHaveBeenCalledWith(expect.anything(), -1, false);
  expect(container.querySelectorAll('[data-animated-view]').length).toBeGreaterThanOrEqual(2);
  expect(container.querySelector('svg[transform], path[transform]')).toBeNull();
  expect(ui.frame).not.toHaveBeenCalled();
  expect(raf).not.toHaveBeenCalled();
});

it('fora da tela ou com gaveta fechada cancela os ciclos, e retoma ao abrir', () => {
  render(true);
  expect(ui.repeat).not.toHaveBeenCalled();
  render(false);
  expect(ui.repeat).toHaveBeenCalled();
  ui.cancel.mockClear();
  render(true);
  for (const shared of ui.shared) expect(ui.cancel).toHaveBeenCalledWith(shared);
  ui.repeat.mockClear();
  render(false);
  expect(ui.repeat).toHaveBeenCalled();
  ui.cancel.mockClear();
  act(() => root!.unmount());
  root = null;
  for (const shared of ui.shared) expect(ui.cancel).toHaveBeenCalledWith(shared);
});

it('Reduzir Movimento deixa o ponto no topo sem pulsar nem girar', () => {
  ui.reduced = true;
  render();
  expect(ui.repeat).not.toHaveBeenCalled();
  expect(ui.timing).not.toHaveBeenCalled();
  expect(ui.styles.length).toBeGreaterThanOrEqual(2);
  expect(ui.styles.some(style => JSON.stringify(style().transform) === JSON.stringify([{ rotate: '0deg' }]))).toBe(true);
  expect(ui.styles.some(style => JSON.stringify(style().transform) === JSON.stringify([{ scale: 1 }]))).toBe(true);
});

it('reabrir a gaveta conserva a faixa completa da respiração após parar no pico', () => {
  render();
  // O driver da UI publica o pico antes de a gaveta fechar.
  ui.shared[0].value = 1;
  render(true);
  render(false);
  expect(ui.shared[0].value).toBe(0);
  expect(ui.repeat).toHaveBeenCalledWith(expect.anything(), -1, true);
});

it('mudar de trabalhando para pronta cancela os ciclos', () => {
  render();
  expect(ui.repeat).toHaveBeenCalled();
  ui.cancel.mockClear();
  render(false, 'idle');
  for (const shared of ui.shared) expect(ui.cancel).toHaveBeenCalledWith(shared);
});

it('logo da OpenAI pinta na cor do texto do tema, não em branco fixo', () => {
  render(false, 'idle', { provider: 'codex' });
  expect(container.querySelector('[data-glyph="codex"]')?.getAttribute('data-color')).toBe('#000');
});
