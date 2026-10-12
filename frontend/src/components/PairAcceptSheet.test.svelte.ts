// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import * as m from '../paraglide/messages';

const core = vi.hoisted(() => ({ acceptPair: vi.fn() }));
vi.mock('../lib/auth', () => ({
  listServers: () => [{ id: 'srv-a', label: 'A', baseUrl: 'http://a', token: 't' }],
  listAllServers: () => [{ id: 'srv-a', label: 'A', baseUrl: 'http://a', token: 't' }],
}));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...core }));

const PairAcceptSheet = (await import('./PairAcceptSheet.svelte')).default;

const LINK = 'https://ana.ts.net:8443/par/AB12';
const sess = (name: string, over: Record<string, unknown> = {}) =>
  ({ name, serverId: 'srv-a', serverLabel: 'A', serverColor: '#000', state: 'idle', ...over });

async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await tick(); } }
function montar(sessions: unknown[] | null, initial: { serverId: string; name: string } | null = null) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return mount(PairAcceptSheet, { target: el, props: { sessions: sessions as never, initial, onFechar: vi.fn() } });
}
const botao = (t: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t)!;
function colar(texto: string) {
  const campo = document.querySelector<HTMLInputElement>(`input[aria-label="${m.native_par_campo_aria()}"]`)!;
  campo.value = texto;
  campo.dispatchEvent(new Event('input'));
}

beforeEach(() => { document.body.innerHTML = ''; core.acceptPair.mockReset(); });

describe('PairAcceptSheet', () => {
  it('sem lista ainda: carregando; lista vazia: não há sessão para parear', async () => {
    let c = montar(null);
    await settle();
    expect(document.body.textContent).toContain(m.comum_carregando());
    unmount(c);
    document.body.innerHTML = '';
    c = montar([]);
    await settle();
    expect(document.body.textContent).toContain(m.native_par_sem_sessao());
    unmount(c);
  });

  it('link que não é /par/ não chega ao servidor', async () => {
    const c = montar([sess('hangar')], { serverId: 'srv-a', name: 'hangar' });
    await settle();
    colar('https://ana.ts.net:8443/convite/AB12');
    await settle();
    botao(m.native_par_aceitar()).click();
    await settle();
    expect(document.body.textContent).toContain(m.erro_par_link_invalido());
    expect(core.acceptPair).not.toHaveBeenCalled();
    unmount(c);
  });

  it('escolhe sessão e nível; acesso completo lista o grupo; a resposta diz o que eu recebi', async () => {
    core.acceptPair.mockResolvedValue({ alias: 'casa', owner: 'Ana', session: 'api', level: 'view' });
    const c = montar([sess('hangar', { pair_gid: 'g' }), sess('web', { pair_gid: 'g' }), sess('outra')]);
    await settle();
    expect(document.body.textContent).toContain(m.native_par_qual_sessao());
    botao('hangar').click();
    colar(LINK);
    botao(m.pair_level_full()).click();
    await settle();
    expect(document.body.textContent).toContain(m.pair_opens_sessions({ sessoes: 'hangar, web' }));
    botao(m.native_par_aceitar()).click();
    await settle();
    expect(core.acceptPair).toHaveBeenCalledWith('hangar', LINK, 'full', expect.objectContaining({ id: 'srv-a' }));
    expect(document.body.textContent).toContain(m.native_par_aceito({ dono: 'Ana', sessao: 'api' }));
    expect(document.body.textContent).toContain(m.pair_level_received_view({ dono: 'Ana' }));
    unmount(c);
  });

  it('recusa do servidor aparece e o diálogo segue aberto', async () => {
    core.acceptPair.mockRejectedValue(new Error(m.erro_par_repetido()));
    const c = montar([sess('hangar')], { serverId: 'srv-a', name: 'hangar' });
    await settle();
    colar(LINK);
    await settle();
    botao(m.native_par_aceitar()).click();
    await settle();
    expect(core.acceptPair).toHaveBeenCalledWith('hangar', LINK, 'view', expect.anything());
    expect(document.body.textContent).toContain(m.erro_par_repetido());
    unmount(c);
  });
});
