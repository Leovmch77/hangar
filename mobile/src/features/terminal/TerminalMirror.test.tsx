// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  getPane: vi.fn(),
  server: { id: 'srv1', label: 'fixture-server', baseUrl: 'https://fixture.test', token: 'token' },
  appState: 'active' as 'active' | 'background',
  listeners: new Set<(state: 'active' | 'background') => void>(),
  remove: vi.fn(),
}));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), getPane: calls.getPane }));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  AppState: {
    get currentState() { return calls.appState; },
    addEventListener: (_event: string, listener: (state: 'active' | 'background') => void) => {
      calls.listeners.add(listener);
      return { remove: () => { calls.listeners.delete(listener); calls.remove(); } };
    },
  },
}));
vi.mock('../../stores/servers', () => ({
  useServers: (select: (state: { servers: typeof calls.server[] }) => unknown) => select({ servers: [calls.server] }),
}));
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: ({ data, renderItem }: { data: string[]; renderItem: (props: { item: string }) => React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'terminal-lines' }, data.map((item, index) =>
      React.createElement(React.Fragment, { key: index }, renderItem({ item })))),
}));
vi.mock('../../paraglide/messages', () => ({
  term_carregar_mais: ({ n }: { n: number }) => `load-more-${n}`,
  ...Object.fromEntries((
    'term_erro term_erro_enviar term_digitar term_texto_para term_enviar_sem_enter term_enviar_com_enter ' +
    'term_envia term_teclas_resgate term_resgate term_seta_cima term_seta_baixo'
  ).split(' ').map((key) => [key, () => key])),
}));

import { TerminalMirror } from './TerminalMirror';

beforeEach(() => {
  vi.useFakeTimers();
  calls.appState = 'active';
  calls.listeners.clear();
  calls.remove.mockClear();
  calls.getPane.mockReset().mockImplementation(async (_name: string, lines: number) => ({ text: `pane-${lines}`, scrollback: 2000 }));
});
afterEach(() => vi.useRealTimers());

describe('TerminalMirror', () => {
  it('monta em segundo plano sem HTTP, pausa com AppState e remove a assinatura ao desmontar', async () => {
    calls.appState = 'background';
    const container = document.createElement('div');
    const root = createRoot(container);
    let listener!: (state: 'active' | 'background') => void;
    try {
      await act(async () => {
        root.render(React.createElement(TerminalMirror, { name: 'fixture', serverId: 'srv1' }));
      });
      expect(calls.listeners.size).toBe(1);
      listener = [...calls.listeners][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
      expect(calls.getPane).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => { listener('active'); });
      expect(calls.getPane).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="terminal-lines"]')!.textContent).toBe('pane-200');
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => { listener('background'); });
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
      expect(calls.getPane).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
    expect(calls.remove).toHaveBeenCalledTimes(1);
    expect(calls.listeners.size).toBe(0);
    listener('active');
    expect(calls.getPane).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('carregar mais publica 600 e depois 1200 linhas usando o poller real, sem leitura extra de 200', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(TerminalMirror, { name: 'fixture', serverId: 'srv1' }));
      });
      expect(calls.getPane.mock.calls.map((call) => call[1])).toEqual([200]);
      expect(container.querySelector('[data-testid="terminal-lines"]')!.textContent).toBe('pane-200');

      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="load-more-200"]')!.click();
      });

      expect(calls.getPane.mock.calls).toEqual([
        ['fixture', 200, calls.server],
        ['fixture', 600, calls.server],
      ]);
      expect(container.querySelector('[data-testid="terminal-lines"]')!.textContent).toBe('pane-600');
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="load-more-600"]')!.click();
      });

      expect(calls.getPane.mock.calls.map((call) => call[1])).toEqual([200, 600, 1200]);
      expect(container.querySelector('[data-testid="terminal-lines"]')!.textContent).toBe('pane-1200');
      expect(container.querySelector('button[aria-label^="load-more-"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('leitura automática antiga não altera conteúdo ampliado nem erro (rejeição: %s)', async (lateError) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(TerminalMirror, { name: 'fixture', serverId: 'srv1' }));
      });
      for (const [previous, next] of [[200, 600], [600, 1200]]) {
        let resolve!: (value: { text: string; scrollback: number }) => void;
        let reject!: (error: Error) => void;
        calls.getPane.mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail; }));
        await act(async () => { await vi.advanceTimersByTimeAsync(450); });
        expect(calls.getPane).toHaveBeenLastCalledWith('fixture', previous, calls.server);

        await act(async () => {
          container.querySelector<HTMLButtonElement>(`button[aria-label="load-more-${previous}"]`)!.click();
        });
        expect(container.querySelector('[data-testid="terminal-lines"]')!.textContent).toBe(`pane-${next}`);
        await act(async () => {
          if (lateError) reject(new Error(`late-error-${previous}`));
          else resolve({ text: `late-${previous}`, scrollback: 1 });
        });

        expect(container.querySelector('[data-testid="terminal-lines"]')!.textContent).toBe(`pane-${next}`);
        expect(container.querySelector('[role="alert"]')).toBeNull();
      }
      expect(calls.getPane.mock.calls.map((call) => call[1])).toEqual([200, 200, 600, 600, 1200]);
    } finally {
      await act(async () => root.unmount());
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
