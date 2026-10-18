// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  frame: null as ((frame: { timestamp: number }) => void) | null,
  values: [] as { value: unknown }[],
}));
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>();
  return { ...rn, View: ({ onLayout, ...props }: React.ComponentProps<typeof rn.View>) => {
    useEffect(() => { onLayout?.({ nativeEvent: { layout: { width: 100 } } } as never); }, []);
    return createElement(rn.View, props);
  } };
});
vi.mock('react-native-reanimated', async (original) => {
  const reanimated = await original<typeof import('react-native-reanimated')>();
  return { ...reanimated,
    useSharedValue: (initial: unknown) => {
      const value = reanimated.useSharedValue(initial);
      if (!h.values.includes(value)) h.values.push(value);
      return value;
    },
    useFrameCallback: (callback: typeof h.frame) => { h.frame = callback; },
  };
});
import { RecordingWave } from './RecordingWave';
import * as m from '../paraglide/messages';

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => { roots.splice(0).forEach((root) => root.unmount()); });
  vi.useRealTimers(); h.values = []; h.frame = null;
});

it('a onda avança com nível constante sem depender de um render React', async () => {
  const root = createRoot(document.createElement('div')); roots.push(root);
  await act(async () => { root.render(createElement(RecordingWave, { rms: { value: 0.5 } as never })); });
  const levels = h.values.find((value) => Array.isArray(value.value))!;
  h.frame!({ timestamp: 55 }); h.frame!({ timestamp: 110 }); h.frame!({ timestamp: 165 });
  expect(levels.value).toEqual([0.5, 0.5, 0.5]);
  for (let timestamp = 220; timestamp <= 2200; timestamp += 55) h.frame!({ timestamp });
  expect(levels.value).toHaveLength(20);
});

it('mostra texto legível, tempo e Cancelar com área de toque de 44 pontos', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  const root = createRoot(container); roots.push(root);
  const onCancel = vi.fn();
  await act(async () => { root.render(createElement(RecordingWave, { rms: { value: 0 } as never, onCancel })); });
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(container.textContent).toContain('0:02');
  const label = [...container.querySelectorAll('span')].find((node) => node.textContent === m.native_dictation_active())!;
  expect(Number.parseFloat(label.style.fontSize)).toBeGreaterThanOrEqual(15);
  const cancel = container.querySelector('button')!;
  expect(Number.parseFloat(cancel.style.minHeight)).toBeGreaterThanOrEqual(44);
  expect(Number.parseFloat(cancel.style.minWidth)).toBeGreaterThanOrEqual(44);
  act(() => cancel.click());
  expect(onCancel).toHaveBeenCalledTimes(1);
});
