// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import QueuePanel from './QueuePanel.svelte';
import * as m from '../paraglide/messages';

const panel = (actions = true) => ({ actions, entries: [
  { id: 'a', text: 'primeira mensagem longa', ts: 1 }, { id: 'b', text: 'segunda', ts: 2 },
] });

function montar(props: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const calls = { onEdit: vi.fn(), onCancelEdit: vi.fn(), onSteer: vi.fn(), onRemove: vi.fn(), onReorder: vi.fn() };
  const comp = mount(QueuePanel, { target, props: { panel: panel(), editingId: null, busy: false, ...calls, ...props } });
  return { target, comp, ...calls };
}

describe('QueuePanel', () => {
  it('mostra título, contagem e uma linha por mensagem; recolhe pelo cabeçalho', async () => {
    const { target, comp } = montar();
    expect(target.querySelector('.qp-header')?.textContent).toContain(m.queue_panel_title());
    expect(target.querySelector('.qp-count')?.textContent).toBe('2');
    expect(target.querySelectorAll('.qp-row')).toHaveLength(2);
    target.querySelector<HTMLButtonElement>('.qp-header')!.click(); await tick();
    expect(target.querySelector('.qp-list')?.hasAttribute('hidden')).toBe(true);
    expect(target.querySelector('.qp-header')?.getAttribute('aria-expanded')).toBe('false');
    target.querySelector<HTMLButtonElement>('.qp-header')!.click(); await tick();
    expect(target.querySelector('.qp-list')?.hasAttribute('hidden')).toBe(false);
    unmount(comp);
  });
  it('lápis, Orientar e X chamam com o id; seta na alça reordena', async () => {
    const { target, comp, onEdit, onSteer, onRemove, onReorder } = montar();
    const row = target.querySelectorAll('.qp-row')[1];
    row.querySelector<HTMLButtonElement>('.qp-edit')!.click();
    row.querySelector<HTMLButtonElement>('.qp-steer')!.click();
    row.querySelector<HTMLButtonElement>('.qp-remove')!.click();
    row.querySelector<HTMLElement>('.qp-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect([onEdit.mock.calls[0][0], onSteer.mock.calls[0][0], onRemove.mock.calls[0][0]]).toEqual(['b', 'b', 'b']);
    expect(onReorder).toHaveBeenCalledWith('b', 'a');
    // Para baixo na última e para cima na primeira não há para onde ir.
    onReorder.mockClear();
    row.querySelector<HTMLElement>('.qp-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    target.querySelectorAll('.qp-row')[0].querySelector<HTMLElement>('.qp-grip')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(onReorder).not.toHaveBeenCalled();
    target.querySelectorAll('.qp-row')[0].querySelector<HTMLElement>('.qp-grip')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(onReorder).toHaveBeenCalledWith('a', null);
    unmount(comp);
  });
  it('em voo desativa os botões; em edição a linha só tem Cancelar', async () => {
    const busy = montar({ busy: true });
    expect([...busy.target.querySelectorAll<HTMLButtonElement>('.qp-row button')].every((b) => b.disabled)).toBe(true);
    unmount(busy.comp);
    const editing = montar({ editingId: 'a' });
    const row = editing.target.querySelectorAll('.qp-row')[0];
    expect(row.querySelector('.qp-edit')).toBeNull();
    expect(row.getAttribute('aria-current')).toBe('true');
    row.querySelector<HTMLButtonElement>('.qp-cancel')!.click();
    expect(editing.onCancelEdit).toHaveBeenCalledOnce();
    unmount(editing.comp);
  });
  it('tocar no texto mostra a mensagem inteira', async () => {
    const { target, comp } = montar();
    const row = target.querySelectorAll('.qp-row')[0];
    row.querySelector<HTMLElement>('.qp-text')!.click(); await tick();
    expect(row.classList.contains('full')).toBe(true);
    row.querySelector<HTMLElement>('.qp-text')!.click(); await tick();
    expect(row.classList.contains('full')).toBe(false);
    unmount(comp);
  });
  it('sem ações (Pi, omp, Kimi) mostra as linhas sem botões', () => {
    const { target, comp } = montar({ panel: panel(false) });
    expect(target.querySelectorAll('.qp-row')).toHaveLength(2);
    expect(target.querySelector('.qp-row button')).toBeNull();
    unmount(comp);
  });
  it('sem entradas o painel não existe', () => {
    const { target, comp } = montar({ panel: { actions: true, entries: [] } });
    expect(target.querySelector('.qp')).toBeNull();
    unmount(comp);
  });
});
