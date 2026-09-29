// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
vi.mock('../paraglide/messages', () => ({
  orq_talk_to_arbiter: () => 'orq_talk_to_arbiter',
  orq_row_badge: () => 'orq_row_badge',
}));

import { OrqFooter } from './OrqFooter';

async function render(arbiter: string | null) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(OrqFooter, { serverId: 's1', arbiter })));
  return { container, root };
}

describe('OrqFooter', () => {
  it('abre a sessão do árbitro no mesmo servidor', async () => {
    push.mockClear();
    const { container, root } = await render('arb-2');
    const botao = container.querySelector('button[aria-label="orq_talk_to_arbiter"]') as HTMLButtonElement;
    expect(botao.textContent).toBe('orq_talk_to_arbiter');
    await act(async () => botao.click());
    expect(push).toHaveBeenCalledWith('/s/s1/arb-2');
    act(() => root.unmount());
  });

  it('diz o que a linha é, como o web e o nativo', async () => {
    const { container, root } = await render('arb-2');
    expect(container.textContent).toContain('orq_row_badge');
    act(() => root.unmount());
  });

  it('sem árbitro conhecido o botão aparece desligado', async () => {
    push.mockClear();
    const { container, root } = await render(null);
    const botao = container.querySelector('button[aria-label="orq_talk_to_arbiter"]') as HTMLButtonElement;
    expect(botao).not.toBeNull();
    expect(botao.getAttribute('aria-disabled') === 'true' || botao.disabled).toBe(true);
    expect(container.textContent).toContain('orq_row_badge');
    await act(async () => botao.click());
    expect(push).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
