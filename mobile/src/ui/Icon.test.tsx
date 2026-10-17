// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon, type IconName } from './Icon';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(name: IconName) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(Icon, { name })));
  const symbol = container.querySelector('[data-symbol]')?.getAttribute('data-symbol') ?? null;
  act(() => root.unmount());
  return { symbol, html: container.innerHTML };
}

describe('Icon', () => {
  afterEach(() => { Platform.OS = 'android'; });

  it('iOS usa o SF Symbol equivalente', async () => {
    Platform.OS = 'ios';
    expect((await render('ChevronLeft')).symbol).toBe('chevron.left');
  });

  it('iOS sem símbolo mapeado fica no Lucide', async () => {
    Platform.OS = 'ios';
    expect((await render('Bot')).symbol).toBeNull();
  });

  it('Android sempre no Lucide', async () => {
    expect((await render('ChevronLeft')).symbol).toBeNull();
  });
});
