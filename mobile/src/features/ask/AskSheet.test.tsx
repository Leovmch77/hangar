/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configureApi } from '@hangar/core';
import type { AskQuestionPayload } from '@hangar/core';
import { chatStore, _resetChatsForTests } from '../../stores/chat';
import * as m from '../../paraglide/messages';
vi.mock('../../stores/prefs', () => ({
  prefs: { getString: () => undefined, set: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../stores/servers', () => ({ useServers: { getState: () => ({
  servers: [{ id: 'srv', baseUrl: 'http://teste' }, { id: 'other', baseUrl: 'http://other' }],
}) } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), params: { server: 'srv', name: 'sess' } }));
const focusNavigation = vi.hoisted(() => ({
  listener: null as ((event: { data: { closing: boolean } }) => void) | null,
  focused: true, send: vi.fn(),
}));
const nativeNavigation = {
  isFocused: () => focusNavigation.focused,
  addListener: (_name: string, listener: (event: { data: { closing: boolean } }) => void) => {
    focusNavigation.listener = listener;
    return () => { focusNavigation.listener = null; };
  },
};
vi.mock('expo-router', () => ({
  useNavigation: () => nativeNavigation,
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ canGoBack: () => true, ...mocks }),
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('react-native', async (original) => ({
  ...await original<object>(),
  AccessibilityInfo: { sendAccessibilityEvent: focusNavigation.send },
  TextInput: ({ secureTextEntry, value, onChangeText }: {
    secureTextEntry?: boolean; value: string; onChangeText: (value: string) => void;
  }) => React.createElement('input', {
    type: secureTextEntry ? 'password' : 'text', value,
    onInput: (event: React.FormEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value),
  }),
}));

import AskSheet from '../../../app/s/[server]/[name]/ask';
import { AskStepper } from './AskStepper';

let root: Root;
let container: HTMLDivElement;
const payload: AskQuestionPayload = {
  provider: 'codex', request_id: 41,
  questions: [{ id: 'choice', header: 'Escolha', question: 'Qual?', multiSelect: false,
    options: [{ label: 'Primeira', description: '' }] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = { server: 'srv', name: 'sess' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
  configureApi({
    getBaseUrl: () => 'http://localhost:8765', getToken: () => 'tok', onUnauthorized: () => {},
    origin: null, createEventSource: vi.fn(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  _resetChatsForTests();
  vi.unstubAllGlobals();
});

async function open(value = payload) {
  chatStore('srv', 'sess').openAsk(value);
  await act(async () => root.render(React.createElement(AskSheet)));
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

test('envia identidades nativas e mantém a pergunta quando RPC falha', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"indisponível"}', { status: 503 })));
  await open();
  expect(container.textContent).not.toContain(m.askq_digitar_resposta());
  expect(container.textContent).not.toContain(m.askq_conversar_sobre());
  await click('Primeira');
  await click(m.lista_enviar());
  const options = vi.mocked(fetch).mock.calls[0][1];
  expect(JSON.parse(options?.body as string)).toMatchObject({
    request_id: 41, answers: [{ question_id: 'choice', indices: [0] }],
  });
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(true);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(container.textContent).toContain('indisponível');
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://teste/api/sessions/sess/answer');
});

test('foco entra na solicitação depois da apresentação e muda só para nova pergunta', async () => {
  await open();
  expect(focusNavigation.send).not.toHaveBeenCalled();
  act(() => focusNavigation.listener?.({ data: { closing: false } }));
  const heading = container.querySelector('[role="header"]');
  expect(heading).not.toBeNull();
  expect(focusNavigation.send).toHaveBeenCalledExactlyOnceWith(heading, 'focus');
  await act(async () => chatStore('srv', 'sess').use.setState({ preview: 'token novo' }));
  expect(focusNavigation.send).toHaveBeenCalledTimes(1);
  await act(async () => chatStore('srv', 'sess').openAsk({ ...payload, request_id: 42 }));
  expect(focusNavigation.send).toHaveBeenCalledTimes(2);
  act(() => focusNavigation.listener?.({ data: { closing: true } }));
  await act(async () => chatStore('srv', 'sess').openAsk({ ...payload, request_id: 43 }));
  expect(focusNavigation.send).toHaveBeenCalledTimes(2);
});

test('dois toques e cancelar durante resposta fazem só uma mutação', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  await open({ ...payload, is_async: true, request_id: 'async-1' });
  await click('Primeira');
  const send = [...container.querySelectorAll('button')].find((b) => b.textContent === m.lista_enviar())!;
  const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === m.comum_cancelar())!;
  act(() => { send.click(); send.click(); cancel.click(); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => finish(new Response('{"ok":true}')));
});

test('gesto de voltar do VoiceOver fecha a folha sem descartar a pergunta assíncrona', async () => {
  await open({ ...payload, is_async: true, request_id: 'async-1' });
  const modal = container.querySelector('[role="header"]')!.parentElement!;
  const propsKey = Object.keys(modal).find((key) => key.startsWith('__reactProps'));
  expect(propsKey).toBeDefined();
  const props = (modal as unknown as Record<string, { onAccessibilityEscape: () => void }>)[propsKey!];
  await act(async () => props.onAccessibilityEscape());
  expect(mocks.back).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(chatStore('srv', 'sess').use.getState().askPayload?.request_id).toBe('async-1');
  expect(fetch).not.toHaveBeenCalled();
});

test('cancelamento assíncrono usa o servidor da rota e bloqueia a resposta', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  await open({ ...payload, is_async: true, request_id: 'async-1' });
  await click('Primeira');
  await click(m.comum_cancelar());
  await click(m.lista_enviar());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://teste/api/sessions/sess/question/skip');
  await act(async () => finish(new Response('{"ok":true}')));
});

test.each([false, true])('resultado tardio não fecha pergunta sem ID nem mostra erro antigo: %s', async (fail) => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  await open({ questions: payload.questions });
  await click('Primeira');
  await click(m.lista_enviar());
  const next = { questions: [{ ...payload.questions[0], question: 'Outra?', options: [] }] };
  await act(async () => chatStore('srv', 'sess').openAsk(next));
  await act(async () => finish(new Response(fail ? '{"detail":"erro-antigo"}' : '{"ok":true}', { status: fail ? 503 : 200 })));
  expect(chatStore('srv', 'sess').use.getState().askPayload).toBe(next);
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(true);
  expect(container.textContent).toContain('Outra?');
  expect(container.textContent).not.toContain('erro-antigo');
  expect(mocks.replace).not.toHaveBeenCalled();
});

test.each([false, true])('A e B idênticas usam tokens próprios; retorno atrasado não fecha B: %s', async (fail) => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockImplementation(async () => new Response('{"ok":true}')));
  const first = { ...payload, request_id: 0, interaction_id: 'form-a' };
  const second = { ...first, interaction_id: 'form-b' };
  await open(first);
  chatStore('srv', 'sess').use.setState({ stateEvent: {
    session: 'sess', state: 'awaiting_input', question: 'Permitir?', options: ['Sim'], interaction_id: 'approval-a',
  } });
  await click('Primeira');
  await click(m.lista_enviar());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({ request_id: 0, interaction_id: 'form-a' });
  await act(async () => chatStore('srv', 'sess').openAsk(second));
  expect(first.questions).toEqual(second.questions);
  expect(container.textContent).not.toContain(m.askq_revisar());
  await act(async () => finish(new Response(fail ? '{"detail":"erro-antigo"}' : '{"ok":true}', { status: fail ? 409 : 200 })));
  expect(chatStore('srv', 'sess').use.getState().askPayload).toBe(second);
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(true);
  expect(container.textContent).not.toContain('erro-antigo');
  expect(mocks.back).not.toHaveBeenCalled();
  await click('Primeira');
  await click(m.lista_enviar());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string)).toMatchObject({ request_id: 0, interaction_id: 'form-b' });
  expect(chatStore('srv', 'sess').use.getState().stateEvent?.interaction_id).toBe('approval-a');
});

test('erro de identidade Claude preserva rascunho e não redireciona nem repete', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"interaction_stale"}', { status: 409 })));
  await open({ questions: payload.questions, interaction_id: 'form-a' });
  await click('Primeira');
  await click(m.lista_enviar());
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(true);
  expect(container.textContent).toContain('interaction_stale');
  expect(container.textContent).toContain(m.askq_revisar());
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('fallback é entrega por texto e resposta incerta mantém a pergunta visível', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":false}')));
  await open();
  await click('Primeira');
  await click(m.lista_enviar());
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(true);
  expect(container.textContent).toContain(m.native_action_uncertain());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"fallback":true}')));
  await click(m.lista_enviar());
  expect(mocks.dismissTo).toHaveBeenCalledWith(expect.stringMatching(/^\/s\/srv\/sess\?askFallback=\d+$/));
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(false);
});

test.each(['review', 'text'])('cancelar Expo guarda o token exibido mesmo com objeto reutilizado: %s', async (step) => {
  const displayed: AskQuestionPayload = { ...payload, is_async: true,
    request_id: 'same-native-id', interaction_id: 'form-a',
    questions: step === 'text' ? [{ ...payload.questions[0], options: [] }] : payload.questions };
  const onClose = vi.fn();
  await act(async () => root.render(React.createElement(AskStepper, {
    payload: displayed, onSubmit: vi.fn(), onClose,
  })));
  if (step === 'review') await click('Primeira');
  displayed.interaction_id = 'form-b';
  await click(m.comum_cancelar());
  expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({
    request_id: 'same-native-id', interaction_id: 'form-a',
  }));
});

test.each(['accepted', 'rejected', 'unknown'])('descarte Expo envia A exibida e preserva B no retorno %s', async (outcome) => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockImplementation(async () => new Response('{"ok":true}')));
  const first = { ...payload, is_async: true, request_id: 'same-native-id', interaction_id: 'form-a' };
  const second = { ...first, interaction_id: 'form-b' };
  await open(first);
  await click('Primeira');
  await click(m.comum_cancelar());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({
    request_id: 'same-native-id', interaction_id: 'form-a',
  });
  await act(async () => chatStore('srv', 'sess').openAsk(second));
  await act(async () => finish(new Response(outcome === 'rejected' ? '{"detail":"erro-antigo"}'
    : JSON.stringify({ ok: outcome === 'accepted' }), { status: outcome === 'rejected' ? 409 : 200 })));
  expect(chatStore('srv', 'sess').use.getState().askPayload).toBe(second);
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(true);
  expect(container.textContent).not.toContain('erro-antigo');
  expect(mocks.back).not.toHaveBeenCalled();
  await click('Primeira');
  await click(m.comum_cancelar());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string)).toEqual({
    request_id: 'same-native-id', interaction_id: 'form-b',
  });
});

test('ACK de cancelamento antigo não fecha pergunta em outro servidor', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  await open({ ...payload, is_async: true, request_id: 'async-1' });
  await click('Primeira');
  await click(m.comum_cancelar());
  mocks.params = { server: 'other', name: 'sess' };
  chatStore('other', 'sess').openAsk({ ...payload, request_id: 42 });
  await act(async () => root.render(React.createElement(AskSheet)));
  const backs = mocks.back.mock.calls.length;
  await act(async () => finish(new Response('{"ok":true}')));
  expect(chatStore('other', 'sess').use.getState().askOpen).toBe(true);
  expect(mocks.back).toHaveBeenCalledTimes(backs);
  expect(mocks.replace).not.toHaveBeenCalled();
});

test('SSE resolvido antes do ACK ainda mostra fallback da própria resposta', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  await open();
  await click('Primeira');
  await click(m.lista_enviar());
  await act(async () => chatStore('srv', 'sess').use.setState({ askPayload: null, askOpen: false }));
  expect(mocks.back).not.toHaveBeenCalled();
  await act(async () => finish(new Response('{"ok":true,"fallback":true}')));
  expect(mocks.dismissTo).toHaveBeenCalledWith(expect.stringMatching(/^\/s\/srv\/sess\?askFallback=\d+$/));
  expect(mocks.replace).not.toHaveBeenCalled();
});

test('reemissão sem ID preserva a revisão e a trava da resposta em voo', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  await open({ questions: payload.questions });
  await click('Primeira');
  await click(m.lista_enviar());
  await act(async () => chatStore('srv', 'sess').openAsk({ questions: payload.questions }));
  expect(container.textContent).toContain(m.askq_revisar());
  await click(m.askq_enviando());
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => finish(new Response('{"ok":true}')));
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(false);
});

test('erro atual fora do Codex mantém o espelho como saída com aviso', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"indisponível"}', { status: 503 })));
  await open({ questions: payload.questions });
  await click('Primeira');
  await click(m.lista_enviar());
  expect(mocks.replace).toHaveBeenCalledWith(`/s/srv/sess/terminal?aviso=${encodeURIComponent('503: indisponível')}`);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('resolução externa depois de erro fecha a folha sem conservar o aviso velho', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"indisponível"}', { status: 503 })));
  await open();
  await click('Primeira');
  await click(m.lista_enviar());
  expect(container.textContent).toContain('indisponível');
  await act(async () => chatStore('srv', 'sess').use.setState({ askPayload: null, askOpen: false }));
  expect(container.textContent).not.toContain('indisponível');
  expect(mocks.back).toHaveBeenCalled();
});

test('geração muda mesmo com payload reutilizado e transições agrupadas pelo React', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const request = { questions: payload.questions };
  await open(request);
  await click('Primeira');
  await click(m.lista_enviar());
  await act(async () => {
    const chat = chatStore('srv', 'sess');
    chat.markAskDismissed();
    chat.openAsk(request);
  });
  await act(async () => finish(new Response('{"ok":true}')));
  expect(chatStore('srv', 'sess').use.getState().askPayload).toBe(request);
  expect(chatStore('srv', 'sess').use.getState().askOpen).toBe(true);
  expect(container.textContent).not.toContain(m.askq_revisar());
});

test('volta da revisão para a pergunta em vez de obrigar o cancelar', async () => {
  // Escolha única avança sozinha ao tocar: um toque errado precisa de volta, não de recomeço.
  await open({ provider: 'codex', request_id: 43, questions: [{
    id: 'choice', header: 'Escolha', question: 'Qual?', multiSelect: false,
    options: [{ label: 'Primeira', description: '' }, { label: 'Segunda', description: '' }],
  }] });
  await click('Segunda');
  expect(container.textContent).toContain(m.askq_revisar());
  await click(`‹ ${m.comum_voltar()}`);
  expect(container.textContent).not.toContain(m.askq_revisar());
  await click('Primeira');
  await click(m.lista_enviar());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
    request_id: 43, answers: [{ question_id: 'choice', indices: [0] }],
  });
});

test('troca a pergunta aberta pelo ID novo e protege texto secreto na entrada e revisão', async () => {
  await open();
  await click('Primeira');
  await act(async () => chatStore('srv', 'sess').openAsk({
    provider: 'codex', request_id: 42,
    questions: [{ id: 'secret', header: 'Segredo', question: 'Qual segredo?', multiSelect: false,
      isSecret: true, options: [] }],
  }));
  const input = container.querySelector('input')!;
  expect(input.type).toBe('password');
  await act(async () => {
    input.value = 'valor-secreto';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(m.comum_confirmar());
  expect(container.textContent).toContain('••••••');
  expect(container.textContent).not.toContain('valor-secreto');
  await click(m.lista_enviar());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
    request_id: 42, answers: [{ question_id: 'secret', value: 'valor-secreto' }],
  });
});
