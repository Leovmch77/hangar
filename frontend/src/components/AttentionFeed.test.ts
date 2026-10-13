// @vitest-environment happy-dom
// Decisão M11: a pergunta da lista (AskUserQuestion fora do quadro ou segurada pelo plugin) responde do
// próprio card, pelo `/answer`, com o ID do formulário e no servidor dono; o chat não precisa abrir.
import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { createClassComponent } from 'svelte/legacy';
import { configureApi, type AggSession } from '@hangar/core';
import AttentionFeed from './AttentionFeed.svelte';
import { overwriteGetLocale } from '../paraglide/runtime';

const auth = vi.hoisted(() => ({
  activeId: 'c',
  servers: [
    { id: 'a', label: 'a', baseUrl: 'https://a.test', token: 'token-a' },
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

it('formulário da lista responde pelo /answer do servidor dono, sem abrir o chat', async () => {
  overwriteGetLocale(() => 'pt');
  auth.activeId = 'c';
  auth.selectServer.mockImplementation((id) => { auth.activeId = id; return true; });
  configureApi({
    getBaseUrl: () => auth.servers.find((s) => s.id === auth.activeId)!.baseUrl,
    getToken: () => auth.servers.find((s) => s.id === auth.activeId)!.token,
    onUnauthorized: vi.fn(), origin: null,
    createEventSource: () => { throw new Error('sem SSE no teste'); },
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
  const onOpenChat = vi.fn();
  const session: AggSession = {
    name: 's', state: 'awaiting_input', serverId: 'a', serverLabel: 'a', serverColor: '#fff', question: 'Qual?',
    ask_form: { request_id: 'ask:t1', interaction_id: 'form-a', questions: [{ header: 'H', question: 'Qual?', multiSelect: false,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] },
  };
  const target = document.createElement('div'); document.body.appendChild(target);
  const component = createClassComponent({ component: AttentionFeed, target, props: { sessions: [session], onOpenChat } });
  try {
    await tick();
    target.querySelector<HTMLButtonElement>('.attn-main')!.click(); await tick();
    expect(onOpenChat).not.toHaveBeenCalled();
    target.querySelectorAll<HTMLButtonElement>('.option-btn')[1]!.click(); await tick();
    target.querySelector<HTMLButtonElement>('.primary-btn')!.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/api/sessions/s/answer');
    expect(JSON.parse(init?.body as string)).toEqual({ answers: [{ kind: 'option', indices: [1], multi: false, labels: ['B'] }],
      request_id: 'ask:t1', interaction_id: 'form-a' });
    await vi.waitFor(() => expect(auth.activeId).toBe('c'));
  } finally {
    component.$destroy(); target.remove();
  }
});
