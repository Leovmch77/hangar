// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, ShareCreated, ShareInfo } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ createShare: vi.fn(), listShares: vi.fn(), revokeShare: vi.fn(), revokeAllShares: vi.fn() }));
const platform = vi.hoisted(() => ({ copy: vi.fn(), share: vi.fn(), open: vi.fn() }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...api }));
vi.mock('expo-clipboard', () => ({ setStringAsync: platform.copy }));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(), Share: { share: platform.share }, Linking: { openURL: platform.open },
}));
import { SharePrerequisiteError, ShareReachError, tailscaleEnableUrl } from '@hangar/core';
import { overwriteGetLocale } from '../../paraglide/runtime';
import * as m from '../../paraglide/messages';
import { SharePanel } from './SharePanel';

const server: Server = { id: 's1', label: 'casa', baseUrl: 'http://casa:8765', token: 'owner-token' };
const otherServer: Server = { id: 's2', label: 'trabalho', baseUrl: 'http://trabalho:8765', token: 'other-token' };
const created: ShareCreated = { id: 'new', link: 'https://casa.ts.net:8443/convite/ABC123', expires_at: 1_800_000_000 };
const pending: ShareInfo = { id: 'new', device: null, created_at: 1_790_000_000, redeemed_at: null, expires_at: 1_800_000_000, pending: true };
const guest: ShareInfo = { id: 'old', device: 'iPhone da Ana', created_at: 1_780_000_000, redeemed_at: 1_790_000_000, expires_at: 1_810_000_000, pending: false };
const roots = new Set<Root>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mount() {
  const el = document.createElement('div');
  const root = createRoot(el);
  roots.add(root);
  const render = async (target = server, name = 'api') => {
    await act(async () => root.render(createElement(SharePanel, { server: target, name })));
  };
  await render();
  return { el, render, unmount: async () => { await act(async () => root.unmount()); roots.delete(root); } };
}

function button(el: HTMLElement, label: string) {
  const found = Array.from(el.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === label || node.textContent === label);
  expect(found, `botão ${label}`).toBeDefined();
  return found!;
}
const click = async (el: HTMLElement, label: string) => act(async () => button(el, label).click());

beforeEach(() => {
  vi.resetAllMocks();
  overwriteGetLocale(() => 'pt');
  api.listShares.mockResolvedValue({ shares: [] });
  api.createShare.mockResolvedValue(created);
  api.revokeShare.mockResolvedValue({ ok: true });
  api.revokeAllShares.mockResolvedValue({ ok: true, revoked: 2 });
  platform.copy.mockResolvedValue(undefined);
  platform.share.mockResolvedValue({ action: 'sharedAction' });
  platform.open.mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
});

describe('SharePanel do dono', () => {
  it('avisa sobre acesso completo antes de gerar e mostra carregamento, sem seletor de nível', async () => {
    const request = deferred<{ shares: ShareInfo[] }>();
    api.listShares.mockReturnValueOnce(request.promise);
    const { el } = await mount();
    expect(el.textContent).toContain('acesso completo à sessão');
    expect(el.textContent).toContain('pessoa em quem você confia');
    expect(el.textContent).toContain(m.compartilhar_gerar());
    expect(el.textContent).toContain(m.compartilhar_carregando());
    expect(el.querySelector('[role="radiogroup"]')).toBeNull();
    expect(api.createShare).not.toHaveBeenCalled();
  });

  it('lista pendentes e aparelhos com entrada e validade e atualiza sem polling', async () => {
    api.listShares.mockResolvedValueOnce({ shares: [pending, guest, { ...guest, id: 'unnamed', device: '' }] });
    const { el } = await mount();
    expect(api.listShares).toHaveBeenCalledWith('api', server);
    expect(el.textContent).toContain(m.compartilhar_link_aguardando());
    expect(el.textContent).toContain('iPhone da Ana');
    expect(el.textContent).toContain(m.compartilhar_aparelho_sem_nome());
    expect(el.textContent).toContain('Entrou');
    expect(el.textContent?.match(/Vence/g)).toHaveLength(1);
    api.listShares.mockResolvedValueOnce({ shares: [] });
    await click(el, m.mobile_share_refresh());
    expect(el.textContent).toContain(m.compartilhar_vazio());
    expect(el.textContent).not.toContain('iPhone da Ana');
    expect(api.listShares).toHaveBeenCalledTimes(2);
  });

  it('acesso já resgatado mostra a entrada, sem prazo de vencimento do código', async () => {
    api.listShares.mockResolvedValueOnce({ shares: [guest] });
    const { el } = await mount();
    expect(el.textContent).toContain('iPhone da Ana');
    expect(el.textContent).toContain('Entrou');
    expect(el.textContent).not.toContain('Vence');
  });

  it('mostra erro da lista sem confundir com vazio e permite atualizar', async () => {
    api.listShares.mockRejectedValueOnce(new Error('sem conexão com casa'));
    const { el } = await mount();
    expect(el.textContent).toContain('sem conexão com casa');
    expect(el.textContent).not.toContain(m.compartilhar_vazio());
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    await click(el, m.mobile_share_refresh());
    expect(el.textContent).toContain(m.compartilhar_vazio());
  });

  it('gera uma vez por toque repetido, aguarda Funnel e depois copia e compartilha o link', async () => {
    const request = deferred<ShareCreated>();
    api.createShare.mockReturnValueOnce(request.promise);
    const { el } = await mount();
    const generate = button(el, m.compartilhar_gerar());
    await act(async () => { generate.click(); generate.click(); });
    expect(api.createShare).toHaveBeenCalledTimes(1);
    expect(api.createShare).toHaveBeenCalledWith('api', false, server, expect.any(AbortSignal));
    expect(el.textContent).toContain(m.share_reach_checking());
    expect(el.textContent).not.toContain(created.link);
    api.listShares.mockResolvedValueOnce({ shares: [pending] });
    await act(async () => request.resolve(created));
    expect(el.textContent).toContain(created.link);
    expect(el.textContent).toContain(m.compartilhar_link_aguardando());
    expect(api.listShares).toHaveBeenCalledTimes(2);
    await click(el, m.compartilhar_copiar());
    expect(platform.copy).toHaveBeenCalledWith(created.link);
    expect(el.textContent).toContain(m.compartilhar_copiado());
    await click(el, m.mobile_share_send_link());
    expect(platform.share).toHaveBeenCalledWith({ message: m.compartilhar_whatsapp_texto({ link: created.link }) });
  });

  it('fixa máquina e nome da abertura mesmo quando recebe outras props', async () => {
    const { el, render } = await mount();
    await render(otherServer, 'outro');
    await click(el, m.compartilhar_gerar());
    expect(api.createShare).toHaveBeenCalledWith('api', false, server, expect.any(AbortSignal));
    await click(el, m.mobile_share_refresh());
    expect(api.listShares).toHaveBeenLastCalledWith('api', server);
  });

  it('aborta criação ao desmontar e não publica resposta velha na nova abertura', async () => {
    const request = deferred<ShareCreated>();
    api.createShare.mockReturnValueOnce(request.promise);
    const first = await mount();
    await click(first.el, m.compartilhar_gerar());
    const signal = api.createShare.mock.calls[0][3] as AbortSignal;
    await first.unmount();
    expect(signal.aborted).toBe(true);
    const second = await mount();
    await act(async () => request.resolve(created));
    expect(second.el.textContent).not.toContain(created.link);
    expect(api.listShares).toHaveBeenCalledTimes(2);
  });

  it.each(['dns', 'funnel'] as const)('mostra message, etapa %s e detalhe sem apresentar URL falha', async (stage) => {
    api.createShare.mockRejectedValueOnce(new ShareReachError(stage, 'não abriu publicamente', 'Convite revogado no servidor'));
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    expect(el.textContent).toContain('Convite revogado no servidor');
    expect(el.textContent).toContain(m.mobile_share_stage({ stage }));
    expect(el.textContent).toContain('não abriu publicamente');
    expect(el.textContent).not.toContain(created.link);
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    await click(el, m.compartilhar_gerar());
    expect(el.textContent).toContain(created.link);
  });

  it('mostra pré-requisitos e instruções, abre só enableUrl validada pelo core', async () => {
    const url = tailscaleEnableUrl('https://login.tailscale.com/f/funnel?node=abc');
    const fix = 'sudo tailscale set --operator=$USER';
    api.createShare.mockRejectedValueOnce(new SharePrerequisiteError(['operator', 'funnel'], fix, 'Configure o compartilhamento', url));
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    expect(el.textContent).toContain('Configure o compartilhamento');
    expect(el.textContent).toContain(m.compartilhar_falta_operador());
    expect(el.textContent).toContain(m.compartilhar_falta_funnel());
    expect(el.textContent).toContain(fix);
    await click(el, m.mobile_share_copy_fix());
    expect(platform.copy).toHaveBeenCalledWith(fix);
    platform.open.mockRejectedValueOnce(new Error('navegador indisponível'));
    await click(el, m.compartilhar_liberar_tailscale());
    expect(platform.open).toHaveBeenCalledWith(url);
    expect(el.textContent).toContain('navegador indisponível');
    expect(el.textContent).not.toContain(created.link);
  });

  it('pré-requisito sem URL validada não oferece abrir o fix como endereço', async () => {
    api.createShare.mockRejectedValueOnce(new SharePrerequisiteError(['unknown'], 'javascript:alert(1)', 'Ajuste necessário', tailscaleEnableUrl('https://evil.test/')));
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    expect(el.textContent).toContain('unknown');
    expect(el.textContent).not.toContain(m.compartilhar_liberar_tailscale());
    expect(platform.open).not.toHaveBeenCalled();
  });

  it.each(['copy', 'share'] as const)('falha nativa ao %s permanece visível e conserva o link', async (kind) => {
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    platform[kind].mockRejectedValueOnce(new Error(`falha-${kind}`));
    await click(el, kind === 'copy' ? m.compartilhar_copiar() : m.mobile_share_send_link());
    expect(el.textContent).toContain(`falha-${kind}`);
    expect(el.textContent).toContain(created.link);
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('revogar outro acesso conserva o link novo; revogar o correspondente apaga e relê', async () => {
    api.listShares.mockResolvedValue({ shares: [guest, pending] });
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    api.listShares.mockResolvedValueOnce({ shares: [pending] });
    await click(el, m.mobile_share_revoke_access({ device: guest.device! }));
    expect(api.revokeShare).toHaveBeenCalledWith('api', 'old', server);
    expect(el.textContent).toContain(created.link);
    expect(el.textContent).not.toContain(guest.device);
    api.listShares.mockResolvedValueOnce({ shares: [] });
    await click(el, m.mobile_share_revoke_access({ device: m.compartilhar_link_aguardando() }));
    expect(api.revokeShare).toHaveBeenLastCalledWith('api', 'new', server);
    expect(el.textContent).not.toContain(created.link);
    expect(el.textContent).toContain(m.mobile_share_revoked());
    expect(el.textContent).toContain(m.compartilhar_vazio());
  });

  it('encerrar todos tem trava síncrona, apaga link e atualiza acessos', async () => {
    api.listShares.mockResolvedValue({ shares: [pending] });
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    const request = deferred<{ ok: boolean; revoked: number }>();
    api.revokeAllShares.mockReturnValueOnce(request.promise);
    const revoke = button(el, m.compartilhar_encerrar_todos());
    await act(async () => { revoke.click(); revoke.click(); });
    expect(api.revokeAllShares).toHaveBeenCalledTimes(1);
    api.listShares.mockResolvedValueOnce({ shares: [] });
    await act(async () => request.resolve({ ok: true, revoked: 1 }));
    expect(api.revokeAllShares).toHaveBeenCalledWith('api', server);
    expect(el.textContent).not.toContain(created.link);
    expect(el.textContent).toContain(m.mobile_share_revoked_all());
    expect(el.textContent).toContain(m.compartilhar_vazio());
  });

  it('falha na revogação não apaga o link nem finge que o acesso acabou', async () => {
    api.listShares.mockResolvedValue({ shares: [pending] });
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    api.revokeShare.mockRejectedValueOnce(new Error('revogação recusada'));
    await click(el, m.mobile_share_revoke_access({ device: m.compartilhar_link_aguardando() }));
    expect(el.textContent).toContain('revogação recusada');
    expect(el.textContent).toContain(created.link);
    expect(el.textContent).not.toContain(m.mobile_share_revoked());
  });

  it('lista antiga não sobrescreve a releitura depois da criação', async () => {
    const old = deferred<{ shares: ShareInfo[] }>();
    api.listShares.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ shares: [pending] });
    const { el } = await mount();
    await click(el, m.compartilhar_gerar());
    await act(async () => old.resolve({ shares: [guest] }));
    expect(el.textContent).toContain(m.compartilhar_link_aguardando());
    expect(el.textContent).not.toContain(guest.device);
  });
});
