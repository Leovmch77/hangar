// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const frame = vi.hoisted(() => ({
  cb: null as null | ((f: { timeSinceFirstFrame: number }) => void),
  autostart: null as null | boolean,
  active: [] as boolean[],
  shared: [] as { value: number }[],
}));
vi.mock('react-native-reanimated', async () => {
  const { useState } = await import('react');
  return {
    default: { createAnimatedComponent: () => () => null },
    Easing: { bezierFn: () => (x: number) => x },
    useAnimatedProps: () => ({}),
    useReducedMotion: () => false,
    // Estável entre renders, como o de verdade.
    useSharedValue: (v: number) => useState(() => {
      const s = { value: v };
      frame.shared.push(s);
      return s;
    })[0],
    useFrameCallback: (cb: typeof frame.cb, autostart: boolean) => {
      frame.cb = cb;
      frame.autostart = autostart;
      return { setActive: (on: boolean) => frame.active.push(on) };
    },
  };
});
vi.mock('react-native-svg', () => ({ default: () => null, Path: () => null }));

import { WorkingMark, WorkingMarkPaused } from './WorkingMark';

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  frame.active.length = 0;
  frame.shared.length = 0;
});
function render(paused: boolean) {
  const el = createElement(WorkingMarkPaused.Provider, { value: paused }, createElement(WorkingMark, { color: '#fff' }));
  if (!root) root = createRoot(document.createElement('div'));
  act(() => root!.render(el));
}

it('fora da vista o quadro não roda', () => {
  render(true);
  expect(frame.autostart).toBe(false);
  expect(frame.active.at(-1)).toBe(false);
});

it('anda a no máximo 20 quadros por segundo e volta de onde parou', () => {
  render(false);
  const t = frame.shared[0];
  expect(frame.active.at(-1)).toBe(true);
  frame.cb!({ timeSinceFirstFrame: 16 });
  expect(t.value).toBe(0);
  frame.cb!({ timeSinceFirstFrame: 50 });
  expect(t.value).toBeCloseTo(0.05);
  frame.cb!({ timeSinceFirstFrame: 83 });
  expect(t.value).toBeCloseTo(0.05);
  frame.cb!({ timeSinceFirstFrame: 1000 });
  render(true);
  expect(frame.active.at(-1)).toBe(false);
  render(false);
  // O relógio do quadro recomeça do zero ao religar; a marca não volta para o começo.
  frame.cb!({ timeSinceFirstFrame: 0 });
  expect(t.value).toBeCloseTo(1);
  frame.cb!({ timeSinceFirstFrame: 100 });
  expect(t.value).toBeCloseTo(1.1);
});
