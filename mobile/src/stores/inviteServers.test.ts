import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteRedeemResult, Server } from '@hangar/core';

const vault = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => vault.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { vault.set(key, value); }),
}));
let useServers: typeof import('./servers').useServers;
const KEY = 'cp_servers_v1';
const result: InviteRedeemResult = { address: 'https://guest.ts.net:8443/', token: 'guest-token', session: 'shared', owner: 'Ana' };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  vi.resetModules();
  vault.clear();
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

  it('não substitui nem duplica máquina própria no mesmo endereço normalizado', async () => {
    const own: Server = { id: 'own', label: 'Minha', baseUrl: 'https://GUEST.ts.net:8443/', token: 'owner-token' };
    await load([own]);
    expect(useServers.getState().addInvite(result)).toBeNull();
    expect(useServers.getState().servers).toEqual([own]);
    await settle();
    expect(JSON.parse(vault.get(KEY)!).servers).toEqual([own]);
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

  it('antes da hidratação recusa aceitar e não grava por cima do cofre desconhecido', async () => {
    expect(useServers.getState().addInvite(result)).toBeNull();
    expect(useServers.getState().servers).toEqual([]);
    expect(vault.size).toBe(0);
  });
});
