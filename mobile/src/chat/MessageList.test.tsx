// @vitest-environment happy-dom
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi, configureLocale, type ChatEvent, type OrqEntry, type SessionInfo } from '@hangar/core';
import { overwriteGetLocale } from '../paraglide/runtime';
import { MessageList } from './MessageList';
import { chatStore, _resetChatsForTests } from '../stores/chat';
import * as m from '../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

overwriteGetLocale(() => 'pt');
configureLocale({ getLocale: () => 'pt' });
vi.mock('../paraglide/messages', async (original) => ({
  ...await original<typeof import('../paraglide/messages')>(),
  ...Object.fromEntries(
    ('native_delivery_failed native_delivery_unproved native_queue_held native_no_safe_delivery native_delivering native_queued '
      + 'native_queue_discard msg_nao_chegou_reenvie msg_aria_mensagens chat_servidor_removido')
      .split(' ').map((key) => [key, () => key]),
  ),
  native_queue_discard_message: ({ text }: { text: string }) => `native_queue_discard_message:${text}`,
}));
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
vi.mock('./AssistantBubble', () => ({ AssistantBubble: () => null, mkMarkdownStyle: () => ({}) }));
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('article', null, markdown) }));
vi.mock('../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('section', null, children) }));
vi.mock('../ui/Toast', () => ({ toast: { erro: vi.fn() } }));
vi.mock('./PreviewBubble', () => ({ PreviewBubble: () => null }));
vi.mock('./LiveWork', () => ({ AgentesRodando: () => null, PensamentoVivo: () => null, WorkingLine: () => null }));
vi.mock('./TaskList', () => ({ TaskList: () => null }));
vi.mock('./tools/ToolGroup', () => ({ ToolGroup: () => null }));
vi.mock('./tools/ToolCard', () => ({ ToolCard: () => null }));
vi.mock('./tools/ToolDetailSheet', () => ({ ToolDetailSheet: () => null }));
vi.mock('./tools/HtmlPageCard', () => ({ HtmlPageCard: () => null }));
const list = vi.hoisted(() => ({ render: vi.fn(), data: vi.fn() }));
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: ({ data, renderItem, ListFooterComponent }: {
    data: { id: string }[]; renderItem: (row: { item: unknown }) => ReactNode; ListFooterComponent?: ReactNode;
  }) => {
    list.render(renderItem);
    list.data(data);
    return createElement('div', null,
      ...data.map((item) => createElement('div', { key: item.id, 'data-row': item.id }, renderItem({ item }))), ListFooterComponent);
  },
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
const discardButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[aria-label^="native_queue_discard_message:"]')];

beforeEach(() => {
  list.render.mockClear();
  list.data.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
  // B está ativo, mas o chat abaixo é de A.
  configureApi({ getBaseUrl: () => servers.servers[1].baseUrl, getToken: () => 'token-b', onUnauthorized: () => {}, origin: null,
    createEventSource: () => { throw new Error('unexpected SSE'); } });
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  _resetChatsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('timeline orq entra antes do aviso genérico e atualiza só a fronteira do dia ao carregar anteriores', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 16, 18));
  const orq: OrqEntry = { kind: 'advance', task: 3, line: { code: 'integrated', merge: true }, origin: 'orchestrator',
    sender: null, mark: null, alarm: false, rejected_round: null, body: '', question: null, parecer: null, error: null, decided_by: null };
  const notice = (id: string, day: number, hour: number) => event({ id, kind: 'notice', text: 'raw-orq', orq,
    ts: new Date(2026, 9, day, hour).getTime() / 1000 });
  const first = notice('first', 15, 9), second = notice('second', 15, 10), nextDay = notice('next-day', 16, 11);
  const initial = props([first, second, nextDay, event({ id: 'plain', kind: 'notice', text: 'interrupted' }),
    event({ id: 'unknown', kind: 'notice', text: 'future-notice' }), event({ id: 'user', text: 'user-content' })], { sessionName: 'sess', serverId: 'a' });
  const { container, root } = mount(createElement(MessageList, initial));
  const row = (id: string) => container.querySelector(`[data-row="${id}"]`)!;
  expect(row('first').textContent).toContain('fechada → merge → integração verde');
  expect(row('first').textContent).toContain('ontem · 09:00');
  expect(row('second').textContent).not.toContain('ontem');
  expect(row('second').textContent).toContain('10:00');
  expect(row('next-day').textContent).toContain('hoje · 11:00');
  expect(row('plain').textContent).toBe(m.notice_interrupted());
  expect(row('unknown').textContent).toBe('future-notice');
  expect(row('user').textContent).toBe('user-content');
  expect(container.textContent).not.toContain('raw-orq');
  const renderItem = list.render.mock.lastCall![0];
  const rows = list.data.mock.lastCall![0] as { id: string }[];
  act(() => root.render(createElement(MessageList, { ...initial, preview: 'streaming-preview' })));
  expect(list.render.mock.lastCall![0]).toBe(renderItem);
  expect(list.data.mock.lastCall![0]).toBe(rows);
  act(() => root.render(createElement(MessageList, { ...initial, events: [notice('earlier', 15, 8), ...initial.events] })));
  expect(row('earlier').textContent).toContain('ontem · 08:00');
  expect(row('first').textContent).not.toContain('ontem');
  const updated = list.data.mock.lastCall![0] as { id: string }[];
  expect(updated.find(item => item.id === 'first')).not.toBe(rows.find(item => item.id === 'first'));
  expect(updated.find(item => item.id === 'second')).toBe(rows.find(item => item.id === 'second'));
  expect(list.render.mock.lastCall![0]).toBe(renderItem);
  expect(fetch).not.toHaveBeenCalled();
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

  it.each([
    [{ queued_delivered: true }, 'terminal_input_delivery_unproved'],
    [{ queued_delivered: false }, 'terminal_input_delivery_unproved'],
    [{ queued_delivered: false }, 'terminal_input_no_safe_delivery'],
    [{ desistiu: true }, undefined],
    [{ hook_error: 'hook recusou' }, undefined],
    [{ queued_delivered: true }, undefined],
    [{ queued_delivered: false }, undefined],
    [{ id: 'held:one', hook_error: 'hook recusou' }, undefined],
  ] as [Partial<ChatEvent>, string | undefined][])('consumida fica sólida, sem nota ou descarte: %j/%s', (patch, problem) => {
    const { container } = mount(createElement(MessageList, props([event({ ...patch, queued_consumed: true })], {
      sessionName: 'sess', serverId: 'a', stateEvent: { session: 'sess', state: 'working', problema: problem },
    })));
    expect(container.querySelector('[data-user]')?.textContent).toBe('mensagem');
    expect(container.querySelector('[data-user]')?.closest('[style*="opacity"]')).toBeNull();
    expect(container.textContent).toBe('mensagem');
    expect(discardButtons(container)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
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

it('renderItem mantém identidade no tique da sessão e reage a provider/headless', () => {
  const initial = props([event({ queued_delivered: true })]);
  const { container, root } = mount(createElement(MessageList, initial));
  const renderItem = list.render.mock.lastCall![0];
  expect(container.querySelector('[data-user]')?.closest('[style*="opacity"]')).not.toBeNull();

  const tickSession = { ...session, last_activity: 2, status_line: 'tick', git_added: 1 };
  act(() => root.render(createElement(MessageList, { ...initial, session: tickSession })));
  expect(list.render.mock.lastCall![0]).toBe(renderItem);

  act(() => root.render(createElement(MessageList, { ...initial, session: { ...tickSession, headless: true } })));
  const headlessRender = list.render.mock.lastCall![0];
  expect(headlessRender).not.toBe(renderItem);
  expect(container.querySelector('[data-user]')?.closest('[style*="opacity"]')).toBeNull();

  act(() => root.render(createElement(MessageList, initial)));
  const terminalRender = list.render.mock.lastCall![0];
  expect(terminalRender).not.toBe(headlessRender);
  expect(container.querySelector('[data-user]')?.closest('[style*="opacity"]')).not.toBeNull();

  act(() => root.render(createElement(MessageList, { ...initial, session: { ...session, provider: 'codex' } })));
  expect(list.render.mock.lastCall![0]).not.toBe(terminalRender);
  expect(container.querySelector('[data-user]')?.closest('[style*="opacity"]')).toBeNull();
});

it('botões de descarte identificam a mensagem com trecho normalizado e limitado', () => {
  const text = `  first-message\n\t${'x'.repeat(90)}`;
  const { container } = mount(createElement(MessageList, props([
    event({ text, desistiu: true }), event({ id: 'queued-two', text: 'second-message', desistiu: true }),
  ], { sessionName: 'sess', serverId: 'a' })));
  const buttons = discardButtons(container);
  expect(buttons).toHaveLength(2);
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
    m.native_queue_discard_message({ text: `first-message ${'x'.repeat(66)}` }),
    m.native_queue_discard_message({ text: 'second-message' }),
  ]);
  expect(buttons.map((button) => button.textContent)).toEqual([m.native_queue_discard(), m.native_queue_discard()]);
  expect(fetch).not.toHaveBeenCalled();
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

it('descarte mostra só o erro próprio, expira em 6s sem apagar bolha e a próxima ação não herda a causa', async () => {
  vi.useFakeTimers();
  const chat = chatStore('a', 'sess');
  chat.use.setState({ events: [event({ text: 'first-message', desistiu: true }), event({ id: 'queued-two', text: 'second-message', desistiu: true })] });
  function Conversation() {
    return createElement(MessageList, props(chat.use((s) => s.events), { sessionName: 'sess', serverId: 'a' }));
  }
  const { container } = mount(createElement(Conversation));
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  const unsubscribe = chat.use.subscribe((state, previous) => {
    if (previous.queueBusy && !state.queueBusy) chat.use.setState({ queueError: 'other-action' });
  });
  try {
    act(() => discardButtons(container)[0].click());
    await act(async () => { resolve(new Response('{"detail":"first-error"}', { status: 409 })); });
    expect(chat.use.getState().queueError).toBe('other-action');
    expect([...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual(['first-error']);
  } finally {
    unsubscribe();
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(5999); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('first-error');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect([...container.querySelectorAll('[data-user]')].map((bubble) => bubble.textContent)).toEqual(['first-message', 'second-message']);
  expect(chat.use.getState().events.map((e) => e.id)).toEqual(['queued-one', 'queued-two']);

  act(() => discardButtons(container)[1].click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { resolve(new Response('{"detail":"second-error"}', { status: 409 })); });
  expect([...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual(['second-error']);
  act(() => discardButtons(container)[1].click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(chat.use.getState().events.map((e) => e.id)).toEqual(['queued-one', 'queued-two']);
  await act(async () => { resolve(new Response('{"ok":true}', { status: 200 })); });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect([...container.querySelectorAll('[data-user]')].map((bubble) => bubble.textContent)).toEqual(['first-message']);
  expect(chat.use.getState().events.map((e) => e.id)).toEqual(['queued-one']);
});

it('servidor removido aparece na própria bolha e desmontar limpa o timer local', async () => {
  vi.useFakeTimers();
  const { container, root } = mount(createElement(MessageList, props([event({ desistiu: true })], {
    sessionName: 'sess', serverId: 'missing',
  })));
  await act(async () => { discardButtons(container)[0].click(); });
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(m.chat_servidor_removido());
  expect(container.querySelector('[data-user]')?.textContent).toBe('mensagem');
  expect(discardButtons(container)[0].disabled).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await act(async () => { discardButtons(container)[0].click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(m.chat_servidor_removido());
  // O aviso global continua no store; só o timer da bolha é cancelado na desmontagem.
  expect(vi.getTimerCount()).toBe(2);
  act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(1);
});
