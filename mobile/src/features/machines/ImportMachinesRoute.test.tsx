// @vitest-environment happy-dom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configureApi, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import * as m from '../../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({
  vault: new Map<string, string>(), params: {} as Record<string, unknown>, replace: vi.fn(), fetch: vi.fn(), success: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: async (k: string) => mocks.vault.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mocks.vault.set(k, v); } }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => mocks.params, useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('../../ui/Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('sonner-native', () => ({ toast: Object.assign(vi.fn(), { success: mocks.success }), Toaster: () => null }));
import ImportMachinesRoute from '../../../app/importar';

const saved: Server = { id: 'saved', label: 'fixture-existing', baseUrl: 'https://saved.test', token: 'saved-token', disabled: true };
const next: Server = { id: 'saved', label: 'fixture-new', baseUrl: 'https://new.test', token: 'literal%25/#?+' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let root: Root;
let el: HTMLDivElement;
const render = () => act(async () => root.render(<ImportMachinesRoute />));
const settle = () => act(async () => { await new Promise<void>((r) => setImmediate(r)); });
function button(label: string) {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label);
  expect(found, label).toBeTruthy(); return found!;
}
beforeEach(async () => {
  mocks.vault.clear(); mocks.fetch.mockReset(); mocks.replace.mockReset(); mocks.success.mockReset();
  mocks.vault.set('cp_servers_v1', JSON.stringify({ servers: [saved], activeId: saved.id }));
  await useServers.getState().load();
  mocks.params = { '#': JSON.stringify([next, { ...saved, token: 'do-not-overwrite' }]) };
  configureApi({ getBaseUrl: () => 'https://wrong.test', getToken: () => 'wrong', origin: null,
    onUnauthorized: () => { throw new Error('unexpected_active_reset'); }, createEventSource: vi.fn() });
  mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/api/sessions') ? json([]) : json({ identificador: 'real-new-name', lan_url: '' }));
  vi.stubGlobal('fetch', mocks.fetch);
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); await useServers.getState().load(); vi.unstubAllGlobals(); });

test('mostra novas e já salvas sem fazer rede; importa só após gesto e preserva o token com percentual literal', async () => {
  await render();
  expect(el.textContent).toContain(m.machine_import_new());
  expect(el.textContent).toContain(m.machine_import_saved());
  expect(el.textContent).toContain('fixture-new');
  expect(el.textContent).not.toContain('literal%25');
  expect(mocks.fetch).not.toHaveBeenCalled();
  await act(async () => button(m.machine_import_action()).click()); await settle();
  expect(useServers.getState().servers[0]).toEqual(saved);
  expect(useServers.getState().servers[1]).toMatchObject({ baseUrl: next.baseUrl, label: 'real-new-name', token: 'literal%25/#?+' });
  expect(useServers.getState().servers[1].id).not.toBe(saved.id);
  expect(useServers.getState().activeId).toBe(saved.id);
  for (const [url, init] of mocks.fetch.mock.calls) {
    expect(url).toMatch(/^https:\/\/new\.test\//);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer literal%25/#?+');
  }
  expect(mocks.replace).toHaveBeenCalledWith('/');
  expect(mocks.success).toHaveBeenCalledWith(m.machine_import_success({ count: 1 }));
});

test('espera hidratação e bloqueia importação duplicada durante verificação', async () => {
  useServers.setState({ ready: false }); await render();
  expect(el.textContent).toContain(m.comum_carregando());
  expect(mocks.fetch).not.toHaveBeenCalled();
  await act(async () => { useServers.setState({ ready: true }); });
  let resolve!: (r: Response) => void;
  mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/api/sessions')
    ? new Promise<Response>((r) => { resolve = r; }) : json({ identificador: 'real-new-name', lan_url: '' }));
  await act(async () => { button(m.machine_import_action()).click(); button(m.machine_import_action()).click(); });
  expect(el.textContent).toContain(m.machine_import_verifying());
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(json([])); }); await settle();
  expect(useServers.getState().servers).toHaveLength(2);
});

test('duas recusas 403 mostram a máquina de cada ocorrência sem caminho ou segredo nos alertas', async () => {
  mocks.params = { '#': JSON.stringify([
    { ...next, id: 'one', baseUrl: 'https://one.test/private-path', token: 'one-secret' },
    { ...next, id: 'two', baseUrl: 'https://two.test/private-path', token: 'two-secret' },
  ]) };
  mocks.fetch.mockImplementation(async () => json({ detail: 'leaked:one-secret:two-secret' }, 403));
  await render(); await act(async () => button(m.machine_import_action()).click()); await settle();
  const alerts = [...el.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
  expect(alerts).toHaveLength(2);
  expect(alerts.some((text) => text?.includes('one.test') && text.includes('HTTP 403'))).toBe(true);
  expect(alerts.some((text) => text?.includes('two.test') && text.includes('HTTP 403'))).toBe(true);
  expect(alerts.join(' ')).not.toContain('private-path'); expect(alerts.join(' ')).not.toContain('secret');
  expect(mocks.replace).not.toHaveBeenCalled();
});

test('falha parcial fica visível sem segredo, mantém o que respondeu e oferece conversas', async () => {
  mocks.params = { '#': JSON.stringify([next, { ...next, id: 'bad', baseUrl: 'https://bad.test', token: 'bad-secret' }]) };
  mocks.fetch.mockImplementation(async (url: string) => url.startsWith('https://bad.test')
    ? json({ detail: 'never-show-bad-secret' }, 401) : url.endsWith('/api/sessions') ? json([]) : json({ identificador: 'good-name', lan_url: '' }));
  await render(); await act(async () => button(m.machine_import_action()).click()); await settle();
  expect(el.textContent).toContain(m.machine_import_candidate());
  expect(el.textContent).toContain('HTTP 401');
  expect(el.textContent).toContain(m.machine_import_success({ count: 1 }));
  expect(el.textContent).not.toContain('bad-secret');
  expect(useServers.getState().servers).toHaveLength(2);
  expect(mocks.replace).not.toHaveBeenCalled();
  await act(async () => button(m.machine_import_conversations()).click());
  expect(mocks.replace).toHaveBeenCalledWith('/');
});

test.each([undefined, '{"token":"never-show-secret"', '%5B%5D', ['[]']])('payload inválido não faz rede nem expõe o texto: %j', async (payload) => {
  mocks.params = { '#': payload }; await render();
  expect(el.textContent).toContain(m.machine_import_invalid());
  expect(el.textContent).not.toContain('never-show-secret');
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test('vazio e link quente substituem a prévia, sem reutilizar a lista do link anterior', async () => {
  mocks.params = { '#': '[]' }; await render();
  expect(el.textContent).toContain(m.machine_import_empty());
  expect(mocks.fetch).not.toHaveBeenCalled();
  mocks.params = { '#': JSON.stringify([next]) }; await render();
  expect(el.textContent).toContain('fixture-new');
  expect(button(m.machine_import_action()).disabled).toBe(false);
  mocks.params = { '#': '[]' }; await render();
  expect(el.textContent).not.toContain('fixture-new');
  expect(el.textContent).toContain(m.machine_import_empty());
});
