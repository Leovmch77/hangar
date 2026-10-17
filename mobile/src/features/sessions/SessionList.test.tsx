// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggSession, Server, SessionInfo } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  alert: vi.fn(),
  deleteSession: vi.fn(),
  error: vi.fn(),
  ok: vi.fn(),
  push: vi.fn(),
  organizar: 'sessions',
  realRow: false,
  listHeight: 4000,
  listContentSize: null as ((height: number) => void) | null,
  listLayout: null as ((height: number) => void) | null,
  scrollTo: vi.fn(),
  listeners: new Map<string, (event: { data: string }) => void>(),
  stream: { addEventListener: vi.fn(), close: vi.fn(), onerror: null },
  sessions: [{ name: 'fixture', state: 'idle', jsonl: '/tmp/fixture.jsonl' }] as SessionInfo[],
}));

vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  deleteSession: calls.deleteSession,
  rotaDecidida: () => true,
  probeServerResponse: async (server: Server) => ({ ok: true, status: 200,
    json: async () => server.invite ? calls.sessions.map((s) => ({ ...s, jsonl: '/tmp/guest.jsonl' })) : calls.sessions }),
  openSessionsStream: () => calls.stream,
  listExternalPairs: async () => [],
}));
vi.mock('../../stores/servers', async () => {
  const { create } = await import('zustand');
  return {
    ownServers: (servers: Server[]) => servers.filter((s) => !s.invite),
    useServers: create<{ servers: Server[]; ready: boolean; activeId: string; ensureActive: ReturnType<typeof vi.fn>; remove: (id: string) => void }>((set) => ({
      servers: [], ready: true, activeId: 'srv1', ensureActive: vi.fn(() => true),
      remove: (id) => set((s) => ({ servers: s.servers.filter((server) => server.id !== id) })),
    })),
  };
});
vi.mock('../../stores/aparencia', () => ({
  useAparencia: (select: (state: { agrupar: string; organizar: string }) => unknown) => select({ agrupar: 'project', organizar: calls.organizar }),
  ehGroupBy: () => false,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: calls.push }) }));
vi.mock('@react-native-menu/menu', () => ({
  MenuView: ({ children, actions, onPressAction }: { children: React.ReactNode; actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void }) =>
    React.createElement('div', null, children, ...(calls.realRow ? actions.map((action) =>
      React.createElement('button', { key: action.id, 'data-action': action.id,
        onClick: () => onPressAction({ nativeEvent: { event: action.id } }) }, action.title)) : [])),
}));
vi.mock('../../ui/HangarMark', () => ({ HangarMark: () => null }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: calls.error, ok: calls.ok } }));
vi.mock('./SessionRow', async (original) => {
  const actual = await original<typeof import('./SessionRow')>();
  return { SessionRow: (props: React.ComponentProps<typeof actual.SessionRow>) => {
    if (calls.realRow) return React.createElement(actual.SessionRow, props);
    const { session, onExcluir, onPress, compact } = props;
    return React.createElement('div', null,
      React.createElement('button', { 'data-row': `${session.serverId}::${session.name}`, 'data-compact': String(!!compact), onClick: () => onExcluir(session) }, session.name),
      React.createElement('button', { 'data-open': `${session.serverId}::${session.name}`, onClick: () => onPress(session) }));
  } };
});
vi.mock('../pair/PairInviteSheet', () => ({ PairInviteSheet: () => null }));
vi.mock('../voice/LiveVoiceChatButton', () => ({ LiveVoiceChatButton: () => null }));
vi.mock('../pair/PairAcceptSheet', () => ({ PairAcceptSheet: () => null }));
vi.mock('../pair/leaveExternal', () => ({ leaveExternal: vi.fn() }));
vi.mock('./ConversationList', () => ({ ConversationList: () => null }));
vi.mock('./RenameSheet', () => ({ RenameSheet: () => null }));
vi.mock('../worktrees/WorktreeSheet', () => ({ WorktreeSheet: () => null }));
vi.mock('../../paraglide/messages', () => ({ ...Object.fromEntries((
  'lista_agrupar_nenhum lista_agrupar_servidor lista_agrupar_projeto lista_agrupar ' +
  'native_brand lista_buscar lista_filtrar lista_filtro_limpar native_connected config_modal_titulo switcher_buscar_conversas nav_custos ' +
  'native_new_chat_title native_sidebar_all_sessions lista_sessoes_plural sessao_expandir sessao_recolher ' +
  'lista_carregando lista_vazia_filtro lista_nenhuma_ativa comum_cancelar sessao_excluir sessao_excluir_curto servidor_nao_existe ' +
  'comum_carregando lista_nenhum_servidor lista_pareie_qr native_sidebar_awaiting home_sessions_awaiting home_sessions_working home_sessions_ready sessao_recolher ' +
  'sessao_renomear sessao_git convite_parar orq_row_badge native_par_convidar native_par_menu'
).split(' ').map((key) => [key, () => key])),
  home_sessions_more_ready: ({ n }: { n: number }) => `home_sessions_more_ready:${n}`,
  lista_servidor_offline: ({ label }: { label: string }) => `${label}:offline`,
  pair_leave_outside: ({ dono }: { dono: string }) => `leave-${dono}`,
  pair_from_owner: ({ dono }: { dono: string }) => `from-${dono}`,
  pair_level_view: () => 'view-only',
}));

interface Section { id: string; data: AggSession[] }
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Alert: { alert: calls.alert },
  RefreshControl: () => null,
  TextInput: ({ value, onChangeText, accessibilityLabel }: { value: string; onChangeText: (value: string) => void; accessibilityLabel: string }) =>
    React.createElement('input', { value, 'aria-label': accessibilityLabel, onInput: (event: React.FormEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value) }),
  SectionList: ({ ref, sections, ListHeaderComponent, ListEmptyComponent, renderSectionHeader, renderSectionFooter, renderItem,
    contentOffset, onScroll, onScrollBeginDrag, onLayout, onContentSizeChange }: {
    ref?: React.Ref<{ getScrollResponder: () => { scrollTo: (offset: { x: number; y: number; animated: boolean }) => void } }>;
    sections: Section[]; ListHeaderComponent: React.ReactNode; ListEmptyComponent: React.ReactNode;
    contentOffset?: { x: number; y: number };
    onScroll?: (event: { nativeEvent: { contentOffset: { x: number; y: number } } }) => void;
    onScrollBeginDrag?: (event: { nativeEvent: { contentOffset: { x: number; y: number } } }) => void;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number; x: number; y: number } } }) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    renderSectionFooter?: (props: { section: Section }) => React.ReactNode;
    renderSectionHeader: (props: { section: Section }) => React.ReactNode;
    renderItem: (props: { item: AggSession; section: Section; index: number }) => React.ReactNode;
  }) => {
    const list = React.useRef<HTMLDivElement>(null);
    const viewport = React.useRef(300);
    const height = React.useRef(calls.listHeight);
    const scroll = (offset: { x: number; y: number }) => {
      if (!list.current) return;
      list.current.scrollLeft = offset.x;
      list.current.scrollTop = Math.max(0, Math.min(offset.y, height.current - viewport.current));
      onScroll?.({ nativeEvent: { contentOffset: { x: list.current.scrollLeft, y: list.current.scrollTop } } });
    };
    React.useImperativeHandle(ref, () => ({ getScrollResponder: () => ({ scrollTo: (offset: { x: number; y: number; animated: boolean }) => {
      calls.scrollTo(offset);
      scroll(offset);
    } }) }));
    calls.listContentSize = (value) => { height.current = value; onContentSizeChange?.(390, value); };
    calls.listLayout = (value) => {
      viewport.current = value;
      onLayout?.({ nativeEvent: { layout: { width: 390, height: value, x: 0, y: 0 } } });
    };
    React.useLayoutEffect(() => {
      scroll(contentOffset ?? { x: 0, y: 0 });
      calls.listLayout?.(viewport.current);
      calls.listContentSize?.(height.current);
    }, []);
    return React.createElement('div', { ref: list, 'data-native-list': true,
      onTouchStart: () => onScrollBeginDrag?.({ nativeEvent: { contentOffset: { x: list.current!.scrollLeft, y: list.current!.scrollTop } } }),
      onScroll: (event: React.UIEvent<HTMLDivElement>) => onScroll?.({ nativeEvent: {
        contentOffset: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop },
      } }),
    }, ListHeaderComponent, sections.length ? sections.map((section) =>
      React.createElement('div', { key: section.id, 'data-section': section.id }, renderSectionHeader({ section }),
        section.data.map((item, index) => React.createElement(React.Fragment, { key: `${item.serverId}::${item.name}` }, renderItem({ item, section, index }))),
        renderSectionFooter?.({ section }),
      )) : ListEmptyComponent);
  },
}));

import { useServers } from '../../stores/servers';
import { useSessions, _resetSessionsForTests } from '../../stores/sessions';
import { SessionList } from './SessionList';

const server = { id: 'srv1', label: 'fixture-server', baseUrl: 'https://fixture.test', token: 'token' };
let root: Root;
let container: HTMLDivElement;

async function mount(props: Partial<React.ComponentProps<typeof SessionList>> = {}) {
  await act(async () => {
    root.render(React.createElement(SessionList, { onClose: vi.fn(), onOpenServers: vi.fn(), ...props }));
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
  calls.deleteSession.mockReset();
  calls.organizar = 'sessions';
  calls.realRow = false;
  calls.listHeight = 4000;
  calls.listContentSize = null;
  calls.listLayout = null;
  calls.sessions = [{ name: 'fixture', state: 'idle', jsonl: '/tmp/fixture.jsonl' }];
  calls.listeners.clear();
  calls.stream.addEventListener.mockImplementation((event: string, listener: (event: { data: string }) => void) => calls.listeners.set(event, listener));
  useServers.setState({ servers: [server], ready: true, activeId: server.id });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'sessao_recolher')?.click();
    const list = container.querySelector<HTMLDivElement>('[data-native-list]');
    if (list) {
      list.dispatchEvent(new Event('touchstart', { bubbles: true }));
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
    }
  });
  await act(async () => root.unmount());
  _resetSessionsForTests();
  container.remove();
});

describe('SessionList', () => {
  it.each(['claude', 'orq'] as const)('git no menu real da linha %s abre a tela da conversa e fecha a lista', async (provider) => {
    calls.realRow = true;
    calls.sessions = [{ ...calls.sessions[0], cwd: '/repo', provider }];
    const onClose = vi.fn();
    await mount({ onClose });
    const git = container.querySelector<HTMLButtonElement>('[data-action="git"]');
    expect(git).not.toBeNull();
    await act(async () => git!.click());
    expect(calls.push).toHaveBeenCalledExactlyOnceWith('/s/srv1/fixture/git');
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });

  it('git não aparece no menu real de servidor de convite com cwd', async () => {
    calls.realRow = true;
    calls.sessions = [{ ...calls.sessions[0], cwd: '/repo', provider: 'claude' }];
    useServers.setState({ servers: [server, { ...server, id: 'guest', baseUrl: 'https://guest.test', invite: true }] });
    await mount();
    const stop = container.querySelector<HTMLButtonElement>('[data-action="stop-following"]');
    expect(stop).not.toBeNull();
    expect(stop!.parentElement!.querySelector('[data-action="git"]')).toBeNull();
    expect(stop!.parentElement!.querySelector('[data-action="rename"]')).not.toBeNull();
    await act(async () => stop!.click());
    expect(useServers.getState().servers.map((s) => s.id)).toEqual(['srv1']);
    expect(calls.deleteSession).not.toHaveBeenCalled();
    expect(calls.push).not.toHaveBeenCalled();
  });

  it.each(['home', 'conversations', 'sessions'])('acesso à busca global permanece visível em %s', async (mode) => {
    calls.organizar = mode === 'conversations' ? 'conversations' : 'sessions';
    await mount({ variant: mode === 'home' ? 'home' : 'drawer' });
    const search = container.querySelector<HTMLButtonElement>('[aria-label="switcher_buscar_conversas"]');
    expect(search, 'ação Buscar nas conversas').not.toBeNull();
    await act(async () => search!.click());
    expect(calls.push).toHaveBeenCalledExactlyOnceWith('/search');
  });

  it.each(['sessions', 'conversations'])('Custos fecha a gaveta e abre página inteira no modo %s', async (mode) => {
    calls.organizar = mode;
    const onClose = vi.fn();
    await mount({ onClose });
    const button = container.querySelector<HTMLButtonElement>('[aria-label="nav_custos"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls.push).toHaveBeenCalledWith('/costs');
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(calls.push.mock.invocationCallOrder[0]);
  });

  it('home faz agrupamento por servidor dentro dos estados e mantém prontas e pares globais', async () => {
    calls.realRow = true;
    await mount({ variant: 'home' });
    const row = useSessions.getState().rows[0];
    const session = (name: string, state: AggSession['state'], serverId: string, last_activity = 0): AggSession => ({
      ...row, name, state, serverId, serverLabel: serverId === 'srv1' ? 'machine-a' : 'machine-b', last_activity,
    });
    const rows = [
      session('waiting-a1', 'awaiting_input', 'srv1'), session('waiting-b', 'awaiting_input', 'srv2'),
      session('waiting-a2', 'awaiting_input', 'srv1'),
      session('working-b1', 'working', 'srv2'), session('working-a', 'working', 'srv1'),
      session('working-b2', 'working', 'srv2'),
      session('ready-a-old', 'idle', 'srv1', 100), session('ready-b-new', 'idle', 'srv2', 400),
      session('ready-a-new', 'idle', 'srv1', 300), session('ready-b-old', 'idle', 'srv2', 200),
      { ...session('outside-partner', 'awaiting_input', 'outside'), serverLabel: 'outside-machine',
        outside: { alias: 'peer', owner: 'owner', localServerId: 'srv2', localSession: 'working-b1' } },
    ];
    await act(async () => useSessions.setState({ rows, loading: false }));
    const sequence = (state: string) => [...container.querySelectorAll(`[data-section="${state}"] [role="header"], [data-section="${state}"] button[aria-label]`)]
      .map((el) => el.getAttribute('aria-label')!.split(',')[0]);
    expect(sequence('awaiting_input')).toEqual(['home_sessions_awaiting', 'machine-a', 'waiting-a1', 'waiting-a2', 'machine-b', 'waiting-b']);
    expect(sequence('working')).toEqual(['home_sessions_working', 'machine-b', 'working-b1', 'outside-partner', 'working-b2', 'machine-a', 'working-a']);
    expect(sequence('idle')).toEqual(['home_sessions_ready', 'machine-b', 'ready-b-new']);
    expect(container.querySelector('[aria-label="home_sessions_awaiting, 3"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="home_sessions_working, 3"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="home_sessions_ready, 4"]')).not.toBeNull();
    expect(container.querySelector('[role="header"][aria-label="outside-machine"]')).toBeNull();
    expect(container.textContent).toContain('home_sessions_more_ready:3');
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'home_sessions_more_ready:3')!.click());
    expect(sequence('idle')).toEqual(['home_sessions_ready', 'machine-b', 'ready-b-new', 'ready-b-old', 'machine-a', 'ready-a-new', 'ready-a-old']);
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'sessao_recolher')!.click());
    expect(sequence('idle')).toEqual(['home_sessions_ready', 'machine-b', 'ready-b-new']);
  });

  it('gaveta mantém agrupamento por projeto sem o agrupamento por servidor da home', async () => {
    calls.realRow = true;
    await mount();
    const row = useSessions.getState().rows[0];
    await act(async () => useSessions.setState({ loading: false, rows: [
      { ...row, name: 'from-a', cwd: '/repo/shared', state: 'working', serverLabel: 'machine-a' },
      { ...row, name: 'from-b', cwd: '/repo/shared', state: 'working', serverId: 'srv2', serverLabel: 'machine-b' },
    ] }));
    expect(container.querySelector('[role="header"][aria-label="machine-a"]')).toBeNull();
    expect(container.querySelector('[role="header"][aria-label="machine-b"]')).toBeNull();
    expect([...container.querySelectorAll('button[aria-label^="from-"]')].map((el) => el.getAttribute('aria-label')!.split(',')[0])).toEqual(['from-a', 'from-b']);
    expect(container.querySelector('button[aria-label="shared, 2 lista_sessoes_plural"]')).not.toBeNull();
  });

  it('home preserva expansão e posição ao abrir sessão e voltar com remount', async () => {
    calls.realRow = true;
    calls.sessions = [
      { name: 'ready-old', state: 'idle', jsonl: '/tmp/old.jsonl', last_activity: 100 },
      { name: 'ready-new', state: 'idle', jsonl: '/tmp/new.jsonl', last_activity: 300 },
      { name: 'ready-middle', state: 'idle', jsonl: '/tmp/middle.jsonl', last_activity: 200 },
    ];
    await mount({ variant: 'home' });
    // A tela inicial e o chat também retêm o store durante a navegação.
    const release = useSessions.getState().retain();
    try {
      await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'home_sessions_more_ready:2')!.click());
      const list = container.querySelector<HTMLDivElement>('[data-native-list]')!;
      await act(async () => { list.scrollTop = 480; list.dispatchEvent(new Event('scroll')); });
      const row = () => container.querySelector<HTMLButtonElement>('button[aria-label^="ready-old,"]');
      expect(row()).not.toBeNull();
      await act(async () => row()!.click());
      expect(calls.push).toHaveBeenCalledWith('/s/srv1/ready-old');
      await act(async () => root.render(null));
      await mount({ variant: 'drawer' });
      const drawer = container.querySelector<HTMLDivElement>('[data-native-list]')!;
      expect(drawer.scrollTop).toBe(0);
      await act(async () => { drawer.scrollTop = 75; drawer.dispatchEvent(new Event('scroll')); });
      await act(async () => root.render(null));
      await mount({ variant: 'home' });
      expect(row(), 'pronta antiga continua visível após remontar a home').not.toBeNull();
      expect(container.textContent).not.toContain('home_sessions_more_ready:2');
      expect(container.querySelector<HTMLDivElement>('[data-native-list]')!.scrollTop, 'posição da home não herda a da gaveta').toBe(480);
    } finally { release(); }
  });

  it.each(['crescimento', 'novo remount', 'gesto'])('home restaura lista longa com altura insuficiente: %s', async (scenario) => {
    calls.realRow = true;
    calls.sessions = Array.from({ length: 40 }, (_, index) => ({
      name: `ready-${index}`, state: 'idle', jsonl: `/tmp/ready-${index}.jsonl`, last_activity: 100 - index,
    }));
    await mount({ variant: 'home' });
    const release = useSessions.getState().retain();
    const list = () => container.querySelector<HTMLDivElement>('[data-native-list]')!;
    try {
      await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'home_sessions_more_ready:39')!.click());
      await act(async () => { list().scrollTop = 1500; list().dispatchEvent(new Event('scroll')); });
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="ready-20,"]')!.click());
      expect(calls.push).toHaveBeenCalledWith('/s/srv1/ready-20');
      await act(async () => root.render(null));
      calls.listHeight = 500;
      await mount({ variant: 'home' });
      expect(list().scrollTop, 'altura nativa inicial limita a rolagem').toBe(200);
      expect(container.textContent).not.toContain('home_sessions_more_ready:39');
      if (scenario === 'novo remount') {
        await act(async () => root.render(null));
        calls.listHeight = 2000;
        await mount({ variant: 'home' });
        expect(list().scrollTop, 'scroll intermediário não substitui o alvo guardado').toBe(1500);
      } else {
        await act(async () => calls.listContentSize!(1000));
        expect(list().scrollTop, 'crescimento permite avançar até o novo limite').toBe(700);
        if (scenario === 'gesto') {
          await act(async () => {
            list().dispatchEvent(new Event('touchstart', { bubbles: true }));
            list().scrollTop = 120;
            list().dispatchEvent(new Event('scroll'));
          });
          const attempts = calls.scrollTo.mock.calls.length;
          await act(async () => { calls.listContentSize!(2500); calls.listLayout!(200); });
          expect(calls.scrollTo).toHaveBeenCalledTimes(attempts);
          expect(list().scrollTop, 'gesto cancela reposicionamento automático').toBe(120);
          await act(async () => root.render(null));
          calls.listHeight = 2500;
          await mount({ variant: 'home' });
          expect(list().scrollTop, 'próximo remount guarda a posição escolhida no gesto').toBe(120);
        } else {
          await act(async () => calls.listLayout!(200));
          expect(list().scrollTop, 'layout também retenta a posição pendente').toBe(800);
          await act(async () => calls.listContentSize!(2000));
          expect(list().scrollTop, 'altura suficiente alcança o alvo').toBe(1500);
          const attempts = calls.scrollTo.mock.calls.length;
          await act(async () => { calls.listContentSize!(2500); calls.listLayout!(300); });
          expect(calls.scrollTo).toHaveBeenCalledTimes(attempts);
          expect(list().scrollTop).toBe(1500);
        }
      }
    } finally { release(); }
  });

  it('home mostra recolhida a pronta que terminou por último', async () => {
    await mount({ variant: 'home' });
    const row = useSessions.getState().rows[0];
    const rows = [
      { ...row, name: 'antiga', state: 'idle', last_activity: 100 },
      { ...row, name: 'recente', state: 'idle', last_activity: 300 },
      { ...row, name: 'meio', state: 'idle', last_activity: 200 },
    ] as AggSession[];
    await act(async () => useSessions.setState({ rows, loading: false }));
    expect([...container.querySelectorAll('[data-row]')].map((el) => el.textContent)).toEqual(['recente']);
  });

  it('home reúne máquinas por estado, ignora organizar e expande prontas sem perder ações', async () => {
    calls.organizar = 'conversations';
    const onClose = vi.fn();
    await mount({ variant: 'home', onClose });
    const row = useSessions.getState().rows[0];
    const rows = [
      { ...row, name: 'ready-a', state: 'idle' },
      { ...row, name: 'waiting-b', state: 'awaiting_input', serverId: 'srv2', serverLabel: 'another-machine' },
      { ...row, name: 'working-a', state: 'working' },
      { ...row, name: 'ready-b', state: 'idle', serverId: 'srv2' },
      { ...row, name: 'dead-a', state: 'dead' },
    ] as AggSession[];
    await act(async () => useSessions.setState({ rows, loading: false }));
    expect([...container.querySelectorAll('[data-row]')].map((el) => el.textContent))
      .toEqual(['waiting-b', 'working-a', 'ready-a']);
    expect(container.textContent).toContain('home_sessions_more_ready:1');
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('native_brand');
    expect(container.textContent).not.toContain('native_sidebar_all_sessions');
    expect(container.querySelector('[aria-label="config_modal_titulo"]')).toBeNull();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'home_sessions_more_ready:1')!.click());
    expect(container.querySelector('[data-row="srv2::ready-b"]')).not.toBeNull();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'sessao_recolher')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-open="srv2::waiting-b"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls.push).toHaveBeenCalledWith('/s/srv2/waiting-b');
    calls.deleteSession.mockResolvedValueOnce({ ok: true });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-row="srv1::working-a"]')!.click());
    await act(async () => confirm()());
    expect(calls.deleteSession).toHaveBeenCalledWith('working-a');
  });

  it('home mantém pares externos junto da âncora e conta só âncoras ao expandir prontas', async () => {
    await mount({ variant: 'home' });
    const row = useSessions.getState().rows[0];
    const external = (name: string, anchor: string): AggSession => ({ ...row, name, state: 'awaiting_input', serverId: 'outside',
      outside: { alias: 'peer', owner: 'owner', localServerId: 'srv1', localSession: anchor } });
    await act(async () => useSessions.setState({ loading: false, rows: [
      { ...row, name: 'working-anchor', state: 'working' }, external('working-outside', 'working-anchor'),
      { ...row, name: 'ready-a', state: 'idle' }, external('ready-a-outside', 'ready-a'),
      { ...row, name: 'ready-b', state: 'idle' }, external('ready-b-outside', 'ready-b'),
    ] }));
    const names = (section: string) => [...container.querySelectorAll(`[data-section="${section}"] [data-row]`)].map((el) => el.textContent);
    expect(names('working')).toEqual(['working-anchor', 'working-outside']);
    expect(container.querySelector('[data-section="awaiting_input"]')).toBeNull();
    expect(names('idle')).toEqual(['ready-a', 'ready-a-outside']);
    expect(container.textContent).toContain('home_sessions_more_ready:1');
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'home_sessions_more_ready:1')!.click());
    expect(names('idle')).toEqual(['ready-a', 'ready-a-outside', 'ready-b', 'ready-b-outside']);
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'sessao_recolher')!.click());
    expect(names('idle')).toEqual(['ready-a', 'ready-a-outside']);
    expect(names('working')).toEqual(['working-anchor', 'working-outside']);
  });

  it('home mostra carregamento, vazio e falha identificada por máquina', async () => {
    await mount({ variant: 'home' });
    await act(async () => useSessions.setState({ rows: [], loading: true }));
    expect(container.textContent).toContain('lista_carregando');
    expect(container.textContent).not.toContain('lista_nenhuma_ativa');
    await act(async () => useSessions.setState({ loading: false, byServer: [{ server, sessions: [], loaded: true, error: null }] }));
    expect(container.textContent).toContain('lista_nenhuma_ativa');
    await act(async () => useSessions.setState({ byServer: [{ server, sessions: [], loaded: true, error: 'list-unavailable' }] }));
    expect(container.textContent).toContain('fixture-server: list-unavailable');
    expect(container.textContent).not.toContain('lista_nenhuma_ativa');
  });

  it('Nova conversa usa sua ação própria sem confundir fechamento para navegação', async () => {
    const onClose = vi.fn();
    const onNewConversation = vi.fn();
    await mount({ onClose, onNewConversation });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="native_new_chat_title"]')!.click());
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([null, { unknown_warning: true }])('esconde antes do DELETE terminar, bloqueia confirmação duplicada e mantém marca após sucesso (%j)', async (warning) => {
    let resolve!: (value: { ok: boolean; warning: unknown | null }) => void;
    calls.deleteSession.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await mount();
    const row = container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!;
    expect(row).not.toBeNull();
    await act(async () => { row.click(); row.click(); });
    expect(calls.alert).toHaveBeenCalledTimes(1);
    const first = confirm();

    await act(async () => { first(); first(); });

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
    await act(async () => { first(); });
    expect(calls.deleteSession).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-row="srv1::fixture"]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!.click(); });
    expect(calls.alert).toHaveBeenCalledTimes(2);
  });

  it.each(['cancel', 'dismiss'] as const)('%s libera o diálogo e callbacks antigas não confirmam nem liberam o próximo', async (action) => {
    calls.deleteSession.mockResolvedValueOnce({ ok: true, warning: null });
    await mount();
    const row = container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!;
    await act(async () => { row.click(); });
    const first = confirm();
    const close = action === 'cancel'
      ? calls.alert.mock.calls[0][2].find((button: { style?: string }) => button.style === 'cancel').onPress
      : calls.alert.mock.calls[0][3]?.onDismiss;
    expect(close).toBeTypeOf('function');

    await act(async () => { close(); });
    expect(calls.deleteSession).not.toHaveBeenCalled();
    expect(container.querySelector('[data-row="srv1::fixture"]')).not.toBeNull();
    await act(async () => { row.click(); });
    expect(calls.alert).toHaveBeenCalledTimes(2);

    await act(async () => { first(); close(); row.click(); });
    expect(calls.deleteSession).not.toHaveBeenCalled();
    expect(calls.alert).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-row="srv1::fixture"]')).not.toBeNull();
    await act(async () => { confirm(1)(); });
    expect(calls.deleteSession).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();
  });

  it('cancelamento e dispensa tardios não liberam uma exclusão pendente', async () => {
    let resolve!: (value: { ok: boolean; warning: null }) => void;
    calls.deleteSession.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await mount();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!.click(); });
    const first = confirm();
    const cancel = calls.alert.mock.calls[0][2].find((button: { style?: string }) => button.style === 'cancel').onPress;
    const dismiss = calls.alert.mock.calls[0][3]?.onDismiss;
    expect(cancel).toBeTypeOf('function');
    expect(dismiss).toBeTypeOf('function');
    await act(async () => { first(); first(); });
    expect(calls.deleteSession).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();

    await act(async () => { cancel(); dismiss(); emit([]); });
    await act(async () => { emit([{ ...calls.sessions[0], jsonl: '/tmp/recreated.jsonl' }]); });
    expect(container.querySelector('[data-row="srv1::fixture"]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!.click(); first(); });
    expect(calls.alert).toHaveBeenCalledTimes(1);
    expect(calls.deleteSession).toHaveBeenCalledTimes(1);

    await act(async () => { resolve({ ok: true, warning: null }); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!.click(); });
    expect(calls.alert).toHaveBeenCalledTimes(2);
  });

  it('servidor indisponível libera a confirmação sem DELETE e permite abrir outra', async () => {
    vi.mocked(useServers.getState().ensureActive).mockReturnValueOnce(false);
    calls.deleteSession.mockResolvedValueOnce({ ok: true, warning: null });
    await mount();
    const row = container.querySelector<HTMLButtonElement>('[data-row="srv1::fixture"]')!;
    await act(async () => { row.click(); });
    const first = confirm();
    await act(async () => { first(); first(); });
    expect(calls.deleteSession).not.toHaveBeenCalled();
    expect(calls.error).toHaveBeenCalledWith('servidor_nao_existe');
    expect(container.querySelector('[data-row="srv1::fixture"]')).not.toBeNull();

    await act(async () => { row.click(); });
    expect(calls.alert).toHaveBeenCalledTimes(2);
    await act(async () => { confirm(1)(); });
    expect(calls.deleteSession).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(container.querySelector('[data-row="srv1::fixture"]')).toBeNull();
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

  it('parar de acompanhar remove só o convite, sem DELETE nem troca da máquina ativa', async () => {
    calls.deleteSession.mockResolvedValueOnce({ ok: true, warning: null });
    useServers.setState({ servers: [server, { ...server, id: 'guest', baseUrl: 'https://guest.test', invite: true }] });
    await mount();
    const row = container.querySelector<HTMLButtonElement>('[data-row="guest::fixture"]');
    expect(row).not.toBeNull();
    await act(async () => row!.click());
    // Também denuncia a tentativa antiga, que abria a confirmação de exclusão.
    if (calls.alert.mock.calls.length) await act(async () => confirm()());
    expect(calls.deleteSession).not.toHaveBeenCalled();
    expect(useServers.getState().ensureActive).not.toHaveBeenCalled();
    expect(useServers.getState().activeId).toBe('srv1');
    expect(useServers.getState().servers.map((s) => s.id)).toEqual(['srv1']);
    expect(container.querySelector('[data-row="guest::fixture"]')).toBeNull();
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
