// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import * as m from '../paraglide/messages';

const lista = vi.hoisted(() => ({ servers: [] as { id: string; label: string; baseUrl: string; token: string; invite?: boolean; inviteEnded?: boolean }[] }));
const abertos = vi.hoisted(() => new Map<string, { onerror?: () => void; close: () => void }>());
const checar = vi.hoisted(() => vi.fn(async () => true));
const ident = vi.hoisted(() => vi.fn(async () => ({ identificador: 'x' })));

vi.mock('./auth', () => ({
  listServers: () => lista.servers,
  onServersChanged: () => () => {},
  getActiveId: () => 'lan',
}));
vi.mock('./navPelaLista', () => ({ navPelaLista: vi.fn() }));
vi.mock('./peers', () => ({ getIdentificador: ident }));
vi.mock('./navegadorPanel.svelte', () => ({ podarNavMortos: vi.fn(), ouvirFechamentoNav: () => () => {} }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  checkInviteForServer: checar,
  openSessionsStream: (server: { id: string }) => {
    const obj = { close: vi.fn(), addEventListener: vi.fn() };
    abertos.set(server.id, obj);
    return obj;
  },
}));

const { sessionsStore } = await import('./sessionsStore.svelte');

afterEach(() => { sessionsStore.release(); abertos.clear(); checar.mockClear(); });

it('convite encerrado não abre stream e aparece como encerrado, sem linhas', () => {
  lista.servers = [
    { id: 'lan', label: 'lan', baseUrl: 'http://lan', token: 't' },
    { id: 'dono', label: 'Convite · J', baseUrl: 'https://d:8443', token: 'g', invite: true, inviteEnded: true },
  ];
  sessionsStore.retain();
  expect(abertos.has('dono')).toBe(false);
  expect(sessionsStore.byServer.find((b) => b.server.id === 'dono')?.error).toBe(m.convite_encerrado());
  expect(sessionsStore.rows.filter((r) => r.serverId === 'dono')).toEqual([]);
});

it('queda do stream de um convite pergunta ao dono se acabou', () => {
  vi.useFakeTimers();
  lista.servers = [{ id: 'dono', label: 'Convite · J', baseUrl: 'https://d:8443', token: 'g', invite: true }];
  sessionsStore.retain();
  abertos.get('dono')!.onerror!();
  expect(checar).toHaveBeenCalledWith(expect.objectContaining({ id: 'dono' }));
  vi.useRealTimers();
});
