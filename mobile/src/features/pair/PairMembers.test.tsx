// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Pressable vira botão: membro sem conversa para abrir não pode chegar ao leitor como botão desligado.
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Pressable: (props: { accessibilityLabel?: string; onPress?: () => void; disabled?: boolean; children?: ReactNode }) =>
    createElement('button', { 'aria-label': props.accessibilityLabel, onClick: props.onPress, disabled: props.disabled }, props.children),
}));

import { PairMembers } from './PairMembers';
import type { MemberView } from './groupPairs';

const noop = () => {};

describe('PairMembers', () => {
  it('membro de máquina desconectada é texto com rótulo, não botão desligado', async () => {
    const members: MemberView[] = [
      { key: 'casa::eu', name: 'eu', machine: null, state: 'idle', target: null, missing: false, self: true },
      { key: 'casa:a', name: 'a', machine: null, state: 'idle', target: { server: 'casa', name: 'a' }, missing: false },
      { key: 'lab::x', name: 'x', machine: 'lab', state: null, target: null, missing: true },
    ];
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(PairMembers, { members, machines: [], picked: [], pickedNames: [], adding: false, busy: false,
      onOpenMember: noop, onToggleAdding: noop, onToggle: noop, onAdd: noop, onLeave: noop })));
    try {
      const buttons = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
      expect(buttons.some((l) => l.startsWith('x'))).toBe(false);
      expect(container.querySelector('[aria-label^="x, "]')).not.toBeNull();
      expect(buttons.some((l) => l.includes('a'))).toBe(true);
      // a própria sessão entra na lista e na contagem, marcada e sem botão
      expect(container.textContent).toContain('(3)');
      expect(buttons.some((l) => l.includes('eu'))).toBe(false);
      expect(container.querySelector('[aria-label^="eu, "]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
