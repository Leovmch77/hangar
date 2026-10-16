// @vitest-environment happy-dom
import { act, createElement, forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '../../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const boundary = vi.hoisted(() => ({
  params: {} as Record<string, string | string[]>, replace: vi.fn(), redeem: vi.fn(), sessions: vi.fn(),
  scan: null as null | ((event: { data: string }) => void), vault: new Map<string, string>(),
}));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), redeemInvite: boundary.redeem, getSessions: boundary.sessions }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => boundary.params, useRouter: () => ({ replace: boundary.replace }) }));
vi.mock('expo-constants', () => ({ default: { deviceName: 'Test phone' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async (key: string) => boundary.vault.get(key) ?? null, setItemAsync: async (key: string, value: string) => { boundary.vault.set(key, value); } }));
vi.mock('expo-blur', () => ({ BlurView: ({ children }: { children: ReactNode }) => createElement('div', null, children), BlurTargetView: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('expo-glass-effect', async () => ({ GlassView: (await import('react-native')).View, isLiquidGlassAvailable: () => false }));
vi.mock('expo-linear-gradient', async () => ({ LinearGradient: (await import('react-native')).View }));
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '/cache', document: '/document' } }));
vi.mock('react-native-mmkv', () => ({ createMMKV: () => ({ getString: () => undefined, getNumber: () => undefined, getBoolean: () => undefined, set: () => {}, remove: () => {} }) }));
vi.mock('sonner-native', () => ({ toast: Object.assign(() => {}, { success: () => {}, error: () => {}, dismiss: () => {} }), Toaster: () => null }));
vi.mock('expo-camera', () => ({ useCameraPermissions: () => [{ granted: true }, () => {}], CameraView: (props: { onBarcodeScanned: (event: { data: string }) => void }) => { boundary.scan = props.onBarcodeScanned; return null; } }));
vi.mock('@lodev09/react-native-true-sheet', () => ({ TrueSheet: forwardRef(function NativeSheet({ children }: { children: ReactNode }, ref) {
  const [visible, setVisible] = useState(false);
  useImperativeHandle(ref, () => ({ present: async () => { setVisible(true); }, dismiss: async () => { setVisible(false); } }));
  return visible ? createElement('div', null, children) : null;
}) }));
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return { ...actual,
    View: ({ accessibilityElementsHidden, importantForAccessibility, ...props }: Record<string, unknown>) => createElement(actual.View, props),
    Pressable: ({ accessibilityState, ...props }: Record<string, unknown>) => createElement(actual.Pressable, props),
    Text: ({ selectable, ...props }: Record<string, unknown>) => createElement(actual.Text, props),
    TextInput: (props: { accessibilityLabel?: string; value?: string; onChangeText?: (value: string) => void }) => createElement('input', {
      'aria-label': props.accessibilityLabel, value: props.value ?? '', onInput: (event: { currentTarget: { value: string } }) => props.onChangeText?.(event.currentTarget.value),
    }),
  };
});
vi.mock('react-native-unistyles', async (original) => {
  const actual = await original<typeof import('react-native-unistyles')>();
  const { theme, rt } = actual.useUnistyles();
  return { ...actual, StyleSheet: { ...actual.StyleSheet, create: (styles: unknown) => typeof styles === 'function'
    ? styles({ ...theme, base: { ...theme.base, weight: { medium: '500', semibold: '600' } } }, rt) : styles } };
});
import Invite from '../../../app/convite/[code]';
import Login from '../../../app/login';
import { useServers } from '../../stores/servers';

const LINK = 'https://guest.ts.net:8443/convite/CODE';
const RESULT = { token: 'guest-token', session: 'shared', owner: 'Ana', address: 'https://guest.ts.net:8443' };
const roots: Root[] = [];
async function mount(Component: typeof Invite) {
  const el = document.createElement('div');
  const root = createRoot(el);
  roots.push(root);
  await act(async () => { root.render(createElement(Component)); });
  return el;
}
async function click(el: HTMLElement, label: string) {
  await act(async () => { (el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null)?.click(); });
}
const input = (el: HTMLElement, label = m.mobile_share_invite_link_label()) => el.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;

beforeEach(async () => {
  boundary.params = {};
  boundary.scan = null;
  boundary.redeem.mockReset().mockResolvedValue(RESULT);
  boundary.sessions.mockReset().mockResolvedValue([]);
  boundary.replace.mockReset();
  boundary.vault.clear();
  useServers.setState({ servers: [], activeId: null, ready: false, vaultReadable: false, aviso: null });
  await useServers.getState().load();
});
afterEach(async () => { await act(async () => { roots.splice(0).forEach((root) => root.unmount()); }); });

describe('entrada de convite nas rotas', () => {
  it('rota conserva link recebido, confirma e abre o chat no ID persistido', async () => {
    boundary.params = { code: 'CODE', link: LINK };
    const el = await mount(Invite);
    expect(input(el)?.value).toBe(LINK);
    expect(boundary.redeem).not.toHaveBeenCalled();
    await click(el, m.mobile_share_invite_accept());
    expect(boundary.replace).toHaveBeenCalledExactlyOnceWith(`/s/${useServers.getState().activeId}/shared`);
  });

  it.each([{ link: undefined }, { link: [LINK, LINK] }])('código sem link único não adivinha servidor: $link', async ({ link }) => {
    boundary.params = { code: 'CODE', ...(link === undefined ? {} : { link }) };
    const el = await mount(Invite);
    expect(input(el)?.value).toBe('');
    await click(el, m.mobile_share_invite_accept());
    expect(el.textContent).toContain(m.mobile_share_invite_invalid());
    expect(boundary.redeem).not.toHaveBeenCalled();
  });

  it('login oferece colar convite com o mesmo formulário', async () => {
    const el = await mount(Login);
    await click(el, m.mobile_share_invite_open());
    expect(input(el)?.value).toBe('');
    expect(el.textContent).toContain(m.mobile_share_invite_title());
  });

  it('QR de convite passa ao formulário sem resgate automático e abre chat ao confirmar', async () => {
    const el = await mount(Login);
    await click(el, m.login_qr());
    expect(boundary.scan).not.toBeNull();
    await act(async () => { boundary.scan?.({ data: LINK }); });
    expect(input(el)?.value).toBe(LINK);
    expect(boundary.redeem).not.toHaveBeenCalled();
    await click(el, m.mobile_share_invite_accept());
    expect(boundary.replace).toHaveBeenCalledExactlyOnceWith(`/s/${useServers.getState().activeId}/shared`);
    expect(boundary.sessions).not.toHaveBeenCalled();
  });

  it('QR de máquina própria continua no pareamento original', async () => {
    const el = await mount(Login);
    await click(el, m.login_qr());
    await act(async () => { boundary.scan?.({ data: 'http://10.0.0.5:8765/?token=owner-token' }); });
    expect(input(el, m.sessao_url_servidor())?.value).toBe('http://10.0.0.5:8765');
    expect(input(el, m.sessao_token())?.value).toBe('owner-token');
    await click(el, m.login_conectar());
    expect(boundary.sessions).toHaveBeenCalledTimes(1);
    expect(boundary.redeem).not.toHaveBeenCalled();
    expect(useServers.getState().active()?.invite).toBeFalsy();
    expect(boundary.replace).toHaveBeenCalledWith('/');
  });
});
