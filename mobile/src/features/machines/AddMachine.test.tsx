// @vitest-environment happy-dom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), vault: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async (k: string) => mocks.vault.get(k) ?? null, setItemAsync: async (k: string, v: string) => { mocks.vault.set(k, v); } }));
vi.mock('react-native', async (original) => ({ ...await original<typeof import('react-native')>(),
  TextInput: (p: { accessibilityLabel?: string; value?: string; editable?: boolean; onChangeText?: (t: string) => void }) =>
    <input aria-label={p.accessibilityLabel} disabled={p.editable === false} value={p.value ?? ''} onChange={(e) => p.onChangeText?.(e.target.value)} />,
}));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
import { AddMachineSheet } from './AddMachineSheet';
import { useServers } from '../../stores/servers';
import * as m from '../../paraglide/messages';
const owner = { id: 'add-owner', label: 'fixture-owner', baseUrl: 'https://owner.test', token: 'owner-secret' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
let root: Root;
let el: HTMLDivElement;
async function click(label: string) {
  const button = [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function type(label: string, value: string) {
  const input = el.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  expect(input, label).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(async () => {
  mocks.fetch.mockReset(); mocks.vault.clear();
  mocks.vault.set('cp_servers_v1', JSON.stringify({ servers: [owner], activeId: owner.id })); await useServers.getState().load();
  configureApi({ getBaseUrl: () => 'https://wrong.test', getToken: () => 'wrong', origin: null, onUnauthorized: vi.fn(), createEventSource: vi.fn() });
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/descobrir')) return json([{ nome: 'fixture-found', base_url: 'http://10.2.3.4:8765' }]);
    if (url.endsWith('/identificador')) return json({ identificador: 'remote', lan_url: '' });
    return json({ campos: {}, somente_leitura: {} });
  });
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); vi.unstubAllGlobals(); });
const render = (target = owner) => act(async () => root.render(<AddMachineSheet owner={target} onClose={() => {}} onQr={() => {}} />));

describe('adicionar máquina', () => {
  it('só descobre Tailscale pelo botão e mantém o nome digitado ao selecionar uma URL', async () => {
    await render(); expect(mocks.fetch).not.toHaveBeenCalled();
    await type(m.mobile_machines_label(), 'fixture-custom'); await click(m.mobile_machines_discover());
    expect(mocks.fetch.mock.calls[0][0]).toBe(`${owner.baseUrl}/api/peers/descobrir`);
    await click('fixture-found · http://10.2.3.4:8765');
    expect((el.querySelector(`input[aria-label="${m.mobile_machines_label()}"]`) as HTMLInputElement).value).toBe('fixture-custom');
    await type(m.mobile_machines_token(), 'remote-secret'); await click(m.mobile_machines_save());
    expect(useServers.getState().servers.at(-1)?.label).toBe('fixture-custom');
    expect(useServers.getState().servers.at(-1)?.baseUrl).toBe('http://10.2.3.4:8765');
  });

  it.each([{ id: 'remote', expected: 'remote' }, { id: '', expected: '10.2.3.4' }])('sem nome usa identificador ou IP inteiro: $expected', async ({ id, expected }) => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/identificador') ? json({ identificador: id, lan_url: '' }) : original(url));
    await render(); await type(m.mobile_machines_endpoint(), 'http://10.2.3.4:8765'); await type(m.mobile_machines_token(), 'remote-secret');
    expect(mocks.fetch).not.toHaveBeenCalled();
    await click(m.mobile_machines_save());
    expect(useServers.getState().servers.at(-1)?.label).toBe(expected);
  });

  it('registra ida e volta sem gravar loopback na outra ponta e mostra falha parcial', async () => {
    const localOwner = { ...owner, baseUrl: 'http://127.0.0.1:8765' };
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/identificador')) return json({ identificador: url.startsWith(localOwner.baseUrl) ? 'owner' : 'remote', lan_url: '' });
      if (url.endsWith('/alcance')) return json({ loopback: true, bind: '127.0.0.1', enderecos: [
        { tipo: 'rede_local', url: 'http://192.168.0.9:8765', estado: 'ok', tempo_ms: 4, motivo: '' },
      ] });
      if (url.endsWith('/api/peers') && init?.method === 'POST') return url.startsWith(localOwner.baseUrl) ? json([]) : json({ detail: 'fixture-return-refused' }, 403);
      if (url.includes('/check?')) return json({ estado: url.startsWith(localOwner.baseUrl) ? 'ok' : 'recusou', identificador: url.startsWith(localOwner.baseUrl) ? 'remote' : '', tempo_ms: 5, motivo: 'fixture-return-check' });
      return json({ campos: {}, somente_leitura: {} });
    });
    await render(localOwner); await type(m.mobile_machines_endpoint(), 'https://remote.test'); await type(m.mobile_machines_token(), 'remote-secret');
    await click(m.mobile_machines_register_both()); await click(m.mobile_machines_save());
    const posts = mocks.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1][1].body).base_url).toBe('http://192.168.0.9:8765');
    expect(el.textContent).toContain('fixture-return-refused');
    expect(el.textContent).not.toContain(m.mobile_machines_registered());
    expect(useServers.getState().servers.some((s) => s.baseUrl === 'https://remote.test')).toBe(true);
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/check?'))).toHaveLength(2);
  });
});
