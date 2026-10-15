// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ acceptPair: vi.fn() }));
vi.mock('react-native', async (original) => ({ ...await original<typeof import('react-native')>(),
  TextInput: (p: { accessibilityLabel?: string; value?: string; onChangeText?: (t: string) => void }) =>
    createElement('input', { 'aria-label': p.accessibilityLabel, value: p.value ?? '', onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value) }) }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ toast: { ok: vi.fn(), erro: vi.fn() } }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../paraglide/messages', () => Object.fromEntries([
  'native_par_titulo', 'native_par_aceitar_ajuda', 'native_par_campo_aria', 'native_par_placeholder', 'native_par_qual_sessao',
  'native_par_sem_sessao', 'native_par_aceitar', 'native_par_aceitando', 'native_par_aceito', 'erro_par_link_invalido',
  'pair_level_title', 'pair_level_full', 'pair_level_full_hint', 'pair_level_view', 'pair_level_view_hint', 'pair_opens_sessions',
  'pair_level_received_full', 'pair_level_received_view', 'pair_not_transitive', 'sessao_fechar',
  'native_par_titulo_sessao', 'native_par_convidar', 'share_reach_checking', 'share_reach_retry', 'acesso_copiar', 'toast_copiado',
  'pair_share_link', 'native_par_whatsapp',
].map((k) => [k, (p?: Record<string, unknown>) => (p ? `${k}:${Object.values(p).join(',')}` : k)])));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...api }));
import { PairAcceptSheet } from './PairAcceptSheet';

const server = { id: 's1', label: 'casa', baseUrl: 'http://x', token: 't' };
const sessao = (name: string, extra = {}) => ({ name, state: 'idle', serverId: 's1', serverLabel: 'casa', serverColor: '#000', ...extra });
const LINK = 'https://a.ts.net:8443/par/ABC';

async function montar(name: string | null, sessions = [sessao('api', { pair_peers: ['docs'] }), sessao('web')]) {
  const el = document.createElement('div');
  await act(async () => { createRoot(el).render(createElement(PairAcceptSheet, { target: { server, name, sessions: sessions as never }, onClose: () => {} })); });
  return el;
}
const clicar = async (el: HTMLElement, label: string) =>
  act(async () => { (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click(); });
async function digitar(el: HTMLElement, valor: string) {
  const input = el.querySelector('[aria-label="native_par_campo_aria"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, valor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PairAcceptSheet', () => {
  beforeEach(() => api.acceptPair.mockReset());

  it('link torto não deixa parear', async () => {
    const el = await montar('api');
    await digitar(el, 'https://exemplo.com/par/ABC');
    expect(el.textContent).toContain('erro_par_link_invalido');
    expect((el.querySelector('[aria-label="native_par_aceitar"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('escolhe a sessão e o nível, e mostra o que recebeu', async () => {
    api.acceptPair.mockResolvedValue({ alias: 'pc-ana', owner: 'Ana', session: 'web', level: 'view' });
    const el = await montar(null);
    await digitar(el, LINK);
    await clicar(el, 'api');
    await clicar(el, 'pair_level_full');
    expect(el.textContent).toContain('pair_opens_sessions:api, docs');
    await clicar(el, 'native_par_aceitar');
    expect(api.acceptPair).toHaveBeenCalledWith('api', LINK, 'full', server);
    expect(el.textContent).toContain('native_par_aceito:Ana,web');
    expect(el.textContent).toContain('pair_level_received_view:Ana');
    expect(el.textContent).toContain('pair_not_transitive');
  });

  it('resposta atrasada de uma abertura anterior não mexe no formulário novo', async () => {
    let resolver!: (v: unknown) => void;
    api.acceptPair.mockReturnValue(new Promise((r) => { resolver = r; }));
    const el = document.createElement('div');
    const root = createRoot(el);
    const render = (name: string) => act(async () => {
      root.render(createElement(PairAcceptSheet, { target: { server, name, sessions: [sessao('api'), sessao('web')] as never }, onClose: () => {} }));
    });
    await render('api');
    await digitar(el, LINK);
    await clicar(el, 'native_par_aceitar');
    await render('web');
    await act(async () => { resolver({ alias: 'pc-ana', owner: 'Ana', session: 'web', level: 'view' }); });
    expect(el.textContent).not.toContain('native_par_aceito');
  });

  it('sem sessão viva diz que não há o que parear', async () => {
    const el = await montar(null, [sessao('morta', { state: 'dead' })]);
    expect(el.textContent).toContain('native_par_sem_sessao');
  });
});
