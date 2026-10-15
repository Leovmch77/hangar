// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueuePanel } from './QueuePanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Cada chave devolve o próprio nome, como nos outros testes de componente do app.
vi.mock('../paraglide/messages', () => Object.fromEntries(
  ('queue_panel_title queue_panel_collapse queue_panel_expand queue_panel_actions queue_panel_move_up queue_panel_move_down '
    + 'queue_panel_remove queue_panel_steer_unavailable codex_orientar codex_orientar_ajuda atalhos_editar comum_apagar comum_cancelar')
    .split(' ').map((k) => [k, () => k]),
));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Glass', () => ({ Glass: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
// O mock de react-native diz Android: sem isto o menu nativo de verdade seria carregado.
vi.mock('@react-native-menu/menu', () => ({ MenuView: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));

const panel = { actions: true, entries: [{ id: 'a', text: 'primeira', ts: 1 }, { id: 'b', text: 'segunda', ts: 2 }] };

function render(props: Record<string, unknown>) {
  const handlers = { onEdit: vi.fn(), onCancelEdit: vi.fn(), onSteer: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(QueuePanel, { panel, editingId: null, busy: false, steerable: true, ...handlers, ...props } as never)));
  return { container, root, handlers };
}
const buttons = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${label}"]`)];

describe('QueuePanel (app)', () => {
  it('lista as mensagens e recolhe pelo cabeçalho', () => {
    const { container, root } = render({});
    expect(container.textContent).toContain('queue_panel_title');
    expect(container.textContent).toContain('primeira');
    act(() => buttons(container, 'queue_panel_collapse')[0].click());
    expect(container.textContent).not.toContain('primeira');
    expect(buttons(container, 'queue_panel_expand')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('menu da linha tem Subir, Descer, Orientar, Editar e Apagar nessa ordem', () => {
    expect(QueuePanel.menuActions({ index: 0, count: 2, busy: false, steerable: true }).map((a) => a.id))
      .toEqual(['up', 'down', 'steer', 'edit', 'remove']);
    const first = QueuePanel.menuActions({ index: 0, count: 2, busy: false, steerable: true });
    expect(first.find((a) => a.id === 'up')?.disabled).toBe(true);
    expect(first.find((a) => a.id === 'down')?.disabled).toBe(false);
    expect(QueuePanel.menuActions({ index: 1, count: 2, busy: false, steerable: true }).find((a) => a.id === 'down')?.disabled).toBe(true);
    expect(QueuePanel.menuActions({ index: 1, count: 2, busy: true, steerable: true }).every((a) => a.disabled)).toBe(true);
    expect(QueuePanel.menuActions({ index: 0, count: 2, busy: false, steerable: false }).find((a) => a.id === 'steer')?.disabled).toBe(true);
    // A linha em edição só se move: o resto descartaria o que está no composer.
    const editing = QueuePanel.menuActions({ index: 0, count: 2, busy: false, steerable: true, editing: true });
    expect(editing.filter((a) => !a.disabled).map((a) => a.id)).toEqual(['down']);
  });

  it('Orientar e X agem na linha certa; ocupado, ficam desativados', () => {
    const { container, root, handlers } = render({});
    act(() => buttons(container, 'codex_orientar')[1].click());
    expect(handlers.onSteer).toHaveBeenCalledWith('b');
    act(() => buttons(container, 'queue_panel_remove')[0].click());
    expect(handlers.onRemove).toHaveBeenCalledWith('a');
    act(() => root.render(createElement(QueuePanel, { panel, editingId: null, busy: true, steerable: true, ...handlers })));
    expect([...buttons(container, 'codex_orientar'), ...buttons(container, 'queue_panel_remove')].every((b) => b.disabled)).toBe(true);
    act(() => root.unmount());
  });

  it('linha em edição troca Orientar e X por Cancelar', () => {
    const { container, root, handlers } = render({ editingId: 'a' });
    expect(buttons(container, 'codex_orientar')).toHaveLength(1);
    expect(buttons(container, 'queue_panel_remove')).toHaveLength(1);
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'comum_cancelar')!;
    act(() => cancel.click());
    expect(handlers.onCancelEdit).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('sem ações (Pi, omp, Kimi): só as linhas; sem entradas, nada', () => {
    const { container, root } = render({ panel: { ...panel, actions: false } });
    expect(container.textContent).toContain('segunda');
    expect(buttons(container, 'codex_orientar')).toHaveLength(0);
    expect(buttons(container, 'queue_panel_remove')).toHaveLength(0);
    act(() => root.render(createElement(QueuePanel, { panel: { entries: [], actions: true }, editingId: null, busy: false, steerable: true,
      onEdit: vi.fn(), onCancelEdit: vi.fn(), onSteer: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() })));
    expect(container.textContent).toBe('');
    act(() => root.unmount());
  });
});
