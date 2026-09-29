import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseInviteLink, inviteAllows, redeemInvite, InviteRedeemError, SharePrerequisiteError,
} from './share';
import { configureApi, type ApiEnv } from './apiEnv';
import { getConfig, getAtualizacao, checkInviteForServer, createShare, sharePrereqs } from './api';
import type { Server } from './servers';

const CONVITE: Server = { id: 'srv-i', label: 'Convite · J', baseUrl: 'https://dono.ts.net:8443', token: 'tg', invite: true };

function ambiente(over: Partial<ApiEnv> = {}) {
  configureApi({
    getBaseUrl: () => 'https://dono.ts.net:8443',
    getToken: () => 'tg',
    onUnauthorized: () => {},
    origin: null,
    createEventSource: () => { throw new Error('sem SSE no teste'); },
    ...over,
  });
}
function resposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}
afterEach(() => vi.restoreAllMocks());

describe('parseInviteLink', () => {
  it('aceita o link https do Funnel, com barra final e espaços', () => {
    expect(parseInviteLink('  https://dono.ts.net:8443/convite/K7P29QX4/ \n'))
      .toEqual({ address: 'https://dono.ts.net:8443', code: 'K7P29QX4' });
  });
  it('aceita o link hangar:// e devolve o endereço https', () => {
    expect(parseInviteLink('hangar://convite/dono.ts.net:8443/K7P29QX4'))
      .toEqual({ address: 'https://dono.ts.net:8443', code: 'K7P29QX4' });
  });
  it('recusa http, outro caminho, código vazio e texto solto', () => {
    expect(parseInviteLink('http://dono.ts.net:8443/convite/K7P2')).toBeNull();
    expect(parseInviteLink('https://dono.ts.net:8443/api/sessions')).toBeNull();
    expect(parseInviteLink('https://dono.ts.net:8443/convite/')).toBeNull();
    expect(parseInviteLink('K7P29QX4')).toBeNull();
  });
  it('recusa credencial embutida no endereço', () => {
    expect(parseInviteLink('https://a@b/convite/X')).toBeNull();
    expect(parseInviteLink('https://a:p@b:8443/convite/X')).toBeNull();
    expect(parseInviteLink('hangar://convite/a@b/X')).toBeNull();
  });
});

describe('inviteAllows', () => {
  it('deixa passar rotas de sessão, o resgate e as globais do chat', () => {
    expect(inviteAllows('/api/sessions')).toBe(true);
    expect(inviteAllows('/api/sessions/events?x=1')).toBe(true);
    expect(inviteAllows('/api/sessions/s1/history?limit=20')).toBe(true);
    expect(inviteAllows('/api/guest/redeem')).toBe(true);
    expect(inviteAllows('/api/model-options?x=1')).toBe(true);
    expect(inviteAllows('/api/tts/audio/abc123')).toBe(true);
  });
  it('barra rotas do servidor inteiro, inclusive /api/config', () => {
    expect(inviteAllows('/api/config')).toBe(false);
    expect(inviteAllows('/api/atualizacao')).toBe(false);
    expect(inviteAllows('/api/cotas')).toBe(false);
    expect(inviteAllows('/api/claude-configs')).toBe(false);
  });
});

describe('redeemInvite', () => {
  it('posta código e aparelho no endereço do link e devolve o token', async () => {
    const f = vi.fn(async () => resposta(200, { token: 'tg', session: 's1', owner: 'Jefferson', address: 'https://dono.ts.net:8443' }));
    const r = await redeemInvite('https://dono.ts.net:8443/convite/K7P2', 'Navegador · Linux', f as unknown as typeof fetch);
    expect(r.token).toBe('tg');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://dono.ts.net:8443/api/guest/redeem');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'K7P2', device: 'Navegador · Linux' });
  });
  it('410 vira o motivo certo (envelope com params ou detail cru)', async () => {
    const usado = vi.fn(async () => resposta(410, { detail: { code: 'erro_convite_usado', params: { reason: 'used' }, msg: 'x' } }));
    await expect(redeemInvite('https://d:8443/convite/A', 'x', usado as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'used' });
    const vencido = vi.fn(async () => resposta(410, { detail: { reason: 'expired' } }));
    await expect(redeemInvite('https://d:8443/convite/A', 'x', vencido as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'expired' });
  });
  it('404, link inválido e falha de rede têm motivo próprio', async () => {
    const nao = vi.fn(async () => resposta(404, { detail: 'not found' }));
    await expect(redeemInvite('https://d:8443/convite/A', 'x', nao as unknown as typeof fetch)).rejects.toMatchObject({ reason: 'unknown' });
    await expect(redeemInvite('lixo', 'x', nao as unknown as typeof fetch)).rejects.toBeInstanceOf(InviteRedeemError);
    const rede = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(redeemInvite('https://d:8443/convite/A', 'x', rede as unknown as typeof fetch)).rejects.toMatchObject({ reason: 'network' });
  });
  it('503 (túnel do dono fora do ar, código não gasto) é indisponível, não usado nem vencido', async () => {
    const f = vi.fn(async () => resposta(503, { detail: { code: 'erro_sessao_indisponivel', params: {}, msg: 'x' } }));
    await expect(redeemInvite('https://d:8443/convite/A', 'x', f as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'unavailable' });
  });
});

describe('trava do servidor de convite em apiFetchRes', () => {
  it('servidor ativo de convite: rota global barrada sem ir à rede', async () => {
    ambiente({ isInvite: () => true });
    const f = vi.spyOn(globalThis, 'fetch');
    await expect(getAtualizacao()).rejects.toMatchObject({ status: 403, code: 'erro_fora_do_convite' });
    expect(f).not.toHaveBeenCalled();
  });
  it('servidor ativo de convite: /api/config é barrado sem ir à rede (o Chat cai no padrão)', async () => {
    ambiente({ isInvite: () => true });
    const f = vi.spyOn(globalThis, 'fetch');
    await expect(getConfig()).rejects.toMatchObject({ status: 403, code: 'erro_fora_do_convite' });
    expect(f).not.toHaveBeenCalled();
  });
  it('410 de um servidor de convite avisa quem ouve, com o id dele', async () => {
    const onInviteEnded = vi.fn();
    ambiente({ onInviteEnded });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(410, { detail: { code: 'erro_convite_encerrado', params: {}, msg: 'x' } }));
    expect(await checkInviteForServer(CONVITE)).toBe(true);
    expect(onInviteEnded).toHaveBeenCalledWith('srv-i');
  });
  it('401 de um servidor de convite também encerra (registro apagado pelo dono)', async () => {
    const onInviteEnded = vi.fn();
    ambiente({ onInviteEnded });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(401, { detail: 'x' }));
    expect(await checkInviteForServer(CONVITE)).toBe(true);
    expect(onInviteEnded).toHaveBeenCalledWith('srv-i');
  });
  it('401 de servidor que NÃO é convite não chama onInviteEnded', async () => {
    const onInviteEnded = vi.fn();
    ambiente({ onInviteEnded });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(401, { detail: 'x' }));
    await checkInviteForServer({ ...CONVITE, invite: false });
    expect(onInviteEnded).not.toHaveBeenCalled();
  });
  it('503 de um servidor de convite NÃO encerra: é indisponibilidade passageira', async () => {
    const onInviteEnded = vi.fn();
    ambiente({ onInviteEnded });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(503, { detail: { code: 'erro_sessao_indisponivel', params: {}, msg: 'x' } }));
    expect(await checkInviteForServer(CONVITE)).toBe(false);
    expect(onInviteEnded).not.toHaveBeenCalled();
  });
});

describe('createShare', () => {
  it('409 de pré-requisito vira SharePrerequisiteError com o que falta e o conserto', async () => {
    ambiente();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(409, { detail: {
      code: 'erro_compartilhar_pre_requisito', params: { missing: ['operator'], fix: 'sudo tailscale set --operator=$USER' }, msg: 'x',
    } }));
    const e = await createShare('s1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SharePrerequisiteError);
    expect((e as SharePrerequisiteError).missing).toEqual(['operator']);
    expect((e as SharePrerequisiteError).fix).toBe('sudo tailscale set --operator=$USER');
    expect((e as SharePrerequisiteError).enableUrl).toBeNull();
  });
  it('409 com funnel faltando traz o link de liberar', async () => {
    ambiente();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(409, { detail: {
      code: 'erro_compartilhar_pre_requisito', msg: 'x',
      params: { missing: ['funnel'], fix: 'libere', enable_url: 'https://login.tailscale.com/f/funnel?node=n1' },
    } }));
    const e = await createShare('s1').catch((x: unknown) => x);
    expect((e as SharePrerequisiteError).enableUrl).toBe('https://login.tailscale.com/f/funnel?node=n1');
  });
  it('409 com enable_url fora do Tailscale descarta o link', async () => {
    ambiente();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(409, { detail: {
      code: 'erro_compartilhar_pre_requisito', msg: 'x',
      params: { missing: ['funnel'], fix: 'libere', enable_url: 'javascript:alert(1)' },
    } }));
    const e = await createShare('s1').catch((x: unknown) => x);
    expect((e as SharePrerequisiteError).enableUrl).toBeNull();
  });
});

describe('sharePrereqs', () => {
  it('consulta a rota do dono sem ligar nada', async () => {
    ambiente();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resposta(200, { missing: [], fix: '', enable_url: null }));
    expect(await sharePrereqs()).toEqual({ missing: [], fix: '', enable_url: null });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://dono.ts.net:8443/api/share/prereqs');
    expect(init?.method).toBeUndefined();
  });
  it('só a página do Tailscale passa como enable_url', async () => {
    ambiente();
    const ok = 'https://login.tailscale.com/f/funnel?node=n1';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(resposta(200, { missing: ['funnel'], fix: 'x', enable_url: 'javascript:alert(1)' }))
      .mockResolvedValueOnce(resposta(200, { missing: ['funnel'], fix: 'x', enable_url: 'https://login.tailscale.com.evil.io/f' }))
      .mockResolvedValueOnce(resposta(200, { missing: ['funnel'], fix: 'x', enable_url: ok }));
    expect((await sharePrereqs()).enable_url).toBeNull();
    expect((await sharePrereqs()).enable_url).toBeNull();
    expect((await sharePrereqs()).enable_url).toBe(ok);
  });
});
