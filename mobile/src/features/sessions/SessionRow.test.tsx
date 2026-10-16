// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AggSession } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// O menu expõe os ids das ações: são o único caminho visível pro Git, Renomear e Excluir.
vi.mock('@react-native-menu/menu', () => ({
  MenuView: ({ children, actions, onPressAction }: { children: ReactNode; actions: { id: string; title: string }[];
    onPressAction: (e: { nativeEvent: { event: string } }) => void }) =>
    createElement('div', { 'data-menu': actions.map((a) => a.id).join(' ') }, children,
      ...actions.map((a) => createElement('button', { key: a.id, 'data-action': a.id,
        onClick: () => onPressAction({ nativeEvent: { event: a.id } }) }, a.title))),
}));
// O mock comum passa `style` direto ao DOM, e o da linha é função de `pressed`.
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Pressable: (props: { accessibilityLabel?: string; onPress?: () => void; disabled?: boolean; children?: ReactNode }) =>
    createElement('button', { 'aria-label': props.accessibilityLabel, onClick: props.onPress, disabled: props.disabled }, props.children),
}));
vi.mock('expo-haptics', () => ({ impactAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Medium: 'medium' } }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/HangarMark', () => ({ HangarMark: () => null }));
vi.mock('../../paraglide/messages', () => ({
  ask_perguntas: () => 'ask_perguntas',
  orq_row_badge: () => 'orq_row_badge',
  sessao_excluir_curto: () => 'sessao_excluir_curto',
  convite_parar: () => 'convite_parar',
  sessao_renomear: () => 'sessao_renomear',
  sessao_retomar: () => 'sessao_retomar',
  sessao_sem_id: () => 'sessao_sem_id',
  sessao_worktree: () => 'sessao_worktree',
  worktree_apagada: () => 'worktree_apagada',
  native_par_convidar: () => 'native_par_convidar',
  native_par_menu: () => 'native_par_menu',
  pair_from_owner: (p: { dono: string }) => `de ${p.dono}`,
  pair_leave_outside: (p: { dono: string }) => `sair ${p.dono}`,
  pair_undo_own: (p: { dono: string }) => `desfazer ${p.dono}`,
  pair_full_pending: () => 'pair_full_pending',
  pair_release: (p: { dono: string }) => `liberar ${p.dono}`,
  pair_level_view: () => 'pair_level_view',
}));

import { useUnistyles } from 'react-native-unistyles';
import { SessionRow } from './SessionRow';

// O tema de teste não traz as pílulas de estado, que pintam a marca da linha.
useUnistyles().theme.tokens.pill = {
  working: { bg: '#eef', fg: '#00f' },
  idle: { bg: '#efe', fg: '#0a0' },
  input: { bg: '#fec', fg: '#f90' },
  dead: { bg: '#fee', fg: '#f00' },
};

const base = { serverId: 's1', serverLabel: 'casa', serverColor: '#8b5cf6', tracked: true, state: 'idle' as const, last_activity: 1_700_000_000 };

async function render(session: AggSession, extra: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const noop = () => {};
  await act(async () =>
    root.render(createElement(SessionRow, { session, mostrarServidor: false, onPress: noop, onGit: noop, onExcluir: noop, onRenomear: noop, onResume: noop, onWorktree: noop, ...extra })),
  );
  return { container, root };
}

describe('SessionRow', () => {
  it('orquestrador sem pasta: selo próprio e sem menu de toque longo', async () => {
    const { container, root } = await render({ ...base, name: 'g1-orq', provider: 'orq', pair_gid: 'g1', orq_arbiter: 'arb' });
    expect(container.textContent).toContain('orq_row_badge');
    expect(container.querySelector('[data-menu]')).toBeNull();
    act(() => root.unmount());
  });

  it('orquestrador com cwd: menu só com Git', async () => {
    const { container, root } = await render({ ...base, name: 'g1-orq', provider: 'orq', pair_gid: 'g1', orq_arbiter: 'arb', cwd: '/repo' });
    expect(container.querySelector('[data-menu]')?.getAttribute('data-menu')).toBe('git');
    act(() => root.unmount());
  });

  it('sessão comum: renomear e excluir no toque longo, sem botões de arrasto', async () => {
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude' });
    expect(container.textContent).not.toContain('orq_row_badge');
    expect(container.querySelector('[data-menu]')?.getAttribute('data-menu')).toBe('rename delete');
    expect(container.querySelector('[aria-label="sessao_excluir_curto"]')).toBeNull();
    act(() => root.unmount());
  });

  it.each([
    ['codex', false],
    ['kimi', false],
    ['pi', true],
    ['claude', true],
  ])('sem vínculo: %s abre a conversa? bloqueada=%s', async (provider, bloqueada) => {
    const { container, root } = await render({ ...base, name: 'nova', provider: provider as AggSession['provider'], tracked: false });
    const linha = container.querySelector<HTMLButtonElement>('button[aria-label^="nova,"]');
    expect(linha).not.toBeNull();
    expect(linha!.disabled).toBe(bloqueada);
    act(() => root.unmount());
  });

  it('chip de worktree chama onWorktree com o caminho real', async () => {
    const onWorktree = vi.fn();
    const { container, root } = await render(
      { ...base, name: 'api', provider: 'claude', worktree: true, worktree_path: '/r/hangar-x', cwd: '/r/hangar' }, { onWorktree });
    await act(async () => { (container.querySelector('[aria-label="sessao_worktree: hangar-x"]') as HTMLElement).click(); });
    expect(onWorktree).toHaveBeenCalledWith(expect.objectContaining({ name: 'api' }), '/r/hangar-x');
    act(() => root.unmount());
  });

  it('servidor de convite: o chip de worktree é só texto', async () => {
    const { container, root } = await render(
      { ...base, name: 'api', provider: 'claude', worktree: true, worktree_path: '/r/hangar-x', cwd: '/r/hangar' }, { onWorktree: undefined });
    expect(container.textContent).toContain('hangar-x');
    expect(container.querySelector('[aria-label^="sessao_worktree"]')).toBeNull();
    act(() => root.unmount());
  });

  it('convite oferece parar de acompanhar, nunca excluir a sessão', async () => {
    const onExcluir = vi.fn();
    const session = { ...base, name: 'convidada', provider: 'claude' as const, serverInvite: true };
    const { container, root } = await render(session, { onExcluir });
    expect(container.querySelector('[data-action="delete"]')).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>('[data-action="stop-following"]');
    expect(stop?.textContent).toBe('convite_parar');
    await act(async () => stop!.click());
    expect(onExcluir).toHaveBeenCalledExactlyOnceWith(session);
    act(() => root.unmount());
  });

  it('sessão de fora: marca do dono e só "Sair do pareamento" no menu', async () => {
    const onPair = vi.fn();
    const { container, root } = await render({ ...base, name: 'web', provider: 'claude', cwd: '/r/web', guest_kind: 'pair',
      outside: { alias: 'casa', owner: 'Ana', localServerId: 's1', localSession: 'api' } }, { onPair });
    expect(container.textContent).toContain('de Ana');
    expect(container.querySelector('[data-menu]')?.getAttribute('data-menu')).toBe('leave');
    act(() => root.unmount());
  });

  it('sessão própria com par: convidar, aceitar e desfazer um por dono', async () => {
    const pair = (owner: string, session: string) => ({ alias: owner.toLowerCase(), owner, session, address: 'https://x.ts.net:8443', level: 'view' as const, pending: false });
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude',
      pair_externals: [pair('Ana', 'web'), pair('Bia', 'docs')] }, { onPair: vi.fn() });
    expect(container.querySelector('[data-menu]')?.getAttribute('data-menu')).toBe('rename pair-invite pair-accept undo:0 undo:1 delete');
    act(() => root.unmount());
  });

  it('acesso completo pendente mostra o selo e o botão Liberar', async () => {
    const onPair = vi.fn();
    const pair = { alias: 'casa', owner: 'Ana', session: 'web', address: 'https://x.ts.net:8443', level: 'full' as const, pending: true };
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude', pair_externals: [pair] }, { onPair });
    expect(container.textContent).toContain('pair_full_pending');
    await act(async () => { (container.querySelector('[aria-label="liberar Ana"]') as HTMLElement).click(); });
    expect(onPair).toHaveBeenCalledWith(expect.objectContaining({ name: 'api' }), { kind: 'release', pair });
    act(() => root.unmount());
  });

  it('worktree apagada aparece como texto', async () => {
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude', worktree_gone: true, worktree_path: '/r/hangar-x' });
    expect(container.textContent).toContain('worktree_apagada');
    expect(container.querySelector('[aria-label^="sessao_worktree"]')).toBeNull();
    act(() => root.unmount());
  });
});
