import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteRedeemResult, Server } from '@hangar/core';
import * as m from '../paraglide/messages';

const boundary = vi.hoisted(() => ({ vault: new Map<string, string>(), readFailure: false }));
const vault = boundary.vault;
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => { if (boundary.readFailure) throw new Error('vault_unread'); return vault.get(key) ?? null; }),
  setItemAsync: vi.fn(async (key: string, value: string) => { vault.set(key, value); }),
}));
let useServers: typeof import('./servers').useServers;
const KEY = 'cp_servers_v1';
const result: InviteRedeemResult = { address: 'https://guest.ts.net:8443/', token: 'guest-token', session: 'shared', owner: 'Ana' };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  vi.resetModules();
  vault.clear();
  boundary.readFailure = false;
  ({ useServers } = await import('./servers'));
});

async function load(servers: Server[] = []) {
  vault.set(KEY, JSON.stringify({ servers, activeId: servers[0]?.id ?? null }));
  await useServers.getState().load();
}

describe('addInvite', () => {
  it('salva convite permanente, ativa o ID devolvido e sobrevive à releitura', async () => {
    const other: Server = { id: 'other', label: 'Minha', baseUrl: 'http://10.0.0.1:8765', token: 'owner-token' };
    await load([other]);
    const saved = useServers.getState().addInvite(result);
    expect(saved).toMatchObject({ baseUrl: 'https://guest.ts.net:8443', token: 'guest-token', invite: true, ephemeral: false });
    expect(useServers.getState().activeId).toBe(saved?.id);
    await settle();
    await useServers.getState().load();
    expect(useServers.getState().active()).toEqual(saved);
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([other, saved]);
  });

  it('novo convite reaproveita ID, troca token e limpa encerrado, removido e desativado', async () => {
    const previous: Server = { id: 'saved-invite', label: 'Antigo', baseUrl: 'https://guest.ts.net:8443', token: 'old', invite: true, inviteEnded: true, disabled: true, removed: true };
    await load([previous]);
    const saved = useServers.getState().addInvite(result);
    expect(saved).toMatchObject({ id: 'saved-invite', token: 'guest-token', invite: true, ephemeral: false, inviteEnded: false, disabled: false, removed: false });
    expect(useServers.getState().servers).toEqual([saved]);
    await settle();
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([saved]);
  });

  it('promove entrada efêmera do par sem perder identidade nem desaparecer com o par', async () => {
    await load();
    useServers.getState().applyPairs([{ local_session: 'local', alias: 'guest', owner: 'Ana', session: 'shared', address: 'https://guest.ts.net:8443', token: 'pair-token' }]);
    const pairId = useServers.getState().servers[0].id;
    const saved = useServers.getState().addInvite(result);
    expect(saved).toMatchObject({ id: pairId, ephemeral: false, token: 'guest-token' });
    useServers.getState().applyPairs([]);
    expect(useServers.getState().servers).toEqual([saved]);
    await settle();
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([saved]);
  });

  // O código já foi consumido: a proteção de máquina própria pertence ao formulário, antes do resgate.
  it('guarda convite já resgatado separado da máquina própria no mesmo endereço', async () => {
    const own: Server = { id: 'own', label: 'own', baseUrl: 'https://GUEST.ts.net:8443/', token: 'owner-token' };
    await load([own]);
    const saved = useServers.getState().addInvite(result);
    expect(saved).toMatchObject({ token: 'guest-token', invite: true });
    expect(saved?.id).not.toBe(own.id);
    expect(useServers.getState().servers).toEqual([own, saved]);
    await settle();
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([own, saved]);
  });

  it('salva sem ativar quando quem pediu saiu do formulário', async () => {
    const own: Server = { id: 'own', label: 'Minha', baseUrl: 'http://10.0.0.1:8765', token: 'owner-token' };
    await load([own]);
    const saved = useServers.getState().addInvite(result, false);
    expect(saved).toMatchObject({ invite: true, ephemeral: false, token: 'guest-token' });
    expect(useServers.getState().activeId).toBe('own');
    await settle();
    await useServers.getState().load();
    expect(useServers.getState().servers).toEqual([own, saved]);
    expect(useServers.getState().activeId).toBe('own');
  });

  it('antes da hidratação enfileira o resultado consumido sem perder seu ID nem a máquina do cofre', async () => {
    const own: Server = { id: 'own', label: 'own', baseUrl: 'https://guest.ts.net:8443', token: 'owner-token' };
    vault.set(KEY, JSON.stringify({ servers: [own], activeId: own.id }));
    const saved = useServers.getState().addInvite(result, false);
    expect(saved).toMatchObject({ token: 'guest-token', invite: true });
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([own]);
    await settle();
    expect(useServers.getState().servers).toEqual([own, saved]);
    expect(useServers.getState().activeId).toBe(own.id);
    expect(JSON.parse(vault.get(KEY)!)).toEqual({ servers: [own, saved], activeId: own.id });
  });

  it('cofre ilegível mantém resultado e replay salva o mesmo ID sem trocar a própria ativa', async () => {
    const own: Server = { id: 'own', label: 'own', baseUrl: 'https://guest.ts.net:8443', token: 'owner-token' };
    await load([own]);
    boundary.readFailure = true;
    await useServers.getState().load();
    const saved = useServers.getState().addInvite(result, false);
    expect(saved).toMatchObject({ token: 'guest-token', invite: true });
    expect(useServers.getState().servers).toEqual([own, saved]);
    await settle();
    expect(useServers.getState().aviso).toEqual({ tipo: 'vault_unread' });
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([own]);
    boundary.readFailure = false;
    await useServers.getState().load();
    expect(useServers.getState().servers).toEqual([own, saved]);
    expect(useServers.getState().activeId).toBe(own.id);
    expect(JSON.parse(vault.get(KEY)!)).toEqual({ servers: [own, saved], activeId: own.id });
  });

  it('novo convite atualiza rótulo e token juntos preservando ID e máquina própria', async () => {
    const own: Server = { id: 'own', label: 'own', baseUrl: 'http://10.0.0.1:8765', token: 'owner-token' };
    const previous: Server = { id: 'saved-invite', label: 'old-label', baseUrl: 'https://guest.ts.net:8443', token: 'old-token', invite: true };
    await load([own, previous]);
    const saved = useServers.getState().addInvite({ ...result, owner: 'Bia' });
    expect(saved).toMatchObject({ id: 'saved-invite', token: 'guest-token', label: m.mobile_share_invite_label({ owner: 'Bia' }) });
    expect(useServers.getState().servers).toEqual([own, saved]);
    await settle();
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([own, saved]);
  });
});
