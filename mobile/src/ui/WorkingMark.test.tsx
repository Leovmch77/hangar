// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  reduced: false,
  shared: [] as { value: number }[],
  styles: [] as (() => { transform: unknown[] })[],
  timing: vi.fn(), repeat: vi.fn(), cancel: vi.fn(), frame: vi.fn(),
}));
vi.mock('react-native-reanimated', async () => {
  const { useState, createElement } = await import('react');
  return {
    default: {
      View: ({ children }: { children: ReactNode }) => createElement('div', { 'data-animated-view': true }, children),
      createAnimatedComponent: (component: unknown) => component,
    },
    Easing: { linear: (x: number) => x, bezierFn: () => (x: number) => x },
    useAnimatedProps: (fn: () => unknown) => fn(),
    useAnimatedStyle: (fn: () => { transform: unknown[] }) => {
      ui.styles.push(fn);
      return fn();
    },
    useReducedMotion: () => ui.reduced,
    // O driver é a fronteira: o dublê conserva valores até simularmos um quadro nativo.
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
    withDelay: (...args: unknown[]) => ({ delay: args }),
    cancelAnimation: (value: unknown) => ui.cancel(value),
    useFrameCallback: (...args: unknown[]) => { ui.frame(...args); return { setActive: () => {} }; },
  };
});
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ children }: { children: ReactNode }) => createElement('svg', null, children),
    Path: ({ animatedProps }: { animatedProps: object }) => createElement('path', animatedProps),
  };
});

import { WorkingMark, WorkingMarkPaused } from './WorkingMark';

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  ui.shared.length = 0;
  ui.styles.length = 0;
  ui.reduced = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function render(paused: boolean) {
  const el = createElement(WorkingMarkPaused.Provider, { value: paused }, createElement(WorkingMark, { color: '#fff' }));
  if (!root) {
    container = document.createElement('div');
    root = createRoot(container);
  }
  act(() => root!.render(el));
}

it('delega o ciclo à UI e transforma Views externas, sem relógio JS por quadro', () => {
  const raf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  render(false);
  expect(ui.repeat).toHaveBeenCalledWith(expect.anything(), -1, false);
  expect(ui.timing).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ duration: 3200 }));
  expect(ui.styles.length).toBeGreaterThan(0);
  expect(container.querySelectorAll('[data-animated-view] svg').length).toBe(3);
  expect(container.querySelector('svg[transform], path[transform]')).toBeNull();
  expect(ui.frame).not.toHaveBeenCalled();
  expect(raf).not.toHaveBeenCalled();
});

it('fora da vista não inicia e ao esconder cancela; ao voltar retoma sem zerar', () => {
  render(true);
  expect(ui.repeat).not.toHaveBeenCalled();
  render(false);
  expect(ui.repeat).toHaveBeenCalled();
  // O driver nativo publica um quadro antes de a gaveta fechar ou a tela perder foco.
  for (const shared of ui.shared) shared.value = 0.9;
  ui.cancel.mockClear();
  render(true);
  for (const shared of ui.shared) expect(ui.cancel).toHaveBeenCalledWith(shared);
  const stopped = ui.shared.map(shared => shared.value);
  ui.repeat.mockClear();
  render(false);
  expect(ui.repeat).toHaveBeenCalled();
  expect(ui.shared.map(shared => shared.value)).toEqual(stopped);
  ui.cancel.mockClear();
  act(() => root!.unmount());
  root = null;
  for (const shared of ui.shared) expect(ui.cancel).toHaveBeenCalledWith(shared);
});

it('Reduzir Movimento mostra os arcos completos e não inicia animação', () => {
  ui.reduced = true;
  render(false);
  expect(ui.repeat).not.toHaveBeenCalled();
  expect(ui.timing).not.toHaveBeenCalled();
  expect(container.querySelectorAll('path').length).toBe(3);
  for (const path of container.querySelectorAll('path')) expect(path.getAttribute('d')).toContain('A');
  for (const style of ui.styles) expect(style().transform).toEqual([{ rotate: '0deg' }, { scale: 1 }]);
});
