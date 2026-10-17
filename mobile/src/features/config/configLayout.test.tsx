// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ConfigLayout from '../../../app/config/_layout';
import * as m from '../../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ back: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => navigation,
  Stack: Object.assign(({ children, screenOptions }: { children: ReactNode; screenOptions: { headerBackButtonDisplayMode: string } }) =>
    createElement('main', { 'data-back-display': screenOptions.headerBackButtonDisplayMode }, children), {
    Screen: ({ name, options }: { name: string; options: { title?: string; headerLeft?: () => ReactNode } }) =>
      createElement('section', { 'data-route': name, 'data-title': options.title }, options.headerLeft?.()),
  }),
}));
vi.mock('expo-blur', async () => ({ BlurView: (await import('react-native')).View, BlurTargetView: (await import('react-native')).View }));
vi.mock('expo-glass-effect', async () => ({ GlassView: (await import('react-native')).View, isLiquidGlassAvailable: () => false }));

it('Voz tem título na barra e mantém o voltar das configurações', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConfigLayout)));
    expect(container.querySelector('[data-route="voice"]')?.getAttribute('data-title')).toBe(m.native_settings_page_voice());
    expect(container.querySelector('[data-route="index"]')?.getAttribute('data-title')).toBe(m.config_modal_titulo());
    expect(container.querySelector('main')?.getAttribute('data-back-display')).toBe('default');
    await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${m.comum_voltar()}"]`)!.click());
    expect(navigation.back).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
