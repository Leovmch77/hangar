// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getConfigForServer: calls.config,
}));
vi.mock('./dictationOrganization', () => ({ useDictationOrganization: () => 'harness' }));
vi.mock('../pills/PillMenu', () => ({ PillMenu: ({ open, children, loading, error, onRetry, items }: {
  open: boolean; children?: ReactNode; loading?: boolean; error?: string | null; onRetry?: () => void;
  items: { label: string; selected?: boolean }[];
}) => !open ? null : createElement('section', null, children,
  loading ? createElement('progress') : error ? createElement('div', { role: 'alert' }, error,
    onRetry ? createElement('button', { onClick: onRetry }, m.lista_tentar_novamente()) : null)
    : items.map((item) => createElement('span', { key: item.label, 'data-selected': item.selected }, item.label))) }));

import { DictationStyleMenu, useDictationStyleLabel } from './EstiloPill';
import { dictationStyleStore } from './ditadoEstiloStore';

const server: Server = { id: 'style', label: 'style-fixture', baseUrl: 'https://style.test', token: 'fixture' };
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
function Probe({ open }: { open: boolean }) {
  const label = useDictationStyleLabel(server);
  return createElement('main', null, createElement('output', null, label),
    createElement(DictationStyleMenu, { open, onClose: () => {}, server }));
}
beforeEach(() => {
  dictationStyleStore(server).getState()._zerarParaTeste();
  calls.config.mockReset().mockRejectedValue(new Error('502'));
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });

it('abrir o menu conserva o rótulo lido enquanto revalida', async () => {
  calls.config.mockResolvedValueOnce({ campos: { ditado_estilo: { valor: 'limpar', definido: true, origem: 'app' } } });
  await act(async () => root.render(createElement(Probe, { open: false })));
  expect(container.querySelector('output')!.textContent).toBe(m.ditado_estilo_limpar());
  let finish!: (value: unknown) => void;
  calls.config.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(createElement(Probe, { open: true })));
  expect(container.querySelector('output')!.textContent).toBe(m.ditado_estilo_limpar());
  expect(container.querySelector('progress')).toBeNull();
  await act(async () => finish({ campos: { ditado_estilo: { valor: 'briefing', definido: true, origem: 'app' } } }));
  expect(container.querySelector('output')!.textContent).toBe(m.ditado_estilo_briefing());
});

it('falha não apresenta escolha salva e permite reler o estilo no servidor certo', async () => {
  await act(async () => root.render(createElement(Probe, { open: false })));
  expect(container.querySelector('output')!.textContent).toBe(m.dictation_style_unavailable());
  expect(dictationStyleStore(server).getState().pronto).toBe(false);
  await act(async () => root.render(createElement(Probe, { open: true })));
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(m.dictation_style_load_failed());
  expect(container.querySelector('[data-selected="true"]')).toBeNull();
  const retry = container.querySelector('button')!;
  expect(retry.textContent).toBe(m.lista_tentar_novamente());

  let finish!: (value: unknown) => void;
  calls.config.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => retry.click());
  expect(container.querySelector('progress')).not.toBeNull();
  expect(container.querySelector('output')!.textContent).toBe(m.comum_carregando());
  await act(async () => finish({ campos: { ditado_estilo: { valor: 'briefing', definido: true, origem: 'app' } } }));
  expect(calls.config).toHaveBeenLastCalledWith(server);
  expect(container.querySelector('output')!.textContent).toBe(m.ditado_estilo_briefing());
  expect(container.querySelector('[data-selected="true"]')!.textContent).toBe(m.ditado_estilo_briefing());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
