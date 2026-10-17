// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('react-native', async (original) => {
  const native = await original<typeof import('react-native')>();
  return {
    ...native,
    // O DOM não compõe linhas nativas; preserva o contrato de truncamento recebido pelo Text.
    Text: (props: import('react-native').TextProps) =>
      createElement(native.Text, { ...props, ...{ 'data-number-of-lines': props.numberOfLines } }),
    Pressable: (props: { accessibilityLabel?: string; onPress?: () => void; disabled?: boolean; children?: ReactNode }) =>
      createElement('button', { 'aria-label': props.accessibilityLabel, onClick: props.onPress, disabled: props.disabled }, props.children),
  };
});
vi.mock('expo-haptics', () => ({ impactAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Medium: 'medium' } }));
vi.mock('../../ui/HangarMark', () => ({ HangarMark: () => null }));
vi.mock('../../paraglide/messages', () => ({
  ask_perguntas: () => 'ask_perguntas',
  conta_padrao: () => 'conta_padrao',
  sessao_conta: (p: { n: string }) => `conta ${p.n}`,
  orq_row_badge: () => 'orq_row_badge',
  sessao_excluir_curto: () => 'sessao_excluir_curto',
  sessao_git: () => 'sessao_git',
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
  afterEach(() => { Platform.OS = 'android'; });

  it('motor Claude substitui provedor no texto e na acessibilidade com marca real', async () => {
    Platform.OS = 'ios';
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude', engine: 'gpt-6-1-sol', cwd: '/repo', branch: 'main' });
    try {
      expect(container.textContent).not.toContain('Claude');
      const row = container.querySelector('button[aria-label^="api,"]');
      expect(row?.getAttribute('aria-label')).toContain('gpt-6-1-sol');
      expect(row?.getAttribute('aria-label')).not.toContain('Claude');
      const mark = container.querySelector('[data-symbol="gearshape"]');
      expect(mark).not.toBeNull();
      const engine = Array.from(mark!.parentElement!.querySelectorAll('span')).find(el => el.textContent === 'gpt-6-1-sol');
      expect(engine?.style.color).toBe('#00f');
      expect(engine?.style.fontWeight).toBe('600');
      expect(container.textContent).toContain('repo · main');
    } finally {
      act(() => root.unmount());
    }
  });

  it('servidor longo encolhe em uma linha sem remover motor', async () => {
    Platform.OS = 'ios';
    const serverLabel = 'servidor-com-nome-longo-para-disputar-a-largura';
    const { container, root } = await render(
      { ...base, name: 'api', provider: 'claude', engine: 'gpt-6-1-sol', serverLabel, cwd: '/repo' },
      { mostrarServidor: true },
    );
    try {
      const server = Array.from(container.querySelectorAll('span')).find(el => el.textContent === `${serverLabel} · `);
      expect(server?.getAttribute('data-number-of-lines')).toBe('1');
      expect(server?.style.flexShrink).toBe('1');
      const mark = server?.parentElement?.querySelector('[data-symbol="gearshape"]');
      expect(mark).not.toBeNull();
      expect(mark?.parentElement?.textContent).toBe('gpt-6-1-sol');
      expect(container.querySelector('button[aria-label^="api,"]')?.getAttribute('aria-label')).toContain('gpt-6-1-sol');
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([
    { provider: 'claude', engine: undefined, label: 'Claude' },
    { provider: 'codex', engine: 'gpt-6-1-sol', label: 'Codex' },
    { provider: 'orq', engine: undefined, label: null },
  ] as const)('marca de motor preserva provedor $provider sem motor Claude', async ({ provider, engine, label }) => {
    Platform.OS = 'ios';
    const { container, root } = await render({ ...base, name: 'api', provider, engine });
    try {
      expect(container.querySelector('[data-symbol="gearshape"]')).toBeNull();
      expect(container.textContent).not.toContain('gpt-6-1-sol');
      const accessible = container.querySelector('button[aria-label^="api,"]')?.getAttribute('aria-label');
      if (label) {
        expect(container.textContent).toContain(label);
        expect(accessible).toContain(label);
      } else {
        expect(accessible).not.toContain('Orq');
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([
    { conta: 'claude:/home/user/.claude-claude-200-3', label: '200-3', name: 'claude-200-3', color: '#97c69d' },
    { conta: 'claude:C:\\Users\\user\\.claude-claude-200-3\\', label: '200-3', name: 'claude-200-3', color: '#97c69d' },
    { conta: 'claude:/home/user/.claude/', label: 'conta_padrao', name: 'conta_padrao', color: '#9ba9d9' },
    { conta: 'codex:C:\\Users\\user\\.codex\\', label: 'conta_padrao', name: 'conta_padrao', color: '#d3a781' },
    { conta: 'codex:C:\\Users\\user\\.codex-claude-x\\', label: 'claude-x', name: 'claude-x', color: '#ccbf87' },
    { conta: 'codex:/home/user/.codex-codex-x', label: 'x', name: 'codex-x', color: '#80bbc3' },
  ])('chip de conta $conta mostra nome curto e ponto da cor PWA antes do tempo', async ({ conta, label, name, color }) => {
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude', conta });
    try {
      const chip = container.querySelector<HTMLElement>(`[aria-label="conta ${name}"]`);
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toBe(label);
      expect(chip!.querySelector<HTMLElement>('span')?.style.color).toBe('#666');
      expect(chip!.querySelector<HTMLElement>('div')?.style.backgroundColor).toBe(color);
      expect(chip!.style.maxWidth).toBe('96px');
      expect(chip!.style.flexShrink).toBe('1');
      const time = chip!.nextElementSibling as HTMLElement;
      expect(time.textContent).not.toBe('');
      expect(time.style.flexShrink).toBe('0');
      expect(chip!.parentElement!.firstElementChild?.textContent).toBe('api');
      expect(container.querySelector('button[aria-label^="api,"]')?.getAttribute('aria-label')).toContain(`conta ${name}`);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([undefined, null, 'chave:gpt-6-1-sol', 'kimi:api'])('chip de conta ignora identidade %s', async (conta) => {
    const { container, root } = await render({ ...base, name: 'api', provider: 'claude', engine: 'gpt-6-1-sol', conta });
    try {
      expect(container.querySelector('[aria-label^="conta "]')).toBeNull();
      expect(container.textContent).not.toContain('conta_padrao');
    } finally {
      act(() => root.unmount());
    }
  });

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
