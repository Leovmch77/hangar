// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import * as m from '../paraglide/messages';

const core = vi.hoisted(() => ({
  listShares: vi.fn(), createShare: vi.fn(), revokeShare: vi.fn(), revokeAllShares: vi.fn(),
}));
vi.mock('../lib/auth', () => ({ withServer: (_id: string, fn: () => unknown) => fn() }));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => {}) }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  ...core,
}));

const ShareSessionSheet = (await import('./ShareSessionSheet.svelte')).default;
const { SharePrerequisiteError } = await import('@hangar/core');

async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await tick(); } }
function montar() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return mount(ShareSessionSheet, { target: el, props: { open: true, name: 's1', serverId: 'srv-a', onClose: vi.fn() } });
}
const botao = (t: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t)!;
const agora = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  document.body.innerHTML = '';
  for (const f of Object.values(core)) f.mockReset();
});

describe('ShareSessionSheet', () => {
  it('sem acesso ainda: aviso de confiança e estado vazio', async () => {
    core.listShares.mockResolvedValue({ shares: [] });
    const c = montar();
    await settle();
    expect(document.body.textContent).toContain(m.compartilhar_aviso_confianca());
    expect(document.body.textContent).toContain(m.compartilhar_vazio());
    // Abrir só carrega a lista: o link nasce no botão e aparece uma vez (o backend guarda só o hash).
    expect(core.createShare).not.toHaveBeenCalled();
    unmount(c);
  });

  it('gerar link mostra o link e o WhatsApp leva o link no texto', async () => {
    core.listShares.mockResolvedValue({ shares: [] });
    core.createShare.mockResolvedValue({ id: 'x1', link: 'https://d.ts.net:8443/convite/K7P2', expires_at: agora() + 86400 });
    const c = montar();
    await settle();
    botao(m.compartilhar_gerar()).click();
    await settle();
    expect(core.createShare).toHaveBeenCalledWith('s1');
    const campo = document.querySelector<HTMLInputElement>(`input[aria-label="${m.compartilhar_link_novo()}"]`)!;
    expect(campo.value).toBe('https://d.ts.net:8443/convite/K7P2');
    const wa = document.querySelector<HTMLAnchorElement>('a[href^="https://wa.me/"]')!;
    expect(decodeURIComponent(wa.href)).toContain('https://d.ts.net:8443/convite/K7P2');
    unmount(c);
  });

  it('pré-requisito faltando: mostra o que falta e o comando', async () => {
    core.listShares.mockResolvedValue({ shares: [] });
    core.createShare.mockRejectedValue(new SharePrerequisiteError(['funnel'], 'https://login.tailscale.com/f/funnel', 'x'));
    const c = montar();
    await settle();
    botao(m.compartilhar_gerar()).click();
    await settle();
    expect(document.body.textContent).toContain(m.compartilhar_falta_funnel());
    expect(document.body.textContent).toContain('https://login.tailscale.com/f/funnel');
    unmount(c);
  });

  it('revogar um acesso chama a rota com a sessão e o id, e recarrega', async () => {
    core.listShares.mockResolvedValue({ shares: [
      { id: 'a1', device: 'Browser · Linux', created_at: agora() - 60, redeemed_at: agora() - 30, expires_at: agora() + 86000, pending: false },
    ] });
    core.revokeShare.mockResolvedValue({ ok: true });
    const c = montar();
    await settle();
    expect(document.body.textContent).toContain('Browser · Linux');
    botao(m.compartilhar_revogar()).click();
    await settle();
    expect(core.revokeShare).toHaveBeenCalledWith('s1', 'a1');
    expect(core.listShares).toHaveBeenCalledTimes(2);
    unmount(c);
  });

  it('falha ao carregar: mostra o erro e tenta de novo', async () => {
    core.listShares.mockRejectedValueOnce(new Error('caiu')).mockResolvedValue({ shares: [] });
    const c = montar();
    await settle();
    expect(document.body.textContent).toContain(m.compartilhar_erro_lista({ erro: 'caiu' }));
    botao(m.compartilhar_tentar_de_novo()).click();
    await settle();
    expect(document.body.textContent).toContain(m.compartilhar_vazio());
    unmount(c);
  });
});
