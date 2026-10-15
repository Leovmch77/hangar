// @vitest-environment happy-dom
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi, type ChatEvent, type SessionInfo } from '@hangar/core';
import { MessageList } from './MessageList';
import { chatStore, _resetChatsForTests } from '../stores/chat';
import * as m from '../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../paraglide/messages', () => Object.fromEntries(
  ('native_delivery_failed native_delivery_unproved native_queue_held native_no_safe_delivery native_delivering native_queued '
    + 'native_queue_discard msg_nao_chegou_reenvie msg_aria_mensagens chat_servidor_removido')
    .split(' ').map((key) => [key, () => key]),
));
vi.mock('react-native-mmkv', () => ({ createMMKV: () => ({ getString: () => undefined, set: () => {}, remove: () => {} }) }));
const servers = vi.hoisted(() => ({ servers: [
  { id: 'a', label: 'a', baseUrl: 'http://10.0.0.1:8765', token: 'token-a' },
  { id: 'b', label: 'b', baseUrl: 'http://10.0.0.2:8765', token: 'token-b' },
] }));
vi.mock('../stores/servers', () => ({ useServers: { getState: () => servers } }));
vi.mock('../stores/aparencia', () => ({ useAparencia: (select: (s: unknown) => unknown) => select({ pensamentoTools: 'busca' }) }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
// Só a casca visual é substituída; lista, notas, ação, store e API da fila são os reais.
vi.mock('./UserBubble', () => ({ UserBubble: ({ text }: { text: string }) => createElement('span', { 'data-user': true }, text) }));
vi.mock('./AssistantBubble', () => ({ AssistantBubble: () => null }));
vi.mock('./PreviewBubble', () => ({ PreviewBubble: () => null }));
vi.mock('./LiveWork', () => ({ AgentesRodando: () => null, PensamentoVivo: () => null, WorkingLine: () => null }));
vi.mock('./TaskList', () => ({ TaskList: () => null }));
vi.mock('./tools/ToolGroup', () => ({ ToolGroup: () => null }));
vi.mock('./tools/ToolCard', () => ({ ToolCard: () => null }));
vi.mock('./tools/ToolDetailSheet', () => ({ ToolDetailSheet: () => null }));
vi.mock('./tools/HtmlPageCard', () => ({ HtmlPageCard: () => null }));
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: ({ data, renderItem, ListFooterComponent }: {
    data: { id: string }[]; renderItem: (row: { item: unknown }) => ReactNode; ListFooterComponent?: ReactNode;
  }) => createElement('div', null,
    ...data.map((item) => createElement('div', { key: item.id }, renderItem({ item }))), ListFooterComponent),
}));

type Props = ComponentProps<typeof MessageList>;
const session = { name: 'sess', provider: 'claude', headless: false } as SessionInfo;
const event = (patch: Partial<ChatEvent> = {}): ChatEvent => ({ id: 'queued-one', kind: 'user_msg', text: 'mensagem', ...patch });
const props = (events: ChatEvent[], extra: Partial<Props> = {}): Props => ({
  events, preview: '', olderFailed: '', onLoadOlder: () => {}, session,
  stateEvent: { session: 'sess', state: 'working' }, ...extra,
});
const roots: Root[] = [];
function mount(node: ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return { container, root };
}
const discardButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${m.native_queue_discard()}"]`)];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
  // B está ativo, mas o chat abaixo é de A.
  configureApi({ getBaseUrl: () => servers.servers[1].baseUrl, getToken: () => 'token-b', onUnauthorized: () => {}, origin: null,
    createEventSource: () => { throw new Error('unexpected SSE'); } });
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  _resetChatsForTests();
  vi.unstubAllGlobals();
});

describe('notas da entrega na conversa', () => {
  it.each([
    [{ desistiu: true }, undefined, ['native_delivery_failed', 'msg_nao_chegou_reenvie']],
    [{ id: 'held:one' }, undefined, ['native_delivery_failed']],
    [{ id: 'held:one', hook_error: 'hook recusou' }, undefined, ['hook recusou']],
    [{ id: 'real', hook_error: 'hook recusou' }, undefined, ['hook recusou']],
    [{ queued_delivered: true }, 'terminal_input_delivery_unproved', ['native_delivery_unproved']],
    [{ queued_delivered: false }, 'terminal_input_delivery_unproved', ['native_queue_held']],
    [{}, 'terminal_input_no_safe_delivery', ['native_no_safe_delivery']],
    [{ queued_delivered: true }, undefined, ['native_delivering']],
    [{ queued_delivered: false }, undefined, ['native_queued']],
    [{ queued_delivered: true, queued_consumed: true }, undefined, []],
  ] as [Partial<ChatEvent>, string | undefined, string[]][])('evento %j, problema %s', (patch, problem, expected) => {
    const { container } = mount(createElement(MessageList, props([event(patch)], {
      stateEvent: { session: 'sess', state: 'working', problema: problem },
    })));
    expect(container.textContent).toBe('mensagem' + expected.join(' · '));
    expect(discardButtons(container)).toHaveLength(0);
  });

  it('desistida fica sólida e não aparece como esperando, mesmo trabalhando', () => {
    const { container } = mount(createElement(MessageList, props([event({ desistiu: true, queued_delivered: false })])));
    expect(container.querySelector('[data-user]')?.closest('[style*="opacity"]')).toBeNull();
    expect(container.textContent).toContain(m.msg_nao_chegou_reenvie());
    expect(container.textContent).not.toContain(m.native_queued());
  });

  it('mudança do problema refaz a nota; a entrada do painel não duplica na conversa', () => {
    const waiting = event({ queued_delivered: false });
    const { container, root } = mount(createElement(MessageList, props([waiting])));
    expect(container.textContent).toContain(m.native_queued());
    act(() => root.render(createElement(MessageList, props([waiting], {
      stateEvent: { session: 'sess', state: 'working', problema: 'terminal_input_delivery_unproved' },
    }))));
    expect(container.textContent).toContain(m.native_queue_held());
    act(() => root.render(createElement(MessageList, props([waiting], {
      queuePanel: { entries: [{ id: 'one', text: 'mensagem', ts: null }], actions: true },
    }))));
    expect(container.querySelector('[data-user]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it.each([
    [{ desistiu: true }, undefined, 1],
    [{ queued_delivered: true }, 'terminal_input_delivery_unproved', 1],
    [{ queued_delivered: false }, 'terminal_input_delivery_unproved', 0],
    [{ queued_delivered: false }, 'terminal_input_no_safe_delivery', 0],
    [{ queued_delivered: true }, undefined, 0],
    [{ queued_delivered: false }, undefined, 0],
    [{ id: 'held:one', desistiu: true }, undefined, 0],
    [{ id: 'real', hook_error: 'hook recusou' }, undefined, 0],
  ] as [Partial<ChatEvent>, string | undefined, number][])('Descartar só na bolha permitida %j/%s', (patch, problem, count) => {
    const { container } = mount(createElement(MessageList, props([event(patch)], {
      sessionName: 'sess', serverId: 'a', stateEvent: { session: 'sess', state: 'working', problema: problem },
    })));
    expect(discardButtons(container)).toHaveLength(count);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ sessionName: 'sess' }, { serverId: 'a' }, {}])('leitura sem identidade completa não oferece descarte: %j', (identity) => {
    const { container } = mount(createElement(MessageList, props([event({ desistiu: true })], identity)));
    expect(container.textContent).toContain(m.native_delivery_failed());
    expect(discardButtons(container)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('ação pública mantém erro e bolha; ocupado desabilita, e ACK tira só o alvo no servidor da rota', async () => {
  const chat = chatStore('a', 'sess');
  chat.use.setState({ events: [event({ id: 'queued-raw/id', desistiu: true }), event({ id: 'queued-other', text: 'vizinha', desistiu: true })] });
  function Conversation() {
    return createElement(MessageList, props(chat.use((s) => s.events), { sessionName: 'sess', serverId: 'a' }));
  }
  const { container } = mount(createElement(Conversation));
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal('fetch', fetchMock);
  act(() => discardButtons(container)[0].click());
  expect(discardButtons(container).every((button) => button.disabled)).toBe(true);
  expect(container.textContent).toContain('loading');
  expect(container.textContent).toContain('mensagem');
  expect(fetchMock.mock.calls[0][0]).toBe('http://10.0.0.1:8765/api/sessions/sess/queue/raw%2Fid');
  expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer token-a');
  await act(async () => { resolve(new Response('{"detail":"descarte recusado"}', { status: 409 })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('descarte recusado');
  expect(container.textContent).toContain('mensagem');
  expect(discardButtons(container).every((button) => !button.disabled)).toBe(true);
  act(() => discardButtons(container)[0].click());
  await act(async () => { resolve(new Response('{"ok":true}', { status: 200 })); });
  expect(container.textContent).not.toContain('mensagem');
  expect(container.textContent).toContain('vizinha');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(chat.use.getState().events.map((e) => e.id)).toEqual(['queued-other']);
});
