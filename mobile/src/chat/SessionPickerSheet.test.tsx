// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AggSession } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  replace: vi.fn(),
  release: vi.fn(),
  rows: [
    { name: 'shared', state: 'idle', serverId: 'srv1', serverLabel: 'first-server', serverColor: '#000' },
    { name: 'shared', state: 'idle', serverId: 'srv2', serverLabel: 'second-server', serverColor: '#000' },
  ] as AggSession[],
}));
vi.mock('../stores/sessions', () => ({
  useSessions: Object.assign((select: (state: { rows: AggSession[] }) => unknown) => select({ rows: calls.rows }), {
    getState: () => ({ retain: () => calls.release }),
  }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: calls.replace }) }));
vi.mock('../ui/Sheet', () => ({ Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null }));
vi.mock('../ui/StateDot', () => ({ StateDot: () => null }));
vi.mock('../paraglide/messages', () => ({ sessao_trocar_de: () => 'sessao_trocar_de' }));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Pressable: ({ onPress, accessibilityLabel, accessibilityState, children }: {
    onPress: () => void; accessibilityLabel: string; accessibilityState: { selected: boolean }; children: React.ReactNode;
  }) => React.createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'aria-selected': accessibilityState.selected }, children),
}));

import { SessionPickerSheet } from './SessionPickerSheet';

describe('SessionPickerSheet', () => {
  it.each(['srv1', 'srv2'])('marca só a sessão de %s e permite navegar à homônima', async (serverId) => {
    calls.replace.mockClear();
    calls.release.mockClear();
    const onClose = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(SessionPickerSheet, { open: true, atual: 'shared', serverId, onClose }));
      });
      const selected = container.querySelectorAll<HTMLButtonElement>('button[aria-selected="true"]');
      const other = container.querySelector<HTMLButtonElement>('button[aria-selected="false"]')!;
      const current = calls.rows.find((row) => row.serverId === serverId)!;
      const destination = calls.rows.find((row) => row.serverId !== serverId)!;
      expect(selected).toHaveLength(1);
      expect(selected[0].textContent).toContain(current.serverLabel);
      expect(selected[0].querySelector('span')!.style.fontWeight).toBe('700');
      expect(other.querySelector('span')!.style.fontWeight).toBe('500');

      await act(async () => other.click());

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(calls.replace).toHaveBeenCalledWith(`/s/${destination.serverId}/shared`);
    } finally {
      await act(async () => root.unmount());
    }
    expect(calls.release).toHaveBeenCalledTimes(1);
  });
});
