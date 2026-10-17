// @vitest-environment happy-dom
import { act, createElement, forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MoreSheet } from './MoreSheet';
import { _resetChatsForTests } from '../stores/chat';
import { useMods } from '../stores/mods';
import { useServers } from '../stores/servers';
import * as m from '../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const boundary = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: boundary.push }) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }));
vi.mock('react-native-mmkv', () => ({ createMMKV: () => ({ getString: () => undefined, set: () => {} }) }));
vi.mock('expo-blur', async () => ({ BlurView: (await import('react-native')).View }));
vi.mock('expo-glass-effect', async () => ({ GlassView: (await import('react-native')).View, isLiquidGlassAvailable: () => false }));
vi.mock('sonner-native', () => ({ toast: Object.assign(() => {}, { success: () => {}, error: () => {}, dismiss: () => {} }), Toaster: () => null }));
vi.mock('@lodev09/react-native-true-sheet', () => ({ TrueSheet: forwardRef(function NativeSheet({ children }: { children: ReactNode }, ref) {
  const [visible, setVisible] = useState(false);
  useImperativeHandle(ref, () => ({ present: async () => { setVisible(true); }, dismiss: async () => { setVisible(false); } }));
  return visible ? createElement('div', null, children) : null;
}) }));
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return { ...actual, Pressable: ({ accessibilityState, ...props }: Record<string, unknown>) => createElement(actual.Pressable, props) };
});

const own = { id: 'own', label: 'owner-server', baseUrl: 'http://owner.test:8765', token: 'owner-token' };
const guest = { id: 'guest', label: 'guest-server', baseUrl: 'https://guest.ts.net:8443', token: 'guest-token', invite: true };
const removed = { ...own, id: 'removed', removed: true };
const roots: Root[] = [];

beforeEach(() => {
  boundary.push.mockReset();
  useServers.setState({ servers: [own, guest, removed], activeId: guest.id, ready: true, vaultReadable: true, aviso: null });
  useMods.setState({ visible: false });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected-network'); }));
});
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  _resetChatsForTests();
  vi.unstubAllGlobals();
});

async function render(serverId: string, orq = false, name = 'conversation') {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  const onClose = vi.fn();
  await act(async () => { root.render(createElement(MoreSheet, { open: true, onClose, serverId, name, orq })); });
  return { container, onClose };
}

const shareButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>(`[aria-label="${m.compartilhar_menu()}"]`);

test.each([
  { kind: 'normal', orq: false, name: 'conversation' },
  { kind: 'orq', orq: true, name: 'orq-run' },
])('Time do trabalho: dono da conversa $kind abre o editor no servidor explícito', async ({ orq, name }) => {
  const { container, onClose } = await render(own.id, orq, name);
  const team = container.querySelector<HTMLButtonElement>(`[aria-label="${m.orqcfg_aba_papeis()}"]`);
  expect(team).not.toBeNull();
  await act(async () => { team!.click(); });
  expect(onClose).toHaveBeenCalledExactlyOnceWith();
  expect(boundary.push).toHaveBeenCalledExactlyOnceWith(`/s/own/${name}/orchestration-team`);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([guest.id, removed.id, 'unknown'])('Time do trabalho: servidor %s não oferece editor em conversa normal nem orq', async serverId => {
  useServers.setState({ activeId: own.id });
  for (const orq of [false, true]) {
    const { container } = await render(serverId, orq);
    expect(container.querySelector(`[aria-label="${m.orqcfg_aba_papeis()}"]`)).toBeNull();
  }
  expect(boundary.push).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('servidor próprio da conversa oferece compartilhar entre grupo e arquivos mesmo com convidado ativo', async () => {
  const { container, onClose } = await render(own.id);
  const share = shareButton(container);
  expect(share).not.toBeNull();
  expect(share!.textContent).toBe(m.compartilhar_menu());
  expect(share!.previousElementSibling?.getAttribute('aria-label')).toBe(m.par_titulo());
  expect(share!.nextElementSibling?.getAttribute('aria-label')).toBe(m.arq_aba());
  expect(container.textContent).not.toContain(m.mobile_share_send_link());
  await act(async () => { share!.click(); });
  expect(onClose).toHaveBeenCalledExactlyOnceWith();
  expect(boundary.push).toHaveBeenCalledExactlyOnceWith('/s/own/conversation/share');
  expect(fetch).not.toHaveBeenCalled();
});

test.each([guest, removed])('servidor $id da conversa não oferece compartilhar com servidor próprio ativo', async server => {
  useServers.setState({ activeId: own.id });
  const { container } = await render(server.id);
  expect(container.querySelector(`[aria-label="${m.par_titulo()}"]`)).not.toBeNull();
  expect(shareButton(container)).toBeNull();
});

test('conversa de orquestração em servidor próprio não oferece compartilhar', async () => {
  const { container } = await render(own.id, true);
  expect(container.querySelector(`[aria-label="${m.arq_aba()}"]`)).not.toBeNull();
  expect(shareButton(container)).toBeNull();
});

test('orquestração abre seu painel no lugar de Atividade e sessão comum mantém Atividade', async () => {
  const { container, onClose } = await render(own.id, true);
  const panel = container.querySelector<HTMLButtonElement>(`[aria-label="${m.orq_tab_title()}"]`);
  expect(panel).not.toBeNull();
  expect(container.querySelector(`[aria-label="${m.ctx_atividade()}"]`)).toBeNull();
  await act(async () => { panel!.click(); });
  expect(onClose).toHaveBeenCalledExactlyOnceWith();
  expect(boundary.push).toHaveBeenCalledExactlyOnceWith('/s/own/conversation/orchestration');

  boundary.push.mockClear();
  const normal = await render(own.id);
  expect(normal.container.querySelector(`[aria-label="${m.orq_tab_title()}"]`)).toBeNull();
  const activity = normal.container.querySelector<HTMLButtonElement>(`[aria-label="${m.ctx_atividade()}"]`);
  expect(activity).not.toBeNull();
  await act(async () => { activity!.click(); });
  expect(normal.onClose).toHaveBeenCalledExactlyOnceWith();
  expect(boundary.push).toHaveBeenCalledExactlyOnceWith('/s/own/conversation/activity');
});

test('servidor inexistente não oferece compartilhar', async () => {
  useServers.setState({ activeId: own.id });
  const { container } = await render('unknown');
  expect(container.querySelector(`[aria-label="${m.par_titulo()}"]`)).not.toBeNull();
  expect(shareButton(container)).toBeNull();
});
