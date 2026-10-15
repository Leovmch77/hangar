// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ createPairInvite: vi.fn() }));
const share = vi.hoisted(() => vi.fn());
vi.mock('react-native', async (original) => ({ ...await original<typeof import('react-native')>(), Share: { share } }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ toast: { ok: vi.fn(), erro: vi.fn() } }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../paraglide/messages', () => Object.fromEntries([
  'native_par_titulo_sessao', 'pair_level_title', 'pair_level_full', 'pair_level_full_hint', 'pair_level_view', 'pair_level_view_hint',
  'pair_opens_sessions', 'native_par_convidar', 'share_reach_checking', 'share_reach_retry', 'acesso_copiar', 'toast_copiado',
  'pair_share_link', 'native_par_whatsapp', 'sessao_fechar', 'pair_not_transitive',
].map((k) => [k, (p?: Record<string, unknown>) => (p ? `${k}:${Object.values(p).join(',')}` : k)])));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...api }));
import { PairInviteSheet } from './PairInviteSheet';

const server = { id: 's1', label: 'casa', baseUrl: 'http://x', token: 't' };

async function montar(members: string[] = ['docs']) {
  const el = document.createElement('div');
  await act(async () => { createRoot(el).render(createElement(PairInviteSheet, { target: { server, name: 'api', members }, onClose: () => {} })); });
  return el;
}
const clicar = async (el: HTMLElement, label: string) =>
  act(async () => { (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click(); });

describe('PairInviteSheet', () => {
  beforeEach(() => { api.createPairInvite.mockReset(); share.mockReset(); });

  it('acesso completo diz quais sessões ficam abertas e cria o convite com o nível', async () => {
    api.createPairInvite.mockResolvedValue({ id: 'i', link: 'https://a.ts.net:8443/par/X', expires_at: 1 });
    const el = await montar();
    expect(el.textContent).not.toContain('pair_opens_sessions');
    await clicar(el, 'pair_level_full');
    expect(el.textContent).toContain('pair_opens_sessions:api, docs');
    await clicar(el, 'native_par_convidar');
    expect(api.createPairInvite).toHaveBeenCalledWith('api', 'full', server, expect.anything());
    expect(el.textContent).toContain('https://a.ts.net:8443/par/X');
    await clicar(el, 'pair_share_link');
    expect(share).toHaveBeenCalledWith({ message: 'native_par_whatsapp:https://a.ts.net:8443/par/X' });
  });

  it('falha na conferência do link mostra o motivo e deixa tentar de novo', async () => {
    api.createPairInvite.mockRejectedValueOnce(new Error('funnel não entregou'));
    const el = await montar();
    await clicar(el, 'native_par_convidar');
    expect(api.createPairInvite).toHaveBeenCalledWith('api', 'view', server, expect.anything());
    expect(el.textContent).toContain('funnel não entregou');
    api.createPairInvite.mockResolvedValueOnce({ id: 'i', link: 'https://a.ts.net:8443/par/Y', expires_at: 1 });
    await clicar(el, 'share_reach_retry');
    expect(el.textContent).toContain('https://a.ts.net:8443/par/Y');
  });
});
