// @vitest-environment happy-dom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionsBarPlacement } from '../../stores/tabletPrefs';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  placement: 'bottom' as SessionsBarPlacement, panelOpen: true, collapsed: false, toggleCollapsed: vi.fn(),
  size: { width: 1180, height: 820, scale: 1, fontScale: 1 },
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => h.router, useIsFocused: () => true, useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
}));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  useWindowDimensions: () => h.size,
  PanResponder: { create: () => ({ panHandlers: {} }) },
}));
vi.mock('../../stores/tabletPrefs', () => ({ useTabletPrefs: (select: (s: typeof h) => unknown) => select(h) }));
vi.mock('../../stores/servers', () => ({ useServers: (select: (s: unknown) => unknown) => select({ activeId: 'srv' }) }));
vi.mock('../../stores/sessions', () => {
  const state = { rows: [], retain: () => () => {} };
  return { useSessions: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock('../../stores/aparencia', () => ({ useAparencia: { getState: () => ({ homeScreen: 'sessions' }) } }));
vi.mock('../sessions/SessionsDrawer', () => ({ SessionsDrawer: ({ children }: { children: ReactNode }) => children }));
vi.mock('../sessions/ServerSheet', () => ({ ServerSheet: () => null }));
vi.mock('../sessions/SessionList', () => ({ SessionList: () => createElement('section', { 'data-home-sessions': true }) }));
vi.mock('../create/CreateSessionSheet', () => ({ CreateSessionSheet: ({ home }: { home: { mode: string; sessions: ReactNode } }) =>
  createElement('div', { 'data-create-mode': home.mode }, home.sessions, createElement('textarea')) }));
vi.mock('../../ui/Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/HangarMark', () => ({ HangarMark: () => null }));
vi.mock('../voice/LiveVoiceChatButton', () => ({ LiveVoiceChatButton: () => null }));
vi.mock('./SessionsBar', () => ({ SessionsBar: ({ onPick, onNew }: { onPick: (s: unknown) => void; onNew: () => void }) =>
  createElement('nav', null, createElement('button', { onClick: () => onPick({ serverId: 'srv', name: 'b' }) }, 'pick-b'),
    createElement('button', { onClick: onNew }, 'new-session')) }));
vi.mock('./ContextPanel', () => ({ ContextPanel: () => createElement('aside', null, 'session-context') }));
import { TabletShell } from './TabletShell';
import Index from '../../../app/index';
import * as m from '../../paraglide/messages';
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); h.placement = 'bottom'; h.panelOpen = true; h.collapsed = false;
  h.size = { width: 1180, height: 820, scale: 1, fontScale: 1 };
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
function render(selected: { serverId: string; name: string } | undefined = { serverId: 'srv', name: 'a' }) {
  act(() => root.render(createElement(TabletShell, { selected, children: createElement('main', null, 'conversation') })));
}
function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)!;
  expect(button).toBeDefined(); act(() => button.click());
}
it.each(['left', 'bottom', 'top'] as const)('%s ordena as áreas como no mock e mantém o centro transparente', placement => {
  h.placement = placement; render();
  const center = host.querySelector('main')!;
  const bar = host.querySelector('nav')!;
  const panel = host.querySelector('aside')!;
  expect(center).not.toBeNull(); expect(bar).not.toBeNull(); expect(panel).not.toBeNull();
  expect(!!(bar.compareDocumentPosition(center) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(placement !== 'bottom');
  expect(!!(center.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  // A faixa horizontal abrange também o painel, como no mock.
  if (placement === 'top' || placement === 'bottom') expect(bar.parentElement!.contains(panel)).toBe(false);
  expect(center.parentElement!.style.backgroundColor).toBe('');
  expect(center.parentElement!.style.flex).toBe('1 1 0%');
});
it('fechar o painel desmonta o contexto', () => {
  render(); expect(host.querySelector('aside')).not.toBeNull();
  h.panelOpen = false; render(); expect(host.querySelector('aside')).toBeNull();
});

it.each(['top', 'bottom'] as const)('%s recolhida desmonta a faixa e oferece expansão no topo com 44 pt', placement => {
  h.placement = placement; render();
  const center = host.querySelector('main');
  expect(host.querySelector(`[aria-label="${m.tablet_bar_expand()}"]`)).toBeNull();
  h.collapsed = true; render();
  expect(host.querySelector('nav')).toBeNull();
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${m.tablet_bar_expand()}"]`)!;
  expect(button.style.minWidth).toBe('44px');
  expect(button.style.minHeight).toBe('44px');
  click(m.tablet_bar_expand()); expect(h.toggleCollapsed).toHaveBeenCalledOnce();
  h.collapsed = false; render();
  expect(host.querySelector('nav')).not.toBeNull();
  expect(host.querySelector('main')).toBe(center);
});

it('esquerda recolhida conserva a barra sem duplicar o botão de expansão no topo', () => {
  h.placement = 'left'; h.collapsed = true; render();
  expect(host.querySelector('nav')).not.toBeNull();
  expect(host.querySelector(`[aria-label="${m.tablet_bar_expand()}"]`)).toBeNull();
});

it('em pé não monta a barra nem o botão de expansão', () => {
  h.collapsed = true;
  act(() => root.render(createElement(TabletShell, { active: false, children: createElement('main') })));
  expect(host.querySelector('nav')).toBeNull();
  expect(host.querySelector(`[aria-label="${m.tablet_bar_expand()}"]`)).toBeNull();
});
it('nova conversa no Início não monta o painel', () => {
  act(() => root.render(createElement(TabletShell, { children: createElement('main', null, 'new-conversation') })));
  expect(host.querySelector('aside')).toBeNull();
});
it('troca a sessão sem empilhar e abre criação, busca, configuração e Início', () => {
  render(); click('pick-b'); expect(h.router.replace).toHaveBeenCalledWith('/s/srv/b');
  click('new-session'); expect(h.router.push).toHaveBeenCalledWith('/create');
  click(m.lista_buscar()); expect(h.router.push).toHaveBeenCalledWith('/search');
  click(m.config_modal_titulo()); expect(h.router.push).toHaveBeenCalledWith('/config');
  click(m.chat_ir_inicio()); expect(h.router.dismissTo).toHaveBeenCalledWith('/');
});

it('abrir uma sessão pelo Início conserva o Início na pilha para o voltar', () => {
  act(() => root.render(createElement(TabletShell, { children: createElement('main', null, 'new-conversation') })));
  click('pick-b');
  expect(h.router.push).toHaveBeenCalledWith('/s/srv/b');
  expect(h.router.replace).not.toHaveBeenCalled();
});

it.each([true, false])('Custos fica acessível na barra com sessão selecionada: %s', selected => {
  act(() => root.render(createElement(TabletShell, {
    selected: selected ? { serverId: 'srv', name: 'a' } : undefined,
    children: createElement('main', null, 'conversation'),
  })));
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${m.nav_custos()}"]`);
  expect(button).not.toBeNull();
  expect(button!.style.minWidth).toBe('44px');
  expect(button!.style.minHeight).toBe('44px');
  click(m.nav_custos());
  expect(h.router.push).toHaveBeenCalledWith('/costs');
});

it('a rota inicial conserva a criação ao girar e usa a barra no lugar da lista no tablet', async () => {
  h.size = { ...h.size, width: 390, height: 844 };
  await act(async () => root.render(createElement(Index)));
  const field = host.querySelector('textarea');
  expect(host.querySelector('[data-home-sessions]')).not.toBeNull();
  h.size = { ...h.size, width: 1180, height: 820 };
  await act(async () => root.render(createElement(Index)));
  expect(host.querySelector('nav')).not.toBeNull();
  expect(host.querySelector('[data-create-mode]')?.getAttribute('data-create-mode')).toBe('newConversation');
  expect(host.querySelector('[data-home-sessions]')).toBeNull();
  expect(host.querySelector('aside')).toBeNull();
  expect(host.querySelector('textarea')).toBe(field);
});
