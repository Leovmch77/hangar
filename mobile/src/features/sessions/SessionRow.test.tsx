// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AggSession } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const longPress = vi.hoisted(() => ({ enabled: vi.fn() }));

vi.mock('react-native-gesture-handler', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['minDuration', 'runOnJS', 'onStart']) chain[k] = () => chain;
  chain.enabled = (on: boolean) => {
    longPress.enabled(on);
    return chain;
  };
  return { Gesture: { LongPress: () => chain }, GestureDetector: ({ children }: { children: ReactNode }) => children };
});
vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: ({ children, renderRightActions }: { children: ReactNode; renderRightActions?: () => ReactNode }) =>
    createElement('div', null, renderRightActions?.(), children),
}));
// O mock comum passa `style` direto ao DOM, e o da linha é função de `pressed`.
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Pressable: (props: { accessibilityLabel?: string; onPress?: () => void; children?: ReactNode }) =>
    createElement('button', { 'aria-label': props.accessibilityLabel, onClick: props.onPress }, props.children),
}));
vi.mock('expo-haptics', () => ({ impactAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Medium: 'medium' } }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../plan/PlanBar', () => ({ PlanBar: () => null }));
vi.mock('./SessionMenu', () => ({ SessionMenu: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../paraglide/messages', () => ({
  ask_perguntas: () => 'ask_perguntas',
  orq_row_badge: () => 'orq_row_badge',
  sessao_excluir_curto: () => 'sessao_excluir_curto',
  sessao_renomear: () => 'sessao_renomear',
  sessao_retomar: () => 'sessao_retomar',
  sessao_sem_id: () => 'sessao_sem_id',
}));

import { SessionRow } from './SessionRow';

const base = { serverId: 's1', serverLabel: 'casa', serverColor: '#8b5cf6', tracked: true, state: 'idle' as const, last_activity: 1_700_000_000 };

async function render(session: AggSession) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const noop = () => {};
  await act(async () =>
    root.render(createElement(SessionRow, { session, mostrarServidor: false, onPress: noop, onGit: noop, onExcluir: noop, onRenomear: noop, onResume: noop })),
  );
  return { container, root };
}

describe('SessionRow', () => {
  it('orquestrador: selo próprio, sem excluir no arrasto e sem menu de toque longo', async () => {
    longPress.enabled.mockClear();
    const { container, root } = await render({ ...base, name: 'g1-orq', provider: 'orq', pair_gid: 'g1', orq_arbiter: 'arb' });
    expect(container.textContent).toContain('orq_row_badge');
    expect(container.querySelector('[aria-label="sessao_excluir_curto"]')).toBeNull();
    expect(longPress.enabled).toHaveBeenLastCalledWith(false);
    act(() => root.unmount());
  });

  it('sessão comum continua com excluir e toque longo', async () => {
    longPress.enabled.mockClear();
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude' });
    expect(container.textContent).not.toContain('orq_row_badge');
    expect(container.querySelector('[aria-label="sessao_excluir_curto"]')).not.toBeNull();
    expect(longPress.enabled).toHaveBeenLastCalledWith(true);
    act(() => root.unmount());
  });
});
