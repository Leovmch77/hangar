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

const api = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getConfigForServer: api.config,
}));
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
vi.mock('../../stores/servers', () => ({ useServers: Object.assign(
  (select: (s: { servers: typeof target[] }) => unknown) => select({ servers: [target] }),
  { getState: () => ({ servers: [target] }) },
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
  updates.setState({ draftUpdate: 0 });
  send.mockResolvedValue(undefined);
  api.config.mockResolvedValue(config([shortcut()]));
});
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('ActionsGrid', () => {
  it('send_direct ausente envia o texto para a sessão', async () => {
    const container = await render();
    await act(async () => button(container).click());
    expect(send).toHaveBeenCalledExactlyOnceWith('/finalizar-pm');
    expect(api.config).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('send_direct false preenche o rascunho e avisa o Composer sem enviar', async () => {
    api.config.mockResolvedValue(config([shortcut({ send_direct: false })]));
    const attachment = { uri: 'file:///image.png', name: 'image.png', mime: 'image/png', kind: 'image' as const };
    writeDraft('srv', 'sess', { version: 1, text: 'antes', revision: 4, transcript: '/t/sess.jsonl', attachments: [attachment], submission: null });
    const container = await render();
    await act(async () => button(container).click());
    expect(readDraft('srv', 'sess')).toMatchObject({
      text: '/finalizar-pm', revision: 5, transcript: '/t/sess.jsonl', attachments: [attachment], submission: null,
    });
    expect(updates.getState().draftUpdate).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('confirm true só envia depois do OK', async () => {
    const alert = vi.spyOn(Alert, 'alert');
    api.config.mockResolvedValue(config([shortcut({ confirm: true })]));
    const container = await render();
    await act(async () => button(container).click());
    expect(alert).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2]!;
    const cancel = buttons.find((item) => item.style === 'cancel');
    expect(cancel).toBeDefined();
    await act(async () => buttons.find((item) => item.style !== 'cancel')!.onPress!());
    expect(send).toHaveBeenCalledExactlyOnceWith('/finalizar-pm');
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
    send.mockRejectedValueOnce(new Error('Envio recusado'));
    const container = await render();
    await act(async () => button(container).click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Envio recusado');
    await act(async () => button(container).click());
    expect(send).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(api.config).toHaveBeenCalledOnce();
  });

  it.each([true, false])('credencial não preenchida bloqueia o atalho (send_direct=%s)', async (direct) => {
    api.config.mockResolvedValue(config([shortcut({ text: 'usar ⟦SEGREDO:TOKEN⟧', send_direct: direct })]));
    const container = await render();
    await act(async () => button(container).click());
    expect(send).not.toHaveBeenCalled();
    expect(readDraft('srv', 'sess')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(m.atalhos_segredo_falta({ nome: 'TOKEN' }));
  });
});
