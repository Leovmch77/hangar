// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Aparencia from '../../../app/config/aparencia';
import { useTabletPrefs } from '../../stores/tabletPrefs';
import * as m from '../../paraglide/messages';
import { getLocale, overwriteGetLocale } from '../../paraglide/runtime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { memory } = vi.hoisted(() => ({ memory: new Map<string, string | boolean>() }));
vi.mock('../../stores/prefs', () => ({ prefs: {
  getString: (key: string) => typeof memory.get(key) === 'string' ? memory.get(key) : undefined,
  getBoolean: (key: string) => typeof memory.get(key) === 'boolean' ? memory.get(key) : undefined,
  getNumber: () => undefined,
  set: (key: string, value: string | boolean) => memory.set(key, value),
} }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 44 }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('@react-native-menu/menu', () => ({ MenuView: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: vi.fn() } }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('./Pagina', () => ({ Pagina: ({ children }: { children: ReactNode }) => createElement('main', null, children) }));
vi.mock('./Slider', () => ({ Slider: () => null }));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Pressable: ({ children, onPress, accessibilityRole, accessibilityLabel, accessibilityState }: {
    children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
  }) => createElement('button', { onClick: onPress, role: accessibilityRole, 'aria-label': accessibilityLabel,
    'aria-selected': accessibilityState?.selected }, children),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  memory.clear();
  useTabletPrefs.setState({ placement: 'bottom', collapsed: false });
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

it.each(['pt', 'en'] as const)('Aparência oferece três posições em Tablet deitado e grava a escolha (%s)', async locale => {
  const resolveLocale = getLocale;
  overwriteGetLocale(() => locale);
  try {
    await act(async () => root.render(createElement(Aparencia)));
    expect(container.textContent).toContain(m.tablet_landscape());
    const group = container.querySelector(`[role="radiogroup"][aria-label="${m.tablet_bar_position()}"]`)!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(buttons.map(b => b.textContent)).toEqual([m.tablet_bar_left(), m.tablet_bar_bottom(), m.tablet_bar_top()]);
    expect(buttons.map(b => b.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    for (const [index, placement] of [[0, 'left'], [2, 'top'], [1, 'bottom']] as const) {
      await act(async () => buttons[index].click());
      expect(useTabletPrefs.getState().placement).toBe(placement);
      expect(memory.get('tablet.sessionsBar')).toBe(placement);
      expect(buttons[index].getAttribute('aria-selected')).toBe('true');
    }
    expect(useTabletPrefs.getState().collapsed).toBe(false);
  } finally {
    overwriteGetLocale(resolveLocale);
  }
});
