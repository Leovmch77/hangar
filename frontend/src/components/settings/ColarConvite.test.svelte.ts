// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import * as m from '../../paraglide/messages';

const addInviteServer = vi.hoisted(() => vi.fn(() => 'srv-novo'));
const redeem = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth', () => ({ addInviteServer }));
vi.mock('../../lib/sessionsStore.svelte', () => ({ sessionsStore: { refreshServers: vi.fn() } }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  redeemInvite: redeem,
}));

const ColarConvite = (await import('./ColarConvite.svelte')).default;
const { InviteRedeemError } = await import('@hangar/core');

async function settle() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await tick(); } }
function montar() {
  const onFechar = vi.fn();
  const el = document.createElement('div');
  document.body.appendChild(el);
  const comp = mount(ColarConvite, { target: el, props: { onFechar } });
  return { onFechar, comp };
}
const campo = () => document.querySelector<HTMLInputElement>(`input[aria-label="${m.convite_campo_aria()}"]`)!;
const botaoEntrar = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === m.convite_entrar())!;
async function digitar(v: string) { campo().value = v; campo().dispatchEvent(new Event('input')); await tick(); }

beforeEach(() => { document.body.innerHTML = ''; addInviteServer.mockClear(); redeem.mockReset(); });

describe('ColarConvite', () => {
  it('link válido: resgata, salva o servidor de convite e fecha', async () => {
    redeem.mockResolvedValue({ token: 'tg', session: 's1', owner: 'J', address: 'https://d:8443' });
    const { onFechar, comp } = montar();
    await digitar('https://d:8443/convite/K7P2');
    botaoEntrar().click();
    await settle();
    expect(redeem).toHaveBeenCalledWith('https://d:8443/convite/K7P2', expect.any(String));
    expect(addInviteServer).toHaveBeenCalledWith(expect.objectContaining({ token: 'tg' }));
    expect(onFechar).toHaveBeenCalled();
    unmount(comp);
  });

  it('texto que não é convite: avisa sem ir à rede', async () => {
    const { comp } = montar();
    await digitar('https://exemplo.com/qualquer');
    botaoEntrar().click();
    await settle();
    expect(redeem).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(m.convite_link_invalido());
    unmount(comp);
  });

  it('convite já usado: mostra o motivo e não salva nada', async () => {
    redeem.mockRejectedValue(new InviteRedeemError('used'));
    const { onFechar, comp } = montar();
    await digitar('https://d:8443/convite/K7P2');
    botaoEntrar().click();
    await settle();
    expect(document.body.textContent).toContain(m.erro_convite_usado());
    expect(addInviteServer).not.toHaveBeenCalled();
    expect(onFechar).not.toHaveBeenCalled();
    unmount(comp);
  });

  it('máquina do dono indisponível (503): pede para tentar de novo e mantém o diálogo aberto', async () => {
    redeem.mockRejectedValue(new InviteRedeemError('unavailable'));
    const { onFechar, comp } = montar();
    await digitar('https://d:8443/convite/K7P2');
    botaoEntrar().click();
    await settle();
    expect(document.body.textContent).toContain(m.erro_sessao_indisponivel());
    expect(addInviteServer).not.toHaveBeenCalled();
    expect(onFechar).not.toHaveBeenCalled();
    expect(botaoEntrar().disabled).toBe(false);
    unmount(comp);
  });
});
