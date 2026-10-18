// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ui = vi.hoisted(() => ({
  reduced: false,
  styles: [] as (() => { transform: { scaleY: number }[] })[],
  repeat: vi.fn(), cancel: vi.fn(),
}));
vi.mock('react-native-reanimated', async () => {
  const { useState, createElement } = await import('react');
  return {
    default: { View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-animated-view': true }, children),
      createAnimatedComponent: (component: unknown) => component },
    Easing: { linear: (x: number) => x, quad: (x: number) => x, out: (f: unknown) => f, bezierFn: () => (x: number) => x },
    useAnimatedStyle: (fn: () => { transform: { scaleY: number }[] }) => { ui.styles.push(fn); return fn(); },
    useReducedMotion: () => ui.reduced,
    // O driver é a fronteira: animação vira objeto opaco, só número atribuído direto muda o valor.
    useSharedValue: (v: number) => useState(() => {
      let current = v;
      return { get value() { return current; }, set value(next: number) { if (typeof next === 'number') current = next; } };
    })[0],
    withTiming: (...args: unknown[]) => ({ timing: args }),
    withRepeat: (...args: unknown[]) => { ui.repeat(...args); return { repeat: args }; },
    cancelAnimation: (value: unknown) => ui.cancel(value),
  };
});

const { VoiceBars } = await import('./VoiceBars');
const { WorkingMarkPaused } = await import('../../ui/WorkingMark');
type Mode = Parameters<typeof VoiceBars>[0]['mode'];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  ui.styles.length = 0;
  ui.reduced = false;
  vi.clearAllMocks();
});
const render = (mode: Mode, paused = false) => act(() => root.render(
  createElement(WorkingMarkPaused.Provider, { value: paused }, createElement(VoiceBars, { mode, color: '#fff', count: 5 }))));
// Última leitura de cada uma das 5 barras.
const scales = () => ui.styles.slice(-5).map(fn => fn().transform[0].scaleY);

it('onda contínua roda na UI e desliga quando a tela sai de vista', () => {
  render({ kind: 'wave', fast: true });
  expect(ui.repeat).toHaveBeenCalledWith(expect.anything(), -1, false);
  expect(host.querySelectorAll('[data-animated-view]')).toHaveLength(5);
  ui.repeat.mockClear();
  render({ kind: 'wave', fast: true }, true);
  expect(ui.cancel).toHaveBeenCalled();
  expect(ui.repeat).not.toHaveBeenCalled();
});

it('parada e movimento reduzido não ligam relógio', () => {
  render({ kind: 'rest' });
  expect(ui.repeat).not.toHaveBeenCalled();
  expect(new Set(scales()).size).toBe(1);
  ui.reduced = true;
  render({ kind: 'wave', fast: false });
  expect(ui.repeat).not.toHaveBeenCalled();
});

it('no modo nível, o centro cresce com o volume de quem fala e o silêncio fica no piso', () => {
  ui.reduced = true;
  render({ kind: 'level', value: 0 });
  const quiet = scales();
  render({ kind: 'level', value: 1 });
  const loud = scales();
  expect(loud[2]).toBeGreaterThan(quiet[2] + 0.5);
  expect(loud[2]).toBeGreaterThan(loud[0]);
  expect(new Set(quiet).size).toBe(1);
});
