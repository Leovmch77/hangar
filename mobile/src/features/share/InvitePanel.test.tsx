// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteRedeemResult, Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const boundary = vi.hoisted(() => ({ redeem: vi.fn(), device: { deviceName: 'Test phone' as string | null }, vault: new Map<string, string>(), readFailure: false, writeFailure: false }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), redeemInvite: boundary.redeem }));
vi.mock('expo-constants', () => ({ default: boundary.device }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => { if (boundary.readFailure) throw new Error('vault unavailable'); return boundary.vault.get(key) ?? null; },
  setItemAsync: async (key: string, value: string) => { if (boundary.writeFailure) throw new Error('vault_write_failed'); boundary.vault.set(key, value); },
}));
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return { ...actual,
    Pressable: ({ accessibilityState, ...props }: Record<string, unknown>) => createElement(actual.Pressable, props),
    Text: ({ selectable, ...props }: Record<string, unknown>) => createElement(actual.Text, props),
    TextInput: (props: { accessibilityLabel?: string; value?: string; onChangeText?: (value: string) => void; editable?: boolean }) => createElement('input', {
      'aria-label': props.accessibilityLabel, value: props.value ?? '', disabled: props.editable === false,
      onInput: (event: { currentTarget: { value: string } }) => props.onChangeText?.(event.currentTarget.value),
    }),
  };
});
import { useServers } from '../../stores/servers';
import { InvitePanel } from './InvitePanel';

const LINK = 'https://guest.ts.net:8443/convite/ABCD';
const RESULT: InviteRedeemResult = { address: 'https://guest.ts.net:8443', token: 'new-token', session: 'shared', owner: 'Ana' };
const roots: Root[] = [];
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const accepted = vi.fn();

async function mount(initialLink = '') {
  const el = document.createElement('div');
  const root = createRoot(el);
  roots.push(root);
  await act(async () => { root.render(createElement(InvitePanel, { initialLink, onAccepted: accepted })); });
  return { el, root };
}
const button = (el: HTMLElement, label: string = m.mobile_share_invite_accept()) => el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
async function type(el: HTMLElement, value: string) {
  const input = el.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(el: HTMLElement, label?: string) { await act(async () => { button(el, label).click(); }); }
function deferred() {
  let resolve!: (value: InviteRedeemResult) => void;
  const promise = new Promise<InviteRedeemResult>((yes) => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(async () => {
  boundary.redeem.mockReset();
  boundary.device.deviceName = 'Test phone';
  boundary.readFailure = false;
  boundary.writeFailure = false;
  boundary.vault.clear();
  accepted.mockReset();
  await settle();
  useServers.setState({ servers: [], activeId: null, ready: false, vaultReadable: false, aviso: null });
  await useServers.getState().load();
});
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach((root) => root.unmount()); });
  await settle();
});

describe('InvitePanel', () => {
  it.each(['', 'ABCD', 'http://public.example/convite/ABCD'])('campo inválido %j mostra causa sem rede', async (value) => {
    const { el } = await mount(value);
    await click(el);
    expect(el.textContent).toContain(m.mobile_share_invite_invalid());
    expect(boundary.redeem).not.toHaveBeenCalled();
    expect(useServers.getState().servers).toEqual([]);
  });

  it('prefill só resgata ao confirmar, persiste convite e devolve ID salvo para abrir o chat', async () => {
    boundary.redeem.mockResolvedValue(RESULT);
    const { el } = await mount(LINK);
    expect((el.querySelector('input') as HTMLInputElement).value).toBe(LINK);
    expect(boundary.redeem).not.toHaveBeenCalled();
    await click(el);
    const saved = useServers.getState().active();
    expect(saved).toMatchObject({ token: 'new-token', invite: true, ephemeral: false });
    expect(boundary.redeem).toHaveBeenCalledWith(LINK, 'Test phone', undefined, undefined);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(saved, 'shared');
  });

  it('usa Platform.OS quando Constants não tem nome de aparelho', async () => {
    boundary.device.deviceName = null;
    boundary.redeem.mockResolvedValue(RESULT);
    const { el } = await mount();
    await type(el, LINK);
    expect((el.querySelector('input') as HTMLInputElement).value).toBe(LINK);
    await click(el);
    expect(boundary.redeem).toHaveBeenCalledWith(LINK, 'android', undefined, undefined);
  });

  it('não consome convite de máquina própria no mesmo endereço', async () => {
    const own = useServers.getState().add({ baseUrl: 'https://GUEST.ts.net:8443/', token: 'owner-token', label: 'fixture-owner' });
    const { el } = await mount(LINK);
    await click(el);
    expect(el.textContent).toContain(m.mobile_share_invite_own_server());
    expect(boundary.redeem).not.toHaveBeenCalled();
    expect(useServers.getState().servers).toEqual([own]);
  });

  it('espera hidratação antes de permitir resgatar', async () => {
    useServers.setState({ ready: false });
    const { el } = await mount(LINK);
    expect(el.textContent).toContain(m.mobile_share_invite_loading());
    expect(button(el).disabled).toBe(true);
    await click(el);
    expect(boundary.redeem).not.toHaveBeenCalled();
    await act(async () => { useServers.setState({ ready: true }); });
    expect(button(el).disabled).toBe(false);
  });

  it('cofre ilegível bloqueia resgate e oferece reler sem consumir convite', async () => {
    boundary.readFailure = true;
    await useServers.getState().load();
    const { el } = await mount(LINK);
    expect(el.textContent).toContain(m.servers_warning_vault_unread());
    expect(button(el).disabled).toBe(true);
    boundary.readFailure = false;
    await click(el, m.mobile_share_invite_retry());
    expect(useServers.getState().vaultReadable).toBe(true);
    expect(button(el).disabled).toBe(false);
    expect(boundary.redeem).not.toHaveBeenCalled();
  });

  it('dois toques no mesmo evento fazem um resgate só', async () => {
    const pending = deferred();
    boundary.redeem.mockReturnValue(pending.promise);
    const { el } = await mount(LINK);
    await act(async () => { button(el).click(); button(el).click(); });
    expect(boundary.redeem).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(RESULT); });
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('resposta após desmontagem salva acesso sem ativar nem navegar', async () => {
    const pending = deferred();
    boundary.redeem.mockReturnValue(pending.promise);
    const { el, root } = await mount(LINK);
    await click(el);
    await act(async () => { root.unmount(); });
    roots.splice(roots.indexOf(root), 1);
    const own = useServers.getState().add({ baseUrl: 'http://10.0.0.1:8765', token: 'owner-token', label: 'fixture-owner' });
    await act(async () => { pending.resolve(RESULT); });
    const saved = useServers.getState().servers.find((server) => server.invite);
    expect(saved).toMatchObject({ token: 'new-token', invite: true, ephemeral: false });
    expect(useServers.getState().activeId).toBe(own.id);
    expect(accepted).not.toHaveBeenCalled();
    await settle();
    expect(JSON.parse(boundary.vault.get('cp_servers_v1')!).servers).toEqual([own, saved]);
  });

  it('erro mantém causa durante retry; sucesso posterior abre a sessão', async () => {
    boundary.redeem.mockRejectedValueOnce(new Error('túnel indisponível'));
    const { el } = await mount(LINK);
    await click(el);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('túnel indisponível');
    expect(useServers.getState().servers).toEqual([]);
    const pending = deferred();
    boundary.redeem.mockReturnValueOnce(pending.promise);
    await click(el, m.mobile_share_invite_retry());
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('túnel indisponível');
    await act(async () => { pending.resolve(RESULT); });
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('só envia token de convite persistente; efêmero=%s', async (ephemeral) => {
    if (ephemeral) useServers.getState().applyPairs([{ local_session: 'local', alias: 'guest', owner: 'Ana', session: 'shared', address: RESULT.address, token: 'pair-token' }]);
    else useServers.getState().addInvite({ ...RESULT, token: 'saved-guest-token' });
    boundary.redeem.mockResolvedValue(RESULT);
    const { el } = await mount(LINK);
    await click(el);
    expect(boundary.redeem).toHaveBeenCalledWith(LINK, 'Test phone', undefined, ephemeral ? undefined : 'saved-guest-token');
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  // Depois de consumir o código, recusar descartaria o único acesso recebido.
  it.each([false, true])('própria surgindo durante resgate conserva ambos os tokens; desmontado=%s', async (unmounted) => {
    const pending = deferred();
    boundary.redeem.mockReturnValue(pending.promise);
    const { el, root } = await mount(LINK);
    await click(el);
    if (unmounted) {
      await act(async () => { root.unmount(); });
      roots.splice(roots.indexOf(root), 1);
    }
    let own!: Server;
    await act(async () => { own = useServers.getState().add({ baseUrl: RESULT.address, token: 'owner-token', label: 'fixture-owner' }); });
    await act(async () => { pending.resolve(RESULT); });
    const saved = useServers.getState().servers.find((server) => server.invite);
    expect(saved).toMatchObject({ token: 'new-token', invite: true });
    expect(useServers.getState().servers).toEqual([own, saved]);
    expect(useServers.getState().activeId).toBe(unmounted ? own.id : saved?.id);
    if (unmounted) expect(accepted).not.toHaveBeenCalled();
    else {
      expect(accepted).toHaveBeenCalledExactlyOnceWith(saved, 'shared');
      expect(el.querySelector('[role="alert"]')).toBeNull();
    }
    await settle();
    expect(JSON.parse(boundary.vault.get('cp_servers_v1')!).servers).toEqual([own, saved]);
  });

  it('cofre fica ilegível durante resgate: resultado sobrevive à desmontagem e releitura com o mesmo ID', async () => {
    const pending = deferred();
    boundary.redeem.mockReturnValue(pending.promise);
    const { el, root } = await mount(LINK);
    await click(el);
    let own!: Server;
    await act(async () => { own = useServers.getState().add({ baseUrl: RESULT.address, token: 'owner-token', label: 'fixture-owner' }); });
    boundary.readFailure = true;
    await act(async () => { await useServers.getState().load(); root.unmount(); });
    roots.splice(roots.indexOf(root), 1);
    await act(async () => { pending.resolve(RESULT); });
    const saved = useServers.getState().servers.find((server) => server.invite);
    expect(saved).toMatchObject({ token: 'new-token', invite: true });
    expect(useServers.getState().aviso).toEqual({ tipo: 'vault_unread' });
    expect(useServers.getState().activeId).toBe(own.id);
    expect(accepted).not.toHaveBeenCalled();
    await settle();
    boundary.readFailure = false;
    await useServers.getState().load();
    expect(useServers.getState().servers).toEqual([own, saved]);
    expect(JSON.parse(boundary.vault.get('cp_servers_v1')!)).toEqual({ servers: [own, saved], activeId: own.id });
  });

  it('falha ao gravar resposta após desmontagem deixa aviso global e acesso em memória', async () => {
    const pending = deferred();
    boundary.redeem.mockReturnValue(pending.promise);
    const { el, root } = await mount(LINK);
    await click(el);
    let own!: Server;
    await act(async () => { own = useServers.getState().add({ baseUrl: RESULT.address, token: 'owner-token', label: 'fixture-owner' }); });
    await settle();
    await act(async () => { root.unmount(); });
    roots.splice(roots.indexOf(root), 1);
    boundary.writeFailure = true;
    await act(async () => { pending.resolve(RESULT); });
    await settle();
    expect(useServers.getState().aviso).toEqual({ tipo: 'persistencia' });
    expect(useServers.getState().servers).toEqual([own, expect.objectContaining({ token: 'new-token', invite: true })]);
    expect(useServers.getState().activeId).toBe(own.id);
    expect(JSON.parse(boundary.vault.get('cp_servers_v1')!).servers).toEqual([own]);
    expect(accepted).not.toHaveBeenCalled();
  });
});
