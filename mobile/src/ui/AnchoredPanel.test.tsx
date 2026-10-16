// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { Keyboard, type View } from 'react-native';
import { AnchoredPanel } from './AnchoredPanel';

vi.mock('react-native-keyboard-controller', () => ({ useReanimatedKeyboardAnimation: () => ({ height: { value: 0 } }) }));
vi.mock('./Glass', () => ({ Glass: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('mede o gatilho de novo quando o teclado fecha, e para de ouvir ao fechar o painel', () => {
  const listeners: Record<string, () => void> = {};
  const removed: string[] = [];
  vi.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
    listeners[event] = cb;
    return { remove: () => removed.push(event) };
  }) as unknown as typeof Keyboard.addListener);
  // Teclado aberto: o chip está lá em cima; fechado, desce.
  const positions = [300, 700];
  const measureInWindow = vi.fn((cb: (x: number, y: number, w: number, h: number) => void) => cb(10, positions.shift() ?? 700, 80, 30));
  const anchor = { measureInWindow } as unknown as View;
  const el = document.createElement('div');
  const root = createRoot(el);
  const panel = (open: boolean) => createElement(AnchoredPanel, { open, anchor, onClose: () => {}, label: 'l', closeLabel: 'c', children: 'conteúdo' });

  act(() => root.render(panel(true)));
  expect(measureInWindow).toHaveBeenCalledTimes(1);
  act(() => listeners.keyboardDidHide());
  expect(measureInWindow).toHaveBeenCalledTimes(2);

  act(() => root.render(panel(false)));
  expect(removed).toEqual(expect.arrayContaining(['keyboardDidHide', 'keyboardDidShow']));
  act(() => root.unmount());
});
