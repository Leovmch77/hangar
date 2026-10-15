// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAccount, Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  accounts: vi.fn(), preparation: vi.fn(), harnesses: vi.fn(), install: vi.fn(), config: vi.fn(), integration: vi.fn(), options: vi.fn(),
  getString: vi.fn(), set: vi.fn(),
}));
const state = vi.hoisted(() => ({ server: { id: 'a', label: 'server-a', baseUrl: 'https://a.test', token: 'token-a' } }));
const serverA = state.server;
const serverB = { id: 'b', label: 'server-b', baseUrl: 'https://b.test', token: 'token-b' };

vi.mock('../../stores/servers', () => ({
  useServers: (selector: (s: { active: () => Server }) => unknown) => selector({ active: () => state.server }),
}));
vi.mock('../../stores/prefs', () => ({ prefs: { getString: calls.getString, set: calls.set } }));
vi.mock('@hangar/core', async original => ({
  ...await original<typeof import('@hangar/core')>(),
  getCodexAccountsForServer: calls.accounts,
  getCodexPreparationForServer: calls.preparation,
  getHarnessesForServer: calls.harnesses,
  getHarnessInstallForServer: calls.install,
  getConfigForServer: calls.config,
  getCodexIntegrationForServer: calls.integration,
  codexOpcoes: calls.options,
}));
vi.mock('react-native', async original => ({
  ...await original<typeof import('react-native')>(),
  Switch: () => null,
  Pressable: ({ children, onPress, accessibilityRole, accessibilityLabel, accessibilityState, disabled }: {
    children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityLabel?: string;
    accessibilityState?: { checked?: boolean }; disabled?: boolean;
  }) => createElement('button', {
    onClick: onPress, role: accessibilityRole, 'aria-label': accessibilityLabel,
    'aria-checked': accessibilityState?.checked, disabled,
  }, children),
}));
vi.mock('./Pagina', () => ({ Pagina: ({ children }: { children: ReactNode }) => createElement('main', null, children) }));
vi.mock('./SectionCard', () => ({ SectionCard: ({ children }: { children: ReactNode }) => createElement('article', null, children) }));
vi.mock('../../ui/ProviderGlyph', () => ({ ProviderGlyph: () => null }));
vi.mock('./PageHeader', () => {
  const Pill = ({ label, onPress }: { label: string; onPress: () => void }) => createElement('button', { onClick: onPress }, label);
  return {
    Pill,
    PageHeader: ({ actions }: { actions?: Array<{ label: string; onPress: () => void }> }) =>
      createElement('header', null, ...(actions ?? []).map(a => createElement(Pill, { key: a.label, ...a }))),
  };
});

import Harnesses from '../../../app/config/harnesses';

const ready: CodexAccount['sync'] = { status: 'ready', trust_pending: false, issues: [] };
const accounts: CodexAccount[] = ['default', 'work', 'personal'].map(id => ({
  id, credential_id: `codex:/${id}`, name: `account-${id}`, home: `/${id}`, is_default: id === 'default',
  auth: { method: 'oauth', status: 'connected', email: `${id}@example.test`, plan: 'Plus' }, sync: ready,
}));
const values = new Map<string, string>();
const roots = new Set<Root>();
const preferenceKey = (server: Server) => `harness.codex.account.v1:${server.id}`;
async function mount() {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.add(root);
  await act(async () => root.render(createElement(Harnesses)));
  return { container, root };
}
const selected = (container: HTMLElement) => container.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
async function choose(container: HTMLElement, id: string) {
  const button = container.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="account-${id}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
async function switchServer(root: Root, server: Server) {
  state.server = server;
  await act(async () => root.render(createElement(Harnesses)));
}

beforeEach(() => {
  vi.resetAllMocks();
  values.clear();
  state.server = serverA;
  calls.getString.mockImplementation((key: string) => values.get(key));
  calls.set.mockImplementation((key: string, value: string) => { values.set(key, value); });
  calls.accounts.mockResolvedValue(accounts);
  calls.preparation.mockResolvedValue(ready);
  calls.harnesses.mockResolvedValue([{ id: 'codex', nome: 'Codex', instalado: true, versao: '1', itens: [] }]);
  calls.install.mockResolvedValue({ fase: 'pronto', comandos: {}, manual: {} });
  calls.config.mockResolvedValue({ campos: {} });
  calls.integration.mockResolvedValue({ estado: 'ocioso', automatica: false, memoria: false });
  calls.options.mockResolvedValue({ contexto_estendido: false, modelos: [] });
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
});

describe('preferência da conta Codex nos harnesses', () => {
  it('salva a escolha e a restaura ao reabrir antes de carregar as contas', async () => {
    const first = await mount();
    await choose(first.container, 'work');
    expect(values.get(preferenceKey(serverA))).toBe('work');
    await act(async () => first.root.unmount());
    roots.delete(first.root);
    calls.preparation.mockClear();
    const second = await mount();
    expect(selected(second.container)).toBe('account-work');
    expect(calls.preparation).toHaveBeenCalledWith(serverA, 'work', expect.any(AbortSignal));
  });

  it('isola as escolhas por servidor e restaura cada uma ao voltar', async () => {
    const { container, root } = await mount();
    await choose(container, 'work');
    await switchServer(root, serverB);
    expect(selected(container)).toContain(m.criar_padrao());
    await choose(container, 'personal');
    expect(values.get(preferenceKey(serverA))).toBe('work');
    expect(values.get(preferenceKey(serverB))).toBe('personal');
    await switchServer(root, serverA);
    expect(selected(container)).toBe('account-work');
    expect(calls.preparation).toHaveBeenLastCalledWith(serverA, 'work', expect.any(AbortSignal));
    await switchServer(root, serverB);
    expect(selected(container)).toBe('account-personal');
    expect(calls.preparation).toHaveBeenLastCalledWith(serverB, 'personal', expect.any(AbortSignal));
  });

  it('volta à padrão quando a conta salva foi removida do servidor', async () => {
    values.set(preferenceKey(serverA), 'work');
    calls.accounts.mockResolvedValue(accounts.filter(a => a.id !== 'work'));
    const { container } = await mount();
    expect(selected(container)).toContain(m.criar_padrao());
    expect(calls.preparation).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="account-work"]')).toBeNull();
  });

  it('ignora a lista atrasada do servidor anterior sem perder a escolha restaurada', async () => {
    values.set(preferenceKey(serverA), 'work');
    values.set(preferenceKey(serverB), 'personal');
    let finish!: (value: CodexAccount[]) => void;
    calls.accounts.mockImplementationOnce(() => new Promise<CodexAccount[]>(resolve => { finish = resolve; }));
    const { container, root } = await mount();
    const signal = calls.accounts.mock.calls[0][1] as AbortSignal;
    await switchServer(root, serverB);
    expect(signal.aborted).toBe(true);
    expect(selected(container)).toBe('account-personal');
    await act(async () => finish(accounts.filter(a => a.id === 'default')));
    expect(selected(container)).toBe('account-personal');
    expect(calls.preparation).toHaveBeenLastCalledWith(serverB, 'personal', expect.any(AbortSignal));
  });

  it('mostra erro de leitura mesmo após carregar a lista e permite salvar outra escolha', async () => {
    calls.getString.mockImplementationOnce(() => { throw new Error('storage read failed'); });
    const { container } = await mount();
    expect(selected(container)).toContain(m.criar_padrao());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(m.native_harness_codex_preference_error());
    await choose(container, 'work');
    expect(values.get(preferenceKey(serverA))).toBe('work');
    expect(container.textContent).not.toContain(m.native_harness_codex_preference_error());
  });

  it('mostra erro de gravação sem perder a escolha em memória nem esconder o aviso na releitura', async () => {
    calls.set.mockImplementationOnce(() => { throw new Error('storage write failed'); });
    const { container } = await mount();
    await choose(container, 'work');
    expect(selected(container)).toBe('account-work');
    expect(values.has(preferenceKey(serverA))).toBe(false);
    expect(calls.preparation).toHaveBeenCalledWith(serverA, 'work', expect.any(AbortSignal));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(m.native_harness_codex_preference_error());
    await choose(container, 'personal');
    expect(values.get(preferenceKey(serverA))).toBe('personal');
    expect(container.textContent).not.toContain(m.native_harness_codex_preference_error());
  });
});
