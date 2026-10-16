// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as m from '../../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({ limits: vi.fn(), change: vi.fn(), reload: vi.fn(), servers: [{ id: 'other' }, { id: 'route' }] }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getLimits: calls.limits,
  resetsIn: () => '1h',
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ server: 'route', name: 'sess' }) }));
vi.mock('../../stores/servers', () => ({ useServers: (select: (state: unknown) => unknown) =>
  select({ servers: calls.servers }) }));
vi.mock('./dictationOrganization', () => ({ useDictationOrganization: () => 'external' }));
vi.mock('./ditadoEstiloStore', () => ({ dictationStyleStore: () => (select: (state: unknown) => unknown) =>
  select({ valor: 'prosa', revalidar: calls.reload, trocar: calls.change }) }));
vi.mock('../pills/PillMenu', () => ({ PillMenu: ({ items, onSelect, error }: {
  items: { label: string }[]; onSelect: (item: { label: string }) => void; error: string | null;
}) => createElement('div', null, items.map((item) => createElement('button', {
  key: item.label, onClick: () => onSelect(item),
}, item.label)), error ? createElement('output', null, error) : null) }));
vi.mock('../../paraglide/messages', async (original) => ({
  ...await original<object>(),
  rate_reseta: ({ quando }: { quando: string }) => `reset:${quando}`,
}));

import Limits from '../../../app/s/[server]/[name]/codex-limits';
import { DictationStyleMenu } from './EstiloPill';

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
  calls.change.mockReset().mockRejectedValue('native-code');
  calls.limits.mockReset().mockResolvedValue({ primary: { usedPercent: 25, windowMins: 300, resetsAt: 1 }, secondary: null, planType: null });
});
afterEach(() => { act(() => root.unmount()); });

it('redefinição de cota usa tradução e consulta o servidor da rota', async () => {
  await act(async () => root.render(createElement(Limits)));
  expect(calls.limits).toHaveBeenCalledExactlyOnceWith('sess', { id: 'route' });
  expect(container.textContent).toContain(m.codex_limite_uso({ pct: '25%', reset: ' · reset:1h' }));
  expect(container.textContent).not.toContain('reseta');
});

it('rejeição sem Error no estilo mostra tradução, não literal falha', async () => {
  const close = vi.fn();
  await act(async () => root.render(createElement(DictationStyleMenu, { open: true, onClose: close })));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('output')!.textContent).toBe(m.erro_desconhecido());
  expect(close).not.toHaveBeenCalled();
});
