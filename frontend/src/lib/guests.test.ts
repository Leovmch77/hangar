import { beforeEach, describe, expect, it, vi } from 'vitest';

const own = [
  { id: 'vps', label: 'VPS', baseUrl: '', token: 'dono-vps' },
  { id: 'pc', label: 'PC', baseUrl: 'http://pc:8765', token: 'dono-pc' },
];
const core = vi.hoisted(() => ({
  createGuestForServer: vi.fn(), updateGuestForServer: vi.fn(), deleteGuestForServer: vi.fn(),
}));
const hub = vi.hoisted(() => ({ putGuestAccount: vi.fn(), getGuestAccounts: vi.fn(), deleteGuestAccount: vi.fn() }));
vi.mock('@hangar/core', async (orig) => ({ ...(await orig<object>()), ...core }));
vi.mock('./sync', () => hub);
vi.mock('./auth', () => ({ listOwnServers: () => own }));

import { saveGuest } from './guests';

describe('saveGuest', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('cria em cada servidor e grava no hub só as chaves do convidado', async () => {
    core.createGuestForServer.mockImplementation(async (s: { id: string }) => ({ id: `g-${s.id}`, token: `tok-${s.id}` }));
    const { saved, errors } = await saveGuest({
      user: 'ana', password: '12345678', seesOwner: false, ownerSees: true,
      servers: [{ serverId: 'vps', root: '/srv/ana' }],
    }, null);
    expect(errors).toEqual([]);
    expect(saved.servers).toEqual([{ serverId: 'vps', guestId: 'g-vps', token: 'tok-vps', root: '/srv/ana' }]);
    const [, , servers] = hub.putGuestAccount.mock.calls[0];
    expect(servers).toEqual([{ id: 'vps', label: 'VPS', baseUrl: '', token: 'tok-vps' }]);
  });

  it('servidor que falhou aparece no erro e o resto é gravado', async () => {
    core.createGuestForServer.mockImplementation(async (s: { id: string }) => {
      if (s.id === 'pc') throw new Error('offline');
      return { id: 'g-vps', token: 'tok-vps' };
    });
    const { saved, errors } = await saveGuest({
      user: 'ana', password: '12345678', seesOwner: false, ownerSees: true,
      servers: [{ serverId: 'vps', root: '/a' }, { serverId: 'pc', root: '/b' }],
    }, null);
    expect(errors).toEqual([{ label: 'PC', message: 'offline' }]);
    expect(saved.servers.map((s) => s.serverId)).toEqual(['vps']);
  });

  it('desmarcar um servidor apaga o convidado nele', async () => {
    const prev = { user: 'ana', password: '12345678', seesOwner: false, ownerSees: true,
      servers: [{ serverId: 'pc', guestId: 'g-pc', token: 'tok-pc', root: '/b' }] };
    const { saved } = await saveGuest({ ...prev, servers: [] }, prev);
    expect(core.deleteGuestForServer).toHaveBeenCalledWith(own[1], 'g-pc');
    expect(saved.servers).toEqual([]);
  });
});
