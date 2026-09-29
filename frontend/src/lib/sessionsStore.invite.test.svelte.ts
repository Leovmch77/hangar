// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import * as m from '../paraglide/messages';
import { configureApi, _limparEsfriamentoParaTestes } from '@hangar/core';

const lista = vi.hoisted(() => ({ servers: [] as { id: string; label: string; baseUrl: string; token: string; invite?: boolean; inviteEnded?: boolean }[] }));
const abertos = vi.hoisted(() => new Map<string, { onerror?: () => void; close: () => void }>());
const checar = vi.hoisted(() => vi.fn());
const ident = vi.hoisted(() => vi.fn(async () => ({ identificador: 'x' })));

vi.mock('./auth', () => ({
  listServers: () => lista.servers,
  onServersChanged: () => () => {},
  getActiveId: () => 'lan',
}));
vi.mock('./navPelaLista', () => ({ navPelaLista: vi.fn() }));
vi.mock('./peers', () => ({ getIdentificador: ident }));
vi.mock('./navegadorPanel.svelte', () => ({ podarNavMortos: vi.fn(), ouvirFechamentoNav: () => () => {} }));
vi.mock('@hangar/core', async (original) => {
  const core = await original<typeof import('@hangar/core')>();
  // A pergunta de verdade (fetch + gancho do core); o spy só deixa contar as chamadas.
  checar.mockImplementation(core.checkInviteForServer);
  return {
    ...core,
    checkInviteForServer: checar,
    openSessionsStream: (server: { id: string }) => {
      const obj = { close: vi.fn(), addEventListener: vi.fn() };
      abertos.set(server.id, obj);
      return obj;
    },
  };
});

const { sessionsStore } = await import('./sessionsStore.svelte');

const onInviteEnded = vi.fn();
function responde(status: number) {
  const fetchSpy = vi.fn(async () => new Response('{}', { status }));
  vi.stubGlobal('fetch', fetchSpy);
  configureApi({ getBaseUrl: () => '', getToken: () => null, onUnauthorized: () => {}, origin: '',
    createEventSource: () => { throw new Error('não usado'); }, onInviteEnded });
  return fetchSpy;
}
const convite = { id: 'dono', label: 'Convite · J', baseUrl: 'https://d:8443', token: 'g', invite: true };

afterEach(() => {
  sessionsStore.release(); abertos.clear(); checar.mockClear(); onInviteEnded.mockClear();
  vi.unstubAllGlobals(); vi.useRealTimers(); _limparEsfriamentoParaTestes();
});

it('convite encerrado não abre stream e aparece como encerrado, sem linhas', () => {
  lista.servers = [
    { id: 'lan', label: 'lan', baseUrl: 'http://lan', token: 't' },
    { ...convite, inviteEnded: true },
  ];
  sessionsStore.retain();
  expect(abertos.has('dono')).toBe(false);
  expect(sessionsStore.byServer.find((b) => b.server.id === 'dono')?.error).toBe(m.convite_encerrado());
  expect(sessionsStore.rows.filter((r) => r.serverId === 'dono')).toEqual([]);
});

it('queda do stream de um convite: o dono responde 410 e o convite é marcado encerrado', async () => {
  vi.useFakeTimers();
  const fetchSpy = responde(410);
  lista.servers = [convite];
  sessionsStore.retain();
  abertos.get('dono')!.onerror!();
  await vi.waitFor(() => expect(onInviteEnded).toHaveBeenCalledWith('dono'));
  expect(fetchSpy).toHaveBeenCalledWith('https://d:8443/api/sessions', expect.anything());
});

it('queda do stream de um convite com 503: não encerra e volta a tentar', async () => {
  vi.useFakeTimers();
  responde(503);
  lista.servers = [convite];
  sessionsStore.retain();
  const primeiro = abertos.get('dono')!;
  primeiro.onerror!();
  await vi.waitFor(() => expect(checar).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(0);
  expect(onInviteEnded).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(abertos.get('dono')).not.toBe(primeiro);
});
