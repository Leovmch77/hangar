// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggSession, SessionInfo } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  alert: vi.fn(),
  deleteSession: vi.fn(),
  error: vi.fn(),
  ok: vi.fn(),
  listeners: new Map<string, (event: { data: string }) => void>(),
  stream: { addEventListener: vi.fn(), close: vi.fn(), onerror: null },
  sessions: [{ name: 'fixture', state: 'idle', jsonl: '/tmp/fixture.jsonl' }] as SessionInfo[],
}));

vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  deleteSession: calls.deleteSession,
  rotaDecidida: () => true,
  probeServerResponse: async () => ({ ok: true, status: 200, json: async () => calls.sessions }),
  openSessionsStream: () => calls.stream,
}));
vi.mock('../../stores/servers', async () => {
  const { create } = await import('zustand');
  return {
    ownServers: (servers: unknown[]) => servers,
    useServers: create(() => ({ servers: [], ready: true, activeId: 'srv1', ensureActive: vi.fn(() => true) })),
  };
});
vi.mock('../../stores/aparencia', () => ({
  useAparencia: (select: (state: { agrupar: string; organizar: string }) => unknown) => select({ agrupar: 'project', organizar: 'sessions' }),
  ehGroupBy: () => false,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@react-native-menu/menu', () => ({ MenuView: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../ui/HangarMark', () => ({ HangarMark: () => null }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: calls.error, ok: calls.ok } }));
vi.mock('./SessionRow', () => ({
  SessionRow: ({ session, onExcluir }: { session: AggSession; onExcluir: (session: AggSession) => void }) =>
    React.createElement('button', { 'data-row': `${session.serverId}::${session.name}`, onClick: () => onExcluir(session) }, session.name),
}));
vi.mock('../pair/PairInviteSheet', () => ({ PairInviteSheet: () => null }));
vi.mock('../pair/PairAcceptSheet', () => ({ PairAcceptSheet: () => null }));
vi.mock('../pair/leaveExternal', () => ({ leaveExternal: vi.fn() }));
vi.mock('./ConversationList', () => ({ ConversationList: () => null }));
vi.mock('./RenameSheet', () => ({ RenameSheet: () => null }));
vi.mock('../worktrees/WorktreeSheet', () => ({ WorktreeSheet: () => null }));
vi.mock('../../paraglide/messages', () => Object.fromEntries((
  'lista_agrupar_nenhum lista_agrupar_servidor lista_agrupar_projeto lista_agrupar ' +
  'native_brand lista_buscar lista_filtrar lista_filtro_limpar native_connected config_modal_titulo ' +
  'native_new_chat_title native_sidebar_all_sessions lista_sessoes_plural sessao_expandir sessao_recolher ' +
  'lista_vazia_filtro lista_nenhuma_ativa comum_cancelar sessao_excluir sessao_excluir_curto servidor_nao_existe'
).split(' ').map((key) => [key, () => key]))));

interface Section { id: string; data: AggSession[] }
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Alert: { alert: calls.alert },
  RefreshControl: () => null,
  TextInput: ({ value, onChangeText, accessibilityLabel }: { value: string; onChangeText: (value: string) => void; accessibilityLabel: string }) =>
    React.createElement('input', { value, 'aria-label': accessibilityLabel, onInput: (event: React.FormEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value) }),
  SectionList: ({ sections, ListHeaderComponent, ListEmptyComponent, renderSectionHeader, renderItem }: {
    sections: Section[]; ListHeaderComponent: React.ReactNode; ListEmptyComponent: React.ReactNode;
    renderSectionHeader: (props: { section: Section }) => React.ReactNode;
    renderItem: (props: { item: AggSession; section: Section }) => React.ReactNode;
  }) => React.createElement('div', null, ListHeaderComponent, sections.length ? sections.map((section) =>
    React.createElement(React.Fragment, { key: section.id }, renderSectionHeader({ section }),
      section.data.map((item) => React.createElement(React.Fragment, { key: `${item.serverId}::${item.name}` }, renderItem({ item, section }))),
    )) : ListEmptyComponent),
}));

import { useServers } from '../../stores/servers';
import { useSessions, _resetSessionsForTests } from '../../stores/sessions';
import { SessionList } from './SessionList';

const server = { id: 'srv1', label: 'fixture-server', baseUrl: 'https://fixture.test', token: 'token' };
let root: Root;
let container: HTMLDivElement;

async function mount() {
  await act(async () => {
    root.render(React.createElement(SessionList, { onClose: vi.fn(), onOpenServers: vi.fn() }));
  });
}

function emit(sessions: SessionInfo[]) {
  calls.listeners.get('sessions')!({ data: JSON.stringify(sessions) });
}

function confirm(index = 0): () => void {
  return calls.alert.mock.calls[index][2].find((button: { style?: string }) => button.style === 'destructive').onPress;
}

beforeEach(() => {
  _resetSessionsForTests();
  vi.clearAllMocks();
  calls.listeners.clear();
  calls.stream.addEventListener.mockImplementation((event: string, listener: (event: { data: string }) => void) => calls.listeners.set(event, listener));
  useServers.setState({ servers: [server], ready: true, activeId: server.id });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  _resetSessionsForTests();
  container.remove();
});

describe('SessionList', () => {
  it.each([null, { unknown_warning: true }])('esconde antes do DELETE terminar, bloqueia confirmação duplicada e mantém marca após sucesso (%j)', async (warning) => {
    let resolve!: (value: { ok: boolean; warning: unknown | null }) => void;
    calls.deleteSession.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await mount();
    const row = container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!;
    expect(row).not.toBeNull();
    await act(async () => { row.click(); row.click(); });
    expect(calls.alert).toHaveBeenCalledTimes(2);
    const first = confirm();
    const duplicate = confirm(1);

    await act(async () => { first(); duplicate(); });

    expect(calls.deleteSession).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();
    expect(useSessions.getState().rows).toEqual([]);
    expect(calls.ok).not.toHaveBeenCalled();
    await act(async () => { emit(calls.sessions); });
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();

    await act(async () => { resolve({ ok: true, warning }); });
    if (warning) expect(calls.error).toHaveBeenCalled();
    else expect(calls.ok).toHaveBeenCalledWith('fixture');
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();
    await act(async () => { emit(calls.sessions); });
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();
    await act(async () => { emit([]); });
    await act(async () => { emit([{ ...calls.sessions[0], jsonl: '/tmp/recreated.jsonl' }]); });
    expect(container.querySelector('[data-row="srv1::fixture"]')).not.toBeNull();
  });

  it('falha do DELETE restaura a linha, mostra a causa e permite tentar de novo', async () => {
    let reject!: (error: Error) => void;
    calls.deleteSession.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await mount();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!.click(); });
    await act(async () => { confirm()(); });
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();

    await act(async () => { reject(new Error('delete-failed')); });

    expect(container.querySelector('[data-row="srv1::fixture"]')).not.toBeNull();
    expect(calls.error).toHaveBeenCalledWith('delete-failed');
    calls.deleteSession.mockResolvedValueOnce({ ok: true, warning: null });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!.click(); });
    await act(async () => { confirm(1)(); });
    expect(calls.deleteSession).toHaveBeenCalledTimes(2);
  });

  it('filtro sem resultados mostra o aviso existente', async () => {
    await mount();
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="lista_filtrar"]')!;
      input.value = 'not-found';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-row]')).toBeNull();
    expect(container.textContent).toContain('lista_vazia_filtro');
    expect(container.textContent).not.toContain('lista_nenhuma_ativa');
  });

  it('grupo recolhido não mostra aviso de lista vazia', async () => {
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label$="lista_sessoes_plural"]')!.click();
    });
    expect(container.querySelector('[data-row]')).toBeNull();
    expect(container.textContent).not.toContain('lista_vazia_filtro');
    expect(container.textContent).not.toContain('lista_nenhuma_ativa');
  });
});
