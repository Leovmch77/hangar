// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggSession, ServerBucket } from '@hangar/core';
import type { SessionsBarPlacement } from '../../stores/tabletPrefs';

const state = vi.hoisted(() => ({
  rows: [] as AggSession[], byServer: [] as ServerBucket[], loading: false, keyboardVisible: false,
  retain: vi.fn(), release: vi.fn(), setPlacement: vi.fn(),
}));
vi.mock('../../stores/sessions', () => ({ useSessions: Object.assign(
  (selector: (s: typeof state) => unknown) => selector(state), { getState: () => state },
) }));
vi.mock('../../stores/servers', () => ({ useServers: (selector: (s: { servers: [] }) => unknown) => selector({ servers: [] }) }));
vi.mock('../../stores/tabletPrefs', () => ({ useTabletPrefs: (selector: (s: typeof state) => unknown) => selector(state) }));
vi.mock('../pair/identities', () => ({ useIdentities: () => ({ identities: new Map() }) }));
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: (selector: (s: { isVisible: boolean }) => unknown) => selector({ isVisible: state.keyboardVisible }),
}));
vi.mock('../../ui/Glass', () => ({ Glass: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement('div', { role: 'dialog' }, children) : null }));
vi.mock('../../ui/Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../sessions/SessionAvatar', () => ({ SessionAvatar: () => null }));
vi.mock('../sessions/SessionRow', () => ({ SessionRow: ({ session, onPress, mostrarServidor }: {
  session: AggSession; onPress: (s: AggSession) => void; mostrarServidor: boolean;
}) => createElement('button', { onClick: () => onPress(session) }, session.name, mostrarServidor ? session.serverLabel : '') }));
vi.mock('react-native', async (original) => {
  const native = await original<typeof import('react-native')>();
  return { ...native,
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) => createElement('div', { style: Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) }, children),
    Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState }: {
      children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; accessibilityState?: { selected?: boolean };
    }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'aria-selected': accessibilityState?.selected }, children),
  };
});

import { SessionsBar } from './SessionsBar';
import { SessionChip } from './SessionChip';
import * as m from '../../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const session: AggSession = { name: 'api', serverId: 'nb', serverLabel: 'Notebook', serverColor: '#999', state: 'idle', last_activity: 1 };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [session]; state.byServer = []; state.loading = false; state.keyboardVisible = false;
  state.retain.mockReturnValue(state.release);
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });
const render = (placement: SessionsBarPlacement, onPick = vi.fn(), onNew = vi.fn()) => {
  act(() => root.render(createElement(SessionsBar, { placement, selected: { serverId: 'nb', name: 'api' }, onPick, onNew })));
  return { onPick, onNew };
};
const click = (label: string) => {
  const button = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);
  expect(button).toBeDefined();
  act(() => button!.click());
};

describe('SessionsBar', () => {
  it('não monta a barra de baixo com o teclado visível e volta ao fechar', () => {
    state.keyboardVisible = true;
    render('bottom'); expect(container.innerHTML).toBe('');
    state.keyboardVisible = false;
    render('bottom'); expect(container.textContent).toContain(session.name);
  });
  it('conserva a barra de cima com o teclado aberto', () => {
    state.keyboardVisible = true;
    render('top'); expect(container.textContent).toContain(session.name);
  });
  it('mostra vazio com nova sessão disponível', () => {
    state.rows = [];
    const { onNew } = render('bottom');
    expect(container.textContent).toContain(m.tablet_sessions_empty());
    click(m.tablet_new_session()); expect(onNew).toHaveBeenCalledOnce();
  });
  it('mostra carregamento antes de declarar a lista vazia', () => {
    state.rows = []; state.loading = true;
    render('left');
    expect(container.textContent).toContain('loading');
    expect(container.textContent).not.toContain(m.tablet_sessions_empty());
  });
  it('com a lista vazia mostra a falha do servidor sem tirar nova sessão', () => {
    state.rows = [];
    state.byServer = [{ server: { id: 'nb', label: 'Notebook', baseUrl: '', token: '' }, sessions: [], loaded: false, error: 'falha-conexao' }];
    render('bottom');
    expect(container.textContent).toContain('falha-conexao');
    expect(container.textContent).toContain(m.tablet_sessions_empty());
    expect(container.querySelector(`[aria-label="${m.tablet_new_session()}"]`)).not.toBeNull();
  });
  it.each(['left', 'rail', 'bottom', 'top'] as const)('%s troca a sessão pela identidade completa', placement => {
    state.rows = [session, { ...session, serverId: 'casa', serverLabel: 'Casa' }];
    const { onPick } = render(placement);
    const buttons = [...container.querySelectorAll('button')];
    const other = buttons.find(b => `${b.getAttribute('aria-label')} ${b.textContent}`.includes('Casa'))!;
    expect(other).toBeDefined();
    act(() => other.click());
    expect(onPick).toHaveBeenCalledWith(state.rows[1]);
  });
  it('abre as quatro opções e grava a posição escolhida', () => {
    render('bottom'); click(m.tablet_bar_position());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    for (const label of [m.tablet_bar_left(), m.tablet_bar_rail(), m.tablet_bar_bottom(), m.tablet_bar_top()])
      expect(container.textContent).toContain(label);
    click(m.tablet_bar_rail());
    expect(state.setPlacement).toHaveBeenCalledExactlyOnceWith('rail');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('retém a lista compartilhada uma vez e libera ao desmontar', () => {
    render('bottom'); render('left');
    expect(state.retain).toHaveBeenCalledOnce();
    act(() => root.render(null)); expect(state.release).toHaveBeenCalledOnce();
  });
  it.each(['top', 'bottom'] as const)('%s mostra a tarefa acima do cartão da mãe', placement => {
    state.rows = [
      { ...session, pair_gid: 'g', pair_task: '  PM-123 tela  ' },
      { ...session, name: 'filha', pair_gid: 'g', linked_by: 'api', state: 'working' },
    ];
    render(placement);
    const label = [...container.querySelectorAll('span')].find(el => el.textContent === 'PM-123 tela');
    expect(label).toBeDefined();
    expect(label!.nextElementSibling?.getAttribute('aria-label')).toContain('api,');
  });
  it.each(['top', 'bottom'] as const)('%s sem tarefa não inventa rótulo com nomes das sessões', placement => {
    state.rows = [{ ...session, pair_gid: 'g' }, { ...session, name: 'filha', pair_gid: 'g' }];
    render(placement);
    expect([...container.querySelectorAll('span')].some(el => el.textContent === 'api, filha')).toBe(false);
  });
  it('preserva o bloco montado pelo gid quando os estados dos membros mudam', () => {
    state.rows = [{ ...session, pair_gid: 'g', state: 'working' }, { ...session, name: 'web', pair_gid: 'g' }];
    render('bottom');
    const before = container.querySelector('button[aria-label^="api,"]')!.parentElement;
    state.rows = [{ ...state.rows[0], state: 'idle' }, { ...state.rows[1], state: 'awaiting_input' }];
    render('bottom');
    const after = container.querySelector('button[aria-label^="api,"]')!.parentElement;
    expect(after).toBe(before);
  });
});

it('SessionChip identifica a máquina com o ícone e o nome dela', () => {
  const onPress = vi.fn();
  act(() => root.render(createElement(SessionChip, { session, selected: true, onPress })));
  expect(container.textContent).toContain('Notebook');
  expect(container.querySelector('[data-icon="Monitor"]')).not.toBeNull();
  expect(container.querySelector('button')?.getAttribute('aria-selected')).toBe('true');
  act(() => container.querySelector('button')!.click());
  expect(onPress).toHaveBeenCalledOnce();
});
