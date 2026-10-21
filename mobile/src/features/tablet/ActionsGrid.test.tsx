// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { Alert } from 'react-native';
import type { Shortcut } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { ActionsGrid } from './ActionsGrid';
import { readDraft, writeDraft } from '../../stores/drafts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ config: vi.fn(), project: vi.fn(), send: vi.fn() }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getConfigForServer: api.config,
  getProjectShortcuts: api.project,
  sendInputForServer: api.send,
}));
const feedback = vi.hoisted(() => ({ ok: vi.fn(), erro: vi.fn(), success: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ toast: { ok: feedback.ok, erro: feedback.erro } }));
vi.mock('../../ui/haptics', () => ({ haptic: { success: feedback.success } }));
const memory = vi.hoisted(() => new Map<string, string>());
vi.mock('../../stores/prefs', () => ({ prefs: {
  getString: (key: string) => memory.get(key),
  set: (key: string, value: string) => { memory.set(key, value); },
  remove: (key: string) => { memory.delete(key); },
} }));
const send = vi.hoisted(() => vi.fn());
const updates = createStore(() => ({ draftUpdate: 0 }));
vi.mock('../../stores/chat', () => ({ chatStore: () => ({ send, use: updates }) }));
const target = vi.hoisted(() => ({ id: 'srv', label: 'Casa', baseUrl: 'http://casa', token: 'test' }));
const other = vi.hoisted(() => ({ id: 'other', label: 'Ativo', baseUrl: 'http://ativo', token: 'other-test' }));
const directory = vi.hoisted(() => ({ servers: [] as import('@hangar/core').Server[] }));
vi.mock('../../stores/servers', () => ({ useServers: Object.assign(
  (select: (s: { servers: typeof target[]; activeId: string }) => unknown) => select({ servers: directory.servers, activeId: other.id }),
  { getState: () => ({ servers: directory.servers, activeId: other.id }) },
) }));
const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));

const shortcut = (patch: Partial<Extract<Shortcut, { type: 'send_text' }>> = {}): Shortcut => ({
  id: 'finalizar', type: 'send_text', label: 'Finalizar PM', text: '/finalizar-pm', ...patch,
});
const config = (list: Shortcut[]) => ({ campos: { shortcuts: { valor: JSON.stringify(list) } }, somente_leitura: {} });
const mounted: { root: Root; container: HTMLDivElement }[] = [];
async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(createElement(ActionsGrid, { serverId: 'srv', name: 'sess' })));
  return container;
}
const button = (container: HTMLElement, label = 'Finalizar PM') => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(found, `botão ${label}`).not.toBeNull();
  return found!;
};

beforeEach(() => {
  vi.clearAllMocks();
  memory.clear();
  directory.servers = [other, target];
  updates.setState({ draftUpdate: 0 });
  send.mockResolvedValue(undefined);
  api.send.mockResolvedValue(undefined);
  api.config.mockResolvedValue(config([shortcut()]));
  api.project.mockResolvedValue({ key: '/repo', name: 'repo', root: '/repo', items: [] });
});
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('ActionsGrid', () => {
  it.each([false, true])('envio direto preserva o rascunho com áudio e anexos (envio pendente=%s)', async (pending) => {
    writeDraft('srv', 'sess', {
      version: 1, text: 'rascunho com ditado', revision: 7, transcript: '/t/sess.jsonl',
      attachments: [{ uri: 'file:///image.png', name: 'image.png', mime: 'image/png', kind: 'image' }],
      recordings: [{ id: 'voice-1', serverPath: '/up/sess/voice.m4a' }],
      submission: pending ? { text: 'outra mensagem', draftRevision: 6, status: 'sending' } : null,
    });
    const before = memory.get('draft.v1:srv::sess');
    const container = await render();
    await act(async () => button(container).click());
    expect(api.send).toHaveBeenCalledExactlyOnceWith(target, 'sess', '/finalizar-pm');
    expect(send).not.toHaveBeenCalled();
    expect(memory.get('draft.v1:srv::sess')).toBe(before);
    expect(updates.getState().draftUpdate).toBe(0);
    expect(feedback.success).toHaveBeenCalledOnce();
    expect(feedback.erro).not.toHaveBeenCalled();
  });

  it('send_direct ausente envia o texto para a sessão', async () => {
    const container = await render();
    await act(async () => button(container).click());
    expect(api.send).toHaveBeenCalledExactlyOnceWith(target, 'sess', '/finalizar-pm');
    expect(send).not.toHaveBeenCalled();
    expect(api.config).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('send_direct false confirma antes de substituir um rascunho diferente', async () => {
    const alert = vi.spyOn(Alert, 'alert');
    api.config.mockResolvedValue(config([shortcut({ send_direct: false })]));
    const attachment = { uri: 'file:///image.png', name: 'image.png', mime: 'image/png', kind: 'image' as const };
    writeDraft('srv', 'sess', { version: 1, text: 'antes', revision: 4, transcript: '/t/sess.jsonl', attachments: [attachment], submission: null });
    const before = memory.get('draft.v1:srv::sess');
    const container = await render();
    await act(async () => button(container).click());
    expect(alert).toHaveBeenCalledWith(m.composer_trocar_rascunho({ cmd: '/finalizar-pm' }), undefined, expect.any(Array));
    expect(memory.get('draft.v1:srv::sess')).toBe(before);
    expect(updates.getState().draftUpdate).toBe(0);
    await act(async () => alert.mock.calls[0][2]!.find((item) => item.style === 'cancel')!.onPress?.());
    expect(memory.get('draft.v1:srv::sess')).toBe(before);
    await act(async () => button(container).click());
    await act(async () => alert.mock.calls[1][2]!.find((item) => item.style !== 'cancel')!.onPress!());
    expect(readDraft('srv', 'sess')).toMatchObject({
      text: '/finalizar-pm', revision: 5, transcript: '/t/sess.jsonl', attachments: [attachment], submission: null,
    });
    expect(updates.getState().draftUpdate).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '/finalizar-pm'])('send_direct false preenche sem confirmar texto vazio ou igual (%j)', async (text) => {
    const alert = vi.spyOn(Alert, 'alert');
    api.config.mockResolvedValue(config([shortcut({ send_direct: false })]));
    writeDraft('srv', 'sess', { version: 1, text, revision: 4, transcript: null, attachments: [], submission: null });
    const container = await render();
    await act(async () => button(container).click());
    expect(alert).not.toHaveBeenCalled();
    expect(readDraft('srv', 'sess')?.text).toBe('/finalizar-pm');
    expect(updates.getState().draftUpdate).toBe(1);
    expect(api.send).not.toHaveBeenCalled();
  });

  it('confirm true só envia depois do OK', async () => {
    const alert = vi.spyOn(Alert, 'alert');
    api.config.mockResolvedValue(config([shortcut({ confirm: true })]));
    const container = await render();
    await act(async () => button(container).click());
    expect(alert).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2]!;
    const cancel = buttons.find((item) => item.style === 'cancel');
    expect(cancel).toBeDefined();
    await act(async () => buttons.find((item) => item.style !== 'cancel')!.onPress!());
    expect(api.send).toHaveBeenCalledExactlyOnceWith(target, 'sess', '/finalizar-pm');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([false, true])('toque duplo só envia uma vez e libera após terminar (falha=%s)', async (fails) => {
    let finish!: () => void;
    api.send.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = () => fails ? reject(new Error('Envio recusado')) : resolve();
    }));
    const container = await render();
    const action = button(container);
    await act(async () => { action.click(); action.click(); });
    expect(api.send).toHaveBeenCalledExactlyOnceWith(target, 'sess', '/finalizar-pm');
    expect(action.disabled).toBe(true);
    await act(async () => finish());
    expect(action.disabled).toBe(false);
    await act(async () => action.click());
    expect(api.send).toHaveBeenCalledTimes(2);
  });

  it.each(['cancel', 'dismiss'])('toque duplo abre uma só confirmação e libera ao sair (%s)', async (exit) => {
    const alert = vi.spyOn(Alert, 'alert');
    api.config.mockResolvedValue(config([shortcut({ confirm: true })]));
    let finish!: () => void;
    api.send.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const container = await render();
    await act(async () => { button(container).click(); button(container).click(); });
    expect(alert).toHaveBeenCalledOnce();
    expect(api.send).not.toHaveBeenCalled();
    await act(async () => {
      if (exit === 'cancel') alert.mock.calls[0][2]!.find((item) => item.style === 'cancel')!.onPress!();
      else alert.mock.calls[0][3]!.onDismiss!();
    });
    await act(async () => button(container).click());
    expect(alert).toHaveBeenCalledTimes(2);
    await act(async () => alert.mock.calls[1][2]!.find((item) => item.style !== 'cancel')!.onPress!());
    expect(api.send).toHaveBeenCalledOnce();
    expect(button(container).disabled).toBe(true);
    await act(async () => finish());
    expect(button(container).disabled).toBe(false);
  });

  it.each([
    ['terminal', m.native_shortcuts_native_terminal, '/s/srv/sess/terminal'],
    ['anexos', m.native_shortcuts_native_anexos, '/s/srv/sess/attachments'],
  ] as const)('internal %s abre a tela da sessão', async (action, label, path) => {
    api.config.mockResolvedValue(config([{ id: action, type: 'internal', action }]));
    const container = await render();
    await act(async () => button(container, label()).click());
    expect(push).toHaveBeenCalledExactlyOnceWith(path);
    expect(send).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('mostra carregamento, erro de config e permite tentar novamente', async () => {
    let reject!: (error: Error) => void;
    api.config.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const container = await render();
    expect(container.textContent).toContain('loading');
    await act(async () => reject(new Error('Servidor indisponível')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Servidor indisponível');
    await act(async () => button(container, m.native_retry()).click());
    expect(button(container)).toBeDefined();
    expect(api.config).toHaveBeenCalledTimes(2);
  });

  it('trocar o objeto do servidor não relê config nem esconde os atalhos', async () => {
    const container = await render();
    directory.servers = [other, { ...target, label: 'Casa renomeada' }];
    await act(async () => mounted.at(-1)!.root.render(createElement(ActionsGrid, { serverId: 'srv', name: 'sess' })));
    expect(api.config).toHaveBeenCalledOnce();
    expect(button(container)).toBeDefined();
  });

  it('junta globais e projeto da sessão, filtra shell e distingue IDs iguais', async () => {
    api.project.mockResolvedValue({ key: '/repo', name: 'repo', root: '/repo', items: [
      shortcut({ label: 'Do projeto', text: '/projeto' }),
      { id: 'shell', type: 'shell', label: 'Shell', command: 'pwd' },
    ] });
    let finish!: () => void;
    api.send.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const container = await render();
    expect(api.project).toHaveBeenCalledExactlyOnceWith('sess', target);
    expect([...container.querySelectorAll('button')].map((item) => item.getAttribute('aria-label'))).toEqual(['Finalizar PM', 'Do projeto']);
    await act(async () => button(container).click());
    expect(button(container).disabled).toBe(true);
    expect(button(container, 'Do projeto').disabled).toBe(false);
    await act(async () => button(container, 'Do projeto').click());
    expect(api.send).toHaveBeenNthCalledWith(2, target, 'sess', '/projeto');
    await act(async () => finish());
  });

  it('mantém globais durante carregamento e erro do projeto, com repetição independente', async () => {
    let reject!: (error: Error) => void;
    api.project.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const container = await render();
    expect(button(container)).toBeDefined();
    expect(container.textContent).toContain('loading');
    await act(async () => reject(new Error('Projeto indisponível')));
    expect(button(container)).toBeDefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Projeto indisponível');
    api.project.mockResolvedValue({ key: '/repo', name: 'repo', root: '/repo', items: [shortcut({ label: 'Do projeto' })] });
    await act(async () => button(container, m.native_retry()).click());
    expect(button(container, 'Do projeto')).toBeDefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(api.project).toHaveBeenCalledTimes(2);
    expect(api.config).toHaveBeenCalledOnce();
  });

  it('trocar sessão relê só o projeto e descarta a resposta anterior atrasada', async () => {
    let finish!: (project: unknown) => void;
    api.project.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const container = await render();
    api.project.mockResolvedValue({ key: '/new', name: 'new', root: '/new', items: [shortcut({ label: 'Atual' })] });
    await act(async () => mounted.at(-1)!.root.render(createElement(ActionsGrid, { serverId: 'srv', name: 'new' })));
    await act(async () => finish({ key: '/old', name: 'old', root: '/old', items: [shortcut({ label: 'Antigo' })] }));
    expect(api.project).toHaveBeenLastCalledWith('new', target);
    expect(button(container, 'Atual')).toBeDefined();
    expect(container.textContent).not.toContain('Antigo');
    expect(api.config).toHaveBeenCalledOnce();
  });

  it.each<{ items: Shortcut[] }>([
    { items: [] },
    { items: [{ id: 'shell', type: 'shell', label: 'Shell', command: 'pwd' }] },
  ])(
    'não monta a grade quando nenhum atalho é permitido ($items)', async ({ items }) => {
      api.config.mockResolvedValue(config(items));
      expect((await render()).innerHTML).toBe('');
    },
  );

  it('config ilegível monta somente terminal e anexos', async () => {
    api.config.mockResolvedValue({ campos: { shortcuts: { valor: '{quebrado' } }, somente_leitura: {} });
    const container = await render();
    expect([...container.querySelectorAll('button')].map((item) => item.getAttribute('aria-label'))).toEqual([
      m.native_shortcuts_native_terminal(), m.native_shortcuts_native_anexos(),
    ]);
  });

  it('falha no envio aparece e mantém a grade para outra tentativa', async () => {
    api.send.mockRejectedValueOnce(new Error('Envio recusado'));
    writeDraft('srv', 'sess', { version: 1, text: 'antes', revision: 4, transcript: '/t/sess.jsonl',
      attachments: [], recordings: [{ id: 'voice-1', serverPath: '/up/sess/voice.m4a' }], submission: null });
    const before = memory.get('draft.v1:srv::sess');
    const container = await render();
    await act(async () => button(container).click());
    expect(feedback.erro).toHaveBeenCalledExactlyOnceWith('Envio recusado');
    expect(feedback.success).not.toHaveBeenCalled();
    expect(memory.get('draft.v1:srv::sess')).toBe(before);
    await act(async () => button(container).click());
    expect(api.send).toHaveBeenCalledTimes(2);
    expect(feedback.success).toHaveBeenCalledOnce();
    expect(memory.get('draft.v1:srv::sess')).toBe(before);
    expect(send).not.toHaveBeenCalled();
    expect(api.config).toHaveBeenCalledOnce();
  });

  it.each([true, false])('credencial não preenchida bloqueia o atalho (send_direct=%s)', async (direct) => {
    const alert = vi.spyOn(Alert, 'alert');
    api.config.mockResolvedValue(config([shortcut({ text: 'usar ⟦SEGREDO:TOKEN⟧', send_direct: direct, confirm: true })]));
    const container = await render();
    await act(async () => button(container).click());
    expect(alert).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(readDraft('srv', 'sess')).toBeNull();
    expect(feedback.erro).toHaveBeenCalledExactlyOnceWith(m.atalhos_segredo_falta({ nome: 'TOKEN' }));
  });
});
