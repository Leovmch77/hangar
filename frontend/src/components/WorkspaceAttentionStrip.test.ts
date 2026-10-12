// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { createClassComponent } from 'svelte/legacy';
import { configureApi, type AggSession } from '@hangar/core';
import WorkspaceAttentionStrip from './WorkspaceAttentionStrip.svelte';
import { overwriteGetLocale } from '../paraglide/runtime';

const auth = vi.hoisted(() => ({
  activeId: 'c',
  servers: [
    { id: 'a', label: 'a', baseUrl: 'https://a.test', token: 'token-a' },
    { id: 'b', label: 'b', baseUrl: 'https://b.test', token: 'token-b' },
    { id: 'c', label: 'c', baseUrl: 'https://c.test', token: 'token-c' },
  ],
  selectServer: vi.fn<(id: string) => boolean>(),
}));
vi.mock('../lib/auth', () => ({
  listServers: () => auth.servers,
  getActiveId: () => auth.activeId,
  selectServer: auth.selectServer,
}));

afterEach(() => vi.restoreAllMocks());

it('A e B sobrepostas mantêm C ativo e enviam cada identidade ao servidor da pendência', async () => {
  overwriteGetLocale(() => 'pt');
  auth.activeId = 'c';
  auth.selectServer.mockImplementation((id) => { auth.activeId = id; return true; });
  configureApi({
    getBaseUrl: () => auth.servers.find((s) => s.id === auth.activeId)!.baseUrl,
    getToken: () => auth.servers.find((s) => s.id === auth.activeId)!.token,
    onUnauthorized: vi.fn(), origin: null,
    createEventSource: () => { throw new Error('sem SSE no teste'); },
  });
  const completions: Array<(response: Response) => void> = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => {
    completions.push(resolve);
  }));
  const first: AggSession = {
    name: 'same-session', state: 'awaiting_input', serverId: 'a', serverLabel: 'a', serverColor: '#fff',
    question: 'allow-request', options: ['allow-once'], interaction_id: 'interaction-a',
  };
  const second: AggSession = { ...first, serverId: 'b', serverLabel: 'b', interaction_id: 'interaction-b' };
  const target = document.createElement('div'); document.body.appendChild(target);
  const component = createClassComponent({ component: WorkspaceAttentionStrip, target, props: {
    rows: [first], onOpenSession: vi.fn(),
  } });
  try {
    await tick();
    target.querySelector<HTMLButtonElement>('.quick-options button')!.click(); await tick();
    component.$set({ rows: [second] }); await tick();
    target.querySelector<HTMLButtonElement>('.quick-options button')!.click(); await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url, method: init?.method, body: JSON.parse(init?.body as string),
      authorization: (init?.headers as Record<string, string>).Authorization,
    }))).toEqual([
      { url: 'https://a.test/api/sessions/same-session/select', method: 'POST', body: { option: 1, interaction_id: 'interaction-a' }, authorization: 'Bearer token-a' },
      { url: 'https://b.test/api/sessions/same-session/select', method: 'POST', body: { option: 1, interaction_id: 'interaction-b' }, authorization: 'Bearer token-b' },
    ]);
    expect(auth.activeId).toBe('c');
    completions[0](new Response('{"ok":true}'));
    await vi.waitFor(() => expect(fetchMock.mock.results[0].value).resolves.toBeInstanceOf(Response));
    await tick();
    expect(auth.activeId).toBe('c');
    expect(target.querySelector<HTMLButtonElement>('.quick-options button')!.disabled).toBe(true);
    completions[1](new Response('{"ok":true}'));
    await vi.waitFor(() => expect(target.querySelector<HTMLButtonElement>('.quick-options button')!.disabled).toBe(false));
    expect(auth.activeId).toBe('c');
    expect(auth.selectServer).not.toHaveBeenCalled();
  } finally {
    component.$destroy(); target.remove();
  }
});
