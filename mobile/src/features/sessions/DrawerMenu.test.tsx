// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as m from '../../paraglide/messages';
import { rotuloEstado } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav = vi.hoisted(() => ({ push: vi.fn(), order: [] as string[] }));
const state = vi.hoisted(() => ({
  rows: [
    { serverId: 'casa', name: 'antiga', state: 'idle', last_activity: 1 },
    { serverId: 'casa', name: 'mobile-menu', state: 'working', last_activity: 9, headless: true },
    { serverId: 'casa', name: 'pm19016', state: 'awaiting_input', last_activity: 5 },
    { serverId: 'casa', name: 'encerrada', state: 'dead', last_activity: 10 },
  ],
  server: { id: 'casa', label: 'Casa', baseUrl: 'http://x', token: 't' },
  openVoice: vi.fn(),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: (p: string) => { nav.order.push(`push:${p}`); nav.push(p); } }) }));
vi.mock('../../stores/sessions', () => ({ useSessions: (pick: (s: { rows: unknown[] }) => unknown) => pick({ rows: state.rows }) }));
vi.mock('../../stores/servers', () => ({
  useServers: (pick: (s: unknown) => unknown) => pick({ activeId: 'casa', servers: [state.server] }),
}));
vi.mock('../voice/liveVoiceStore', () => ({ useLiveVoice: { getState: () => ({ openFor: state.openVoice }) } }));
vi.mock('../../ui/WorkingMark', () => ({ WorkingMark: () => createElement('span', { 'data-testid': 'working' }) }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  listClaudeConfigsForServer: async () => [{ path: '/b', label: 'Felizardo e Batista', active: true }],
  probeServerResponse: async () => ({ ok: true, json: async () => [{ id: 'claude:/b', estado: 'lida', janelas: [{ rotulo: '5h', pct: 27 }] }] }),
}));

const { DrawerMenu } = await import('./DrawerMenu');

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn(() => { nav.order.push('close'); });
const onOpenServers = vi.fn();
beforeEach(async () => {
  nav.push.mockClear(); nav.order.length = 0; onClose.mockClear(); onOpenServers.mockClear(); state.openVoice.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(DrawerMenu, { open: true, onClose, onOpenServers })));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const byLabel = (label: string) => [...host.querySelectorAll('[role="button"], button')]
  .find((el) => el.getAttribute('aria-label') === label || el.textContent === label) as HTMLElement | undefined;
const startsWith = (label: string) => [...host.querySelectorAll('[role="button"], button')]
  .find((el) => el.getAttribute('aria-label')?.startsWith(label)) as HTMLElement | undefined;

it('Nova sessão fecha a gaveta e abre o formulário completo', () => {
  act(() => byLabel(m.sessao_nova())!.click());
  expect(nav.order).toEqual(['close', 'push:/create']);
});

it('recentes: mais novas primeiro, sem encerradas', () => {
  const names = ['mobile-menu', 'pm19016', 'antiga'].map((n) => startsWith(`${n},`));
  expect(names.every(Boolean)).toBe(true);
  expect(startsWith('encerrada')).toBeUndefined();
  expect(startsWith('pm19016,')!.getAttribute('aria-label')).toBe(`pm19016, ${rotuloEstado('awaiting_input')}`);
  act(() => startsWith('pm19016,')!.click());
  expect(nav.push).toHaveBeenLastCalledWith('/s/casa/pm19016');
});

it('recentes mostram o sinal e anunciam sessão sem terminal', () => {
  const headless = startsWith('mobile-menu,')!;
  const signal = headless.querySelector(`[role="image"][aria-label="${m.criar_modo_exec_headless()}"]`);
  expect(signal).not.toBeNull();
  expect(headless.getAttribute('aria-label')).toContain(m.criar_modo_exec_headless());
  expect(signal?.previousElementSibling?.textContent).toBe('mobile-menu');
  expect(startsWith('pm19016,')!.querySelector('[role="image"]')).toBeNull();
});

it('Início só fecha a gaveta; Servidores abre a folha de servidores', () => {
  act(() => byLabel(m.menu_inicio())!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(nav.push).not.toHaveBeenCalled();
  act(() => byLabel(m.maquinas_titulo())!.click());
  expect(onOpenServers).toHaveBeenCalledTimes(1);
});

it('Contas mostra a cota da conta ativa e Voz abre a chamada do servidor ativo', () => {
  expect(startsWith(m.contas_titulo())!.getAttribute('aria-label')).toBe(`${m.contas_titulo()}, Felizardo e Batista · 5h 27%`);
  act(() => byLabel(m.voz_titulo())!.click());
  expect(state.openVoice).toHaveBeenCalledWith('casa', '');
});
