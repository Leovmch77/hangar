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

import * as m from '../paraglide/messages';
import { removeGuest, saveGuest } from './guests';

describe('saveGuest', () => {
  beforeEach(() => { vi.resetAllMocks(); });

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

  const prevPc = { user: 'ana', password: '12345678', seesOwner: false, ownerSees: true,
    servers: [{ serverId: 'pc', guestId: 'g-pc', token: 'tok-pc', root: '/b' }] };
  const gone = () => Object.assign(new Error('404: nao existe'), { status: 404 });

  it('falha no hub não joga fora o que os servidores já fizeram', async () => {
    core.createGuestForServer.mockResolvedValue({ id: 'g-vps', token: 'tok-vps' });
    hub.putGuestAccount.mockRejectedValue(new Error('hub fora'));
    const { saved, errors } = await saveGuest({
      user: 'ana', password: '12345678', seesOwner: false, ownerSees: true,
      servers: [{ serverId: 'vps', root: '/a' }],
    }, null);
    expect(saved.servers).toEqual([{ serverId: 'vps', guestId: 'g-vps', token: 'tok-vps', root: '/a' }]);
    expect(errors).toEqual([{ label: m.sync_config_titulo(), message: 'hub fora' }]);
  });

  it('atualizar com 404 recria o convidado com id e token novos', async () => {
    core.updateGuestForServer.mockRejectedValue(gone());
    core.createGuestForServer.mockResolvedValue({ id: 'g-novo', token: 'tok-novo' });
    const { saved, errors } = await saveGuest({ ...prevPc, servers: [{ serverId: 'pc', root: '/c' }] }, prevPc);
    expect(errors).toEqual([]);
    expect(saved.servers).toEqual([{ serverId: 'pc', guestId: 'g-novo', token: 'tok-novo', root: '/c' }]);
  });

  it('apagar com 404 não é erro e a entrada sai', async () => {
    core.deleteGuestForServer.mockRejectedValue(gone());
    const { saved, errors } = await saveGuest({ ...prevPc, servers: [] }, prevPc);
    expect(errors).toEqual([]);
    expect(saved.servers).toEqual([]);
  });

  it('servidor fora da lista do dono vira erro e mantém a entrada antiga', async () => {
    const prev = { ...prevPc, servers: [{ serverId: 'sumido', guestId: 'g-x', token: 'tok-x', root: '/x' }] };
    const edit = await saveGuest({ ...prev, servers: [{ serverId: 'sumido', root: '/y' }] }, prev);
    expect(edit.errors).toEqual([{ label: 'sumido', message: expect.any(String) }]);
    expect(edit.saved.servers).toEqual(prev.servers);
    const drop = await saveGuest({ ...prev, servers: [] }, prev);
    expect(drop.errors).toHaveLength(1);
    expect(drop.saved.servers).toEqual(prev.servers);
  });

  it('removeGuest não apaga a conta do hub se a gravação no hub falhou', async () => {
    core.deleteGuestForServer.mockResolvedValue({ ok: true });
    hub.putGuestAccount.mockRejectedValue(new Error('hub fora'));
    await removeGuest(prevPc);
    expect(hub.deleteGuestAccount).not.toHaveBeenCalled();
    hub.putGuestAccount.mockResolvedValue(undefined);
    await removeGuest(prevPc);
    expect(hub.deleteGuestAccount).toHaveBeenCalledWith('ana');
  });
});
