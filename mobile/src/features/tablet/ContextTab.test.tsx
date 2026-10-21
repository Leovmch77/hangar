// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggSession, Server, StateEvent } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { ContextTab } from './ContextTab';
import { ContextPanel } from './ContextPanel';

const state = vi.hoisted(() => ({ statusLine: null as string | null, stateEvent: null as StateEvent | null, rows: [] as AggSession[] }));
const servers = vi.hoisted(() => ({ ready: true, servers: [
  { id: 'srv', label: 'Casa', baseUrl: 'https://casa.test', token: 'test' },
] as Server[] }));
vi.mock('../../stores/servers', () => ({
  useServers: (select: (s: typeof servers) => unknown) => select(servers),
}));
vi.mock('../../ui/Glass', () => ({ Glass: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../files/FilesPanel', () => ({ FilesPanel: ({ name }: { name: string }) => createElement('div', null, `files-${name}`) }));
vi.mock('../activity/ActivityPanel', () => ({ ActivityPanel: ({ name }: { name: string }) => createElement('div', null, `background-${name}`) }));
vi.mock('../git/GitPanel', () => ({ GitPanel: ({ server, name }: { server: Server; name: string }) => createElement('div', null, `git-${server.id}-${name}`) }));
vi.mock('../../stores/chat', () => ({ chatStore: () => ({
  use: (select: (s: typeof state) => unknown) => select(state),
}) }));
vi.mock('../../stores/sessions', () => ({
  useSessions: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock('./ActionsGrid', () => ({ ActionsGrid: ({ serverId, name }: { serverId: string; name: string }) =>
  createElement('button', null, `action-${serverId}-${name}`),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  state.statusLine = null;
  state.stateEvent = null;
  state.rows = [];
  servers.ready = true;
  servers.servers = [{ id: 'srv', label: 'Casa', baseUrl: 'https://casa.test', token: 'test' }];
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
const render = () => act(() => root.render(createElement(ContextTab, { serverId: 'srv', name: 'sess' })));

const renderPanel = (name = 'sess', serverId = 'srv') => act(() => root.render(createElement(ContextPanel, { serverId, name })));
const selectTab = (label: string) => {
  const tab = container.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${label}"]`);
  expect(tab).not.toBeNull();
  act(() => tab!.click());
};

describe('ContextPanel', () => {
  it('monta só a aba ativa e deixa as outras abas acessíveis', () => {
    renderPanel();
    expect(container.textContent).toContain('action-srv-sess');
    expect(container.textContent).not.toContain('files-sess');
    selectTab(m.tablet_tab_files());
    expect(container.textContent).toContain('files-sess');
    expect(container.textContent).not.toContain('action-srv-sess');
    selectTab(m.tablet_tab_background());
    expect(container.textContent).toContain('background-sess');
    expect(container.textContent).not.toContain('files-sess');
    selectTab(m.tablet_tab_git());
    expect(container.textContent).toContain('git-srv-sess');
    expect(container.textContent).not.toContain('background-sess');
  });

  it('volta a Contexto ao trocar o nome da sessão ou o servidor', () => {
    renderPanel();
    selectTab(m.tablet_tab_files());
    renderPanel('outra');
    expect(container.textContent).toContain('action-srv-outra');
    expect(container.textContent).not.toContain('files-outra');
    selectTab(m.tablet_tab_background());
    renderPanel('outra', 'outro');
    expect(container.textContent).toContain('action-outro-outra');
  });

  it('espera os servidores carregarem e mostra erro claro quando o servidor sumiu', () => {
    servers.servers = [];
    servers.ready = false;
    renderPanel();
    selectTab(m.tablet_tab_git());
    expect(container.textContent).toContain('loading');
    servers.ready = true;
    renderPanel();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(m.chat_servidor_removido());
    expect(container.textContent).not.toContain('git-srv-sess');
    selectTab(m.tablet_tab_context());
    expect(container.textContent).toContain('loading');
  });
});
describe('ContextTab', () => {
  it('mostra o contexto, custo, cotas, repositório e branch da statusline', () => {
    state.statusLine = '💬 ctx 940k/1M │ 💵 $12.34 │ ⚡5h:23% ↺1h55m │ 📅7d:74% │ 📁 hangar [tab/t7]';
    render();
    expect(container.textContent).toContain('94%');
    expect(container.textContent).toContain('tab/t7');
    expect(container.textContent).toContain('hangar');
    expect(container.textContent).toContain('$12.34');
    expect(container.textContent).toContain('23%');
    expect(container.textContent).toContain('74%');
    expect(container.textContent).toContain(m.uso_reset({ quando: '1h55m' }));
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector(`[aria-label="${m.tablet_actions()}"]`)).toBeNull();
  });

  it('antes do primeiro estado mostra carregamento e conserva as ações', () => {
    render();
    expect(container.textContent).toContain('loading');
    expect(container.textContent).not.toContain(m.tablet_context_empty());
    expect(container.textContent).toContain('action-srv-sess');
  });

  it('ao receber estado sem statusline mostra o vazio e conserva as ações', () => {
    render();
    expect(container.textContent).toContain('loading');
    state.stateEvent = { session: 'sess', state: 'idle' };
    render();
    expect(container.textContent).toContain(m.tablet_context_empty());
    expect(container.textContent).not.toContain('loading');
    expect(container.textContent).toContain(m.tablet_actions());
    expect(container.textContent).toContain('action-srv-sess');
  });

  it.each(['', '💵 $0.00'])('com statusline %j sem contexto mostra o vazio e conserva as ações', (statusLine) => {
    state.statusLine = statusLine;
    state.stateEvent = { session: 'sess', state: 'idle', status_line: statusLine };
    render();
    expect(container.textContent).toContain(m.tablet_context_empty());
    expect(container.textContent).toContain(m.tablet_actions());
    expect(container.textContent).toContain('action-srv-sess');
  });
});
