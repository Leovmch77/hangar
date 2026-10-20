// @vitest-environment happy-dom
import { act, createElement, forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountDeletedNotice, type Credencial, type Server } from '@hangar/core';
import { ClaudeAccountActions } from './ClaudeAccountActions';
import { ClaudeAccountCreate } from './ClaudeAccountCreate';
import * as m from '../../paraglide/messages';
import { ClaudeAccountLogin } from './ClaudeAccountLogin';

const calls = vi.hoisted(() => ({
  start: vi.fn(), read: vi.fn(), code: vi.fn(), cancel: vi.fn(), create: vi.fn(), logout: vi.fn(), delete: vi.fn(),
  open: vi.fn(), copy: vi.fn(), alert: vi.fn(), removeListener: vi.fn(),
  foreground: undefined as undefined | ((state: string) => void),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const server: Server = { id: 'b', label: 'B', baseUrl: 'https://b.local', token: 'test' };
const other: Server = { id: 'c', label: 'C', baseUrl: 'https://c.local', token: 'other' };
const waiting = { etapa: 'aguardando', url: 'https://auth.example/authorize', email: null, plano: null };
const completed = { etapa: 'concluido', url: null, email: 'a@example.com', plano: 'Max' };

vi.mock('@hangar/core', async original => ({
  ...await original<typeof import('@hangar/core')>(),
  startClaudeAccountLoginForServer: calls.start,
  getClaudeAccountLoginStepForServer: calls.read,
  submitClaudeAccountLoginCodeForServer: calls.code,
  cancelClaudeAccountLoginForServer: calls.cancel,
  criarConta: calls.create, sairConta: calls.logout, apagarConta: calls.delete,
}));
vi.mock('expo-linking', () => ({ openURL: calls.open }));
vi.mock('expo-clipboard', () => ({ setStringAsync: calls.copy }));
vi.mock('../../ui/Sheet', () => ({
  Sheet: forwardRef(function Sheet({ children, dismissible, onDismiss }: { children: ReactNode; dismissible?: boolean; onDismiss?: () => void }, ref) {
    const [visible, setVisible] = useState(true);
    useImperativeHandle(ref, () => ({ present: async () => { setVisible(true); } }));
    return createElement('section', { 'data-dismissible': String(dismissible) }, visible ? children : null,
      createElement('button', { 'aria-label': 'dismiss-sheet', disabled: dismissible === false, onClick: () => { setVisible(false); onDismiss?.(); } }));
  }),
}));
vi.mock('../../paraglide/messages', async original => ({
  ...await original<typeof import('../../paraglide/messages')>(),
  mobile_accounts_claude_invalid_url: () => 'Link de autorização inválido.',
  mobile_accounts_claude_invalid_code: () => 'Código inválido.',
}));
vi.mock('react-native', async original => ({
  ...await original<typeof import('react-native')>(),
  Alert: { alert: calls.alert },
  AppState: { addEventListener: (_: string, callback: typeof calls.foreground) => {
    calls.foreground = callback; return { remove: calls.removeListener };
  } },
  TextInput: (props: { value?: string; onChangeText?: (value: string) => void; accessibilityLabel?: string; editable?: boolean; secureTextEntry?: boolean; autoCapitalize?: string }) =>
    createElement('textarea', { value: props.value, 'aria-label': props.accessibilityLabel, disabled: props.editable === false,
      'data-secure': props.secureTextEntry, 'data-capitalize': props.autoCapitalize,
      onInput: (event: { currentTarget: { value: string } }) => props.onChangeText?.(event.currentTarget.value) }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const roots: ReturnType<typeof createRoot>[] = [];
function mount() {
  const container = document.createElement('div');
  const root = createRoot(container); roots.push(root);
  return { container, root };
}
async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);
  expect(button, `botão ${label}`).toBeTruthy();
  await act(async () => button!.click());
}
async function input(container: HTMLElement, value: string) {
  const field = container.querySelector('textarea')!;
  await act(async () => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function ticks(ms = 2000) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function unmount(root: ReturnType<typeof createRoot>) {
  roots.splice(roots.indexOf(root), 1);
  await act(async () => root.unmount());
}
beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(calls)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  calls.foreground = undefined;
  calls.start.mockResolvedValue({ ok: true }); calls.read.mockResolvedValue(waiting);
  calls.code.mockResolvedValue({ ok: true, email: 'a@example.com', plano: 'Max' });
  calls.cancel.mockResolvedValue({ ok: true }); calls.open.mockResolvedValue(true); calls.copy.mockResolvedValue(true);
});
afterEach(async () => {
  for (const root of [...roots]) await unmount(root);
  vi.useRealTimers();
});

const credential: Credencial = { id: 'claude:/home/user/.claude-work', tipo: 'claude', nome: 'Apelido', nome_natural: 'Natural',
  auth_method: 'oauth', ativa: false, usos: [], gerenciada: true, login: { estado: 'ok', loggedIn: true } };
type AlertButton = { text: string; style?: string; onPress?: () => void; isPreferred?: boolean };
function alertButtons(): AlertButton[] { return calls.alert.mock.calls.at(-1)![2]; }
async function confirm(text: string, twice = false) {
  const button = alertButtons().find(b => b.text === text)!;
  expect(button, `confirmação ${text}`).toBeTruthy();
  await act(async () => { button.onPress?.(); if (twice) button.onPress?.(); });
}

describe('ClaudeAccountActions', () => {
  it('confirma sair pelo nome natural uma única vez e preserva a pasta e conversas', async () => {
    calls.logout.mockResolvedValue(undefined);
    const { root, container } = mount(); const changed = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential, onChanged: changed })));
    await click(container, m.contas_sair());
    expect(calls.alert.mock.calls[0][1]).toBe(m.contas_sair_pergunta({ nome: 'Apelido' }));
    expect(calls.logout).not.toHaveBeenCalled();
    await confirm(m.contas_sair(), true);
    expect(calls.logout).toHaveBeenCalledExactlyOnceWith(server, 'Natural'); expect(changed).toHaveBeenCalledTimes(1);
    expect(calls.delete).not.toHaveBeenCalled();
  });

  it.each([false, true])('remoção usa a pasta Windows, não o apelido, guardando conversas=%s', async keep => {
    calls.delete.mockResolvedValue({ ok: true, merged: 2, renamed: 0, skipped: 1 });
    const { root, container } = mount(); const changed = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server,
      credential: { ...credential, id: 'claude:C:\\Users\\User\\.claude-work' }, onChanged: changed })));
    await click(container, m.comum_apagar());
    expect(alertButtons().map(b => b.text)).toEqual([m.comum_cancelar(), m.contas_apagar_com_conversas(), m.contas_apagar_juntando()]);
    expect(alertButtons()[2].isPreferred).toBe(true);
    await confirm(keep ? m.contas_apagar_juntando() : m.contas_apagar_com_conversas(), true);
    expect(calls.delete).toHaveBeenCalledExactlyOnceWith(server, 'work', keep, false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(calls.alert).toHaveBeenLastCalledWith(accountDeletedNotice('Apelido', keep, { ok: true, merged: 2, renamed: 0, skipped: 1 }));
  });

  it.each([
    { id: 'claude:/home/user/.claude' }, { gerenciada: false }, { ativa: true }, { usos: ['session'] }, { id: 'claude:/other/path' },
  ])('não oferece remover conta protegida %j', async override => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential: { ...credential, ...override }, onChanged: vi.fn() })));
    expect([...container.querySelectorAll('button')].some(b => b.textContent === m.comum_apagar())).toBe(false);
  });

  it('conta não gerenciada não oferece saída, login nem remoção', async () => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential: { ...credential, gerenciada: false }, onChanged: vi.fn() })));
    expect(container.querySelectorAll('button')).toHaveLength(0);
    await act(async () => root.render(createElement(ClaudeAccountActions, { server,
      credential: { ...credential, gerenciada: false, login: { estado: 'ok', loggedIn: false } }, onChanged: vi.fn() })));
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('login já aberto não inicia autenticação ao trocar de máquina pela linha', async () => {
    const { root, container } = mount(); const disconnected = { ...credential, login: { estado: 'ok' as const, loggedIn: false } };
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential: disconnected, onChanged: vi.fn() })));
    await click(container, m.contas_entrar());
    await act(async () => root.render(createElement(ClaudeAccountActions, { server: other, credential: disconnected, onChanged: vi.fn() })));
    expect(calls.start).not.toHaveBeenCalledWith(other, 'Natural');
    expect(calls.start).toHaveBeenCalledTimes(1);
  });

  it('login expirado oferece renovar em vez de sair e abre o label natural', async () => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential: { ...credential,
      login: { estado: 'ok', loggedIn: true, refreshExpiresAt: Date.now() / 1000 - 1 } }, onChanged: vi.fn() })));
    expect([...container.querySelectorAll('button')].some(b => b.textContent === m.contas_sair())).toBe(false);
    await click(container, m.contas_renovar_login());
    expect(calls.start).toHaveBeenCalledWith(server, 'Natural');
  });

  it.each([undefined, Date.now() / 1000 + 86400])('cota expirada permite renovar com prazo de refresh %s sem exigir logout', async refreshExpiresAt => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential: { ...credential,
      login: { estado: 'ok', loggedIn: true, refreshExpiresAt }, cota: { estado: 'expirada', janelas: [] } }, onChanged: vi.fn() })));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.some(b => b.textContent === m.contas_renovar_login())).toBe(true);
    expect(buttons.some(b => b.textContent === m.contas_sair())).toBe(false);
    await click(container, m.contas_renovar_login());
    expect(calls.start).toHaveBeenCalledWith(server, 'Natural'); expect(calls.logout).not.toHaveBeenCalled();
  });

  it.each([{ ok: true, merged: 0, skipped: 1 }, { ok: true }])('aviso de remoção permanece no alerta após onChanged desmontar a linha (%j)', async result => {
    calls.delete.mockResolvedValue(result);
    const { root, container } = mount();
    const notice = accountDeletedNotice('Apelido', true, result);
    let alertAtChange: unknown[] | undefined;
    const changed = vi.fn(() => {
      alertAtChange = calls.alert.mock.calls.at(-1);
      root.unmount(); roots.splice(roots.indexOf(root), 1);
    });
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential, onChanged: changed })));
    await click(container, m.comum_apagar()); await confirm(m.contas_apagar_juntando());
    expect(changed).toHaveBeenCalledTimes(1); expect(container.textContent).toBe('');
    expect(alertAtChange).toEqual([notice]); expect(calls.alert).toHaveBeenLastCalledWith(notice);
  });

  it('recusa do servidor fica visível sem emitir onChanged', async () => {
    calls.delete.mockRejectedValue(new Error('409: account in use'));
    const { root, container } = mount(); const changed = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential, onChanged: changed })));
    await click(container, m.comum_apagar()); await confirm(m.contas_apagar_juntando());
    expect(container.textContent).toContain('409: account in use'); expect(changed).not.toHaveBeenCalled();
  });

  it('conta presa pergunta se libera, lista o que prende e reapaga com release', async () => {
    calls.delete.mockRejectedValueOnce(Object.assign(new Error('preso'), { status: 409, envelope: { code: 'erro_processos_usam_conta',
      params: { sessoes: ['s1'], processos: [{ pid: 1572, nome: null, sessao: 'term-a' }] } } })).mockResolvedValue({ ok: true });
    const { root, container } = mount(); const changed = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential, onChanged: changed })));
    await click(container, m.comum_apagar()); await confirm(m.contas_apagar_com_conversas());
    expect(calls.alert.mock.calls.at(-1)![0]).toBe(m.contas_liberar_titulo({ nome: 'Apelido' }));
    expect(calls.alert.mock.calls.at(-1)![1]).toBe([m.contas_liberar_sessoes({ lista: 's1' }), m.contas_liberar_processos({
      lista: m.contas_liberar_processo({ nome: m.contas_liberar_processo_terminal({ sessao: 'term-a' }), pid: 1572 }) })].join('\n'));
    expect(container.textContent).not.toContain('preso');
    await confirm(m.contas_liberar_confirmar());
    expect(calls.delete).toHaveBeenLastCalledWith(server, 'work', false, true);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('confirmação antiga não age na máquina nova e resposta antiga não atualiza a linha', async () => {
    const { root, container } = mount(); const changed = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential, onChanged: changed })));
    await click(container, m.contas_sair()); const stale = alertButtons()[1];
    await act(async () => root.render(createElement(ClaudeAccountActions, { server: other, credential, onChanged: changed })));
    await act(async () => stale.onPress?.()); expect(calls.logout).not.toHaveBeenCalled();
    const pending = deferred<void>(); calls.logout.mockReturnValueOnce(pending.promise);
    await click(container, m.contas_sair()); await confirm(m.contas_sair());
    expect(calls.logout).toHaveBeenCalledWith(other, 'Natural');
    await act(async () => root.render(createElement(ClaudeAccountActions, { server, credential, onChanged: changed })));
    await act(async () => pending.resolve()); expect(changed).not.toHaveBeenCalled();
  });
});

describe('ClaudeAccountCreate', () => {
  describe('releitura da criação', () => {
    it('atualiza antes de concluir login e cancelar não perde a conta criada', async () => {
      calls.create.mockResolvedValue({ path: '/home/user/.claude-work', label: 'Returned', active: false });
      const refresh = deferred<void>(), changed = vi.fn(() => refresh.promise), close = vi.fn();
      const { root, container } = mount();
      try {
        await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: changed, onClose: close })));
        await input(container, 'work'); await click(container, m.comum_criar());
        expect(changed).toHaveBeenCalledTimes(1);
        expect(calls.start).toHaveBeenCalledWith(server, 'Returned'); expect(container.textContent).toContain(waiting.url);
        expect(calls.code).not.toHaveBeenCalled();
        await click(container, m.comum_cancelar());
        expect(close).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
        expect(calls.cancel).toHaveBeenCalledWith(server, 'Returned'); expect(calls.create).toHaveBeenCalledTimes(1);
      } finally { await act(async () => refresh.resolve()); }
    });

    it('resposta perdida solicita lista sem repetir criação nem iniciar login', async () => {
      calls.create.mockRejectedValue(new Error('creation response lost'));
      const { root, container } = mount(); const changed = vi.fn();
      await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: changed, onClose: vi.fn() })));
      await input(container, 'work'); await click(container, m.comum_criar());
      expect(changed).toHaveBeenCalledTimes(1); expect(container.textContent).toContain('creation response lost');
      await ticks(6000); await click(container, m.comum_criar());
      expect(calls.create).toHaveBeenCalledExactlyOnceWith(server, 'work'); expect(calls.start).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('usa callback capturado na ação mesmo se a prop mudar antes da resposta', async () => {
      const pending = deferred<{ path: string; label: string; active: boolean }>(); calls.create.mockReturnValueOnce(pending.promise);
      const { root, container } = mount(); const original = vi.fn(), replacement = vi.fn();
      await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: original, onClose: vi.fn() })));
      await input(container, 'work'); await click(container, m.comum_criar());
      await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: replacement, onClose: vi.fn() })));
      await act(async () => pending.resolve({ path: '/home/user/.claude-work', label: 'Returned', active: false }));
      expect(original).toHaveBeenCalledTimes(1); expect(replacement).not.toHaveBeenCalled();
      expect(calls.start).toHaveBeenCalledWith(server, 'Returned');
    });

    it.each(['throw', 'reject'])('falha de atualização %s avisa sem desfazer criação nem impedir login', async failure => {
      calls.create.mockResolvedValue({ path: '/home/user/.claude-work', label: 'Returned', active: false });
      const changed = vi.fn(() => {
        if (failure === 'throw') throw new Error('refresh unavailable');
        return Promise.reject(new Error('refresh unavailable'));
      });
      const { root, container } = mount();
      await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: changed, onClose: vi.fn() })));
      await input(container, 'work'); await click(container, m.comum_criar());
      expect(calls.alert).toHaveBeenCalledWith(`${m.criar_conta_lista_erro()}\nrefresh unavailable`);
      expect(calls.start).toHaveBeenCalledWith(server, 'Returned'); expect(container.textContent).toContain(waiting.url);
      expect(container.textContent).not.toContain('refresh unavailable');
      expect(calls.create).toHaveBeenCalledTimes(1);
    });

    it.each(['throw', 'reject'])('falha de atualização %s após resposta perdida não afirma conta criada', async failure => {
      calls.create.mockRejectedValue(new Error('creation response lost'));
      const changed = vi.fn(() => {
        if (failure === 'throw') throw new Error('refresh unavailable');
        return Promise.reject(new Error('refresh unavailable'));
      });
      const { root, container } = mount();
      await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: changed, onClose: vi.fn() })));
      await input(container, 'work'); await click(container, m.comum_criar());
      expect(calls.alert).toHaveBeenCalledWith(`${m.criar_conta_lista_falhou()}\nrefresh unavailable`);
      expect(container.textContent).toContain('creation response lost'); expect(container.textContent).not.toContain('refresh unavailable');
      await click(container, m.comum_criar());
      expect(calls.create).toHaveBeenCalledTimes(1); expect(calls.start).not.toHaveBeenCalled();
    });

    it.each(['servidor', 'unmount'])('resposta de criação após %s não chama callback antigo nem novo', async change => {
      const pending = deferred<{ path: string; label: string; active: boolean }>(); calls.create.mockReturnValueOnce(pending.promise);
      const { root, container } = mount(); const original = vi.fn(), next = vi.fn();
      await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: original, onClose: vi.fn() })));
      await input(container, 'work'); await click(container, m.comum_criar());
      if (change === 'servidor') await act(async () => root.render(createElement(ClaudeAccountCreate, { server: other, credentials: [], onChanged: next, onClose: vi.fn() })));
      else await unmount(root);
      await act(async () => pending.resolve({ path: '/home/user/.claude-work', label: 'Returned', active: false }));
      expect(original).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled(); expect(calls.alert).not.toHaveBeenCalled();
      expect(calls.start).not.toHaveBeenCalled();
    });

    it.each(['servidor', 'unmount'])('falha tardia da atualização após %s não mostra alerta nem chama callback novo', async change => {
      calls.create.mockResolvedValue({ path: '/home/user/.claude-work', label: 'Returned', active: false });
      const refresh = deferred<void>(), original = vi.fn(() => refresh.promise), next = vi.fn();
      const { root, container } = mount();
      try {
        await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: original, onClose: vi.fn() })));
        await input(container, 'work'); await click(container, m.comum_criar());
        expect(original).toHaveBeenCalledTimes(1);
        if (change === 'servidor') await act(async () => root.render(createElement(ClaudeAccountCreate, { server: other, credentials: [], onChanged: next, onClose: vi.fn() })));
        else await unmount(root);
        await act(async () => refresh.reject(new Error('late refresh failure')));
        expect(calls.alert).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
        expect(calls.start).not.toHaveBeenCalledWith(other, 'Returned');
      } finally { await act(async () => refresh.resolve()); }
    });
  });

  it('cria uma vez e repete o login na conta retornada sem criar outra pasta', async () => {
    calls.create.mockResolvedValue({ path: '/home/user/.claude-work', label: 'Returned', active: false });
    calls.start.mockRejectedValueOnce(new Error('login start failed'));
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: vi.fn(), onClose: vi.fn() })));
    await input(container, 'work'); await click(container, m.comum_criar());
    expect(calls.create).toHaveBeenCalledExactlyOnceWith(server, 'work');
    expect(container.textContent).toContain('login start failed');
    await click(container, m.novacred_codex_tentar());
    expect(calls.start).toHaveBeenLastCalledWith(server, 'Returned'); expect(calls.create).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(waiting.url);
  });

  it('oferece entrar na padrão deslogada sem obrigar outra pasta', async () => {
    const base: Credencial = { ...credential, id: 'claude:/home/user/.claude', nome: 'Padrão', nome_natural: 'base-label', login: { estado: 'ok', loggedIn: false } };
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [base], onChanged: vi.fn(), onClose: vi.fn() })));
    expect(container.textContent).toContain(m.novacred_base_deslogada({ nome: 'Padrão' }));
    await click(container, m.novacred_entrar_base({ nome: 'Padrão' }));
    expect(calls.start).toHaveBeenCalledWith(server, 'base-label'); expect(calls.create).not.toHaveBeenCalled();
  });

  it.each(['Invalid Name', '_invalid', 'a'.repeat(33), ''])('valida nome antes de criar %s', async name => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: vi.fn(), onClose: vi.fn() })));
    await input(container, name); await click(container, m.comum_criar());
    expect(container.textContent).toContain(m.erro_conta_nome_invalido()); expect(calls.create).not.toHaveBeenCalled();
  });

  it('Criar e Cancelar no mesmo evento não fecham a criação em voo', async () => {
    const pending = deferred<{ path: string; label: string; active: boolean }>(); calls.create.mockReturnValueOnce(pending.promise);
    const { root, container } = mount(); const close = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: vi.fn(), onClose: close })));
    await input(container, 'work');
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => {
      buttons.find(b => b.textContent === m.comum_criar())!.click();
      buttons.find(b => b.textContent === m.comum_cancelar())!.click();
    });
    expect(close).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ path: '/home/user/.claude-work', label: 'Returned', active: false }));
    expect(calls.start).toHaveBeenCalledWith(server, 'Returned');
  });

  it('login já aberto da conta criada não inicia na outra máquina ao trocar servidor', async () => {
    calls.create.mockResolvedValue({ path: '/home/user/.claude-work', label: 'Returned', active: false });
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: vi.fn(), onClose: vi.fn() })));
    await input(container, 'work'); await click(container, m.comum_criar());
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server: other, credentials: [], onChanged: vi.fn(), onClose: vi.fn() })));
    expect(calls.start).not.toHaveBeenCalledWith(other, 'Returned');
    expect(calls.start).toHaveBeenCalledTimes(1);
  });

  it('resposta perdida na criação mostra causa sem repetição, inclusive por toque duplo', async () => {
    const pending = deferred<never>(); calls.create.mockReturnValueOnce(pending.promise);
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: vi.fn(), onClose: vi.fn() })));
    await input(container, 'work'); await click(container, m.comum_criar());
    expect(container.querySelector('section')!.dataset.dismissible).toBe('false');
    await click(container, m.comum_criar());
    await act(async () => pending.reject(new Error('response lost')));
    expect(container.textContent).toContain('response lost'); await ticks(6000);
    await click(container, m.comum_criar()); expect(calls.create).toHaveBeenCalledTimes(1); expect(calls.start).not.toHaveBeenCalled();
  });

  it('criação que responde depois da troca não autentica a máquina nova', async () => {
    const pending = deferred<{ path: string; label: string; active: boolean }>(); calls.create.mockReturnValueOnce(pending.promise);
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server, credentials: [], onChanged: vi.fn(), onClose: vi.fn() })));
    await input(container, 'work'); await click(container, m.comum_criar());
    await act(async () => root.render(createElement(ClaudeAccountCreate, { server: other, credentials: [], onChanged: vi.fn(), onClose: vi.fn() })));
    await act(async () => pending.resolve({ path: '/home/user/.claude-work', label: 'work', active: false }));
    expect(calls.start).not.toHaveBeenCalled(); expect(container.textContent).toContain(m.contas_login_servidor({ nome: 'C' }));
  });
});

describe('ClaudeAccountLogin', () => {
  it('abre automaticamente, mantém link e código e confirma somente o código enviado sem espaços', async () => {
    const { root, container } = mount(); const complete = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'Alias', onComplete: complete, onClose: vi.fn() })));
    expect(container.textContent).toContain('https://auth.example/authorize');
    expect(calls.start).toHaveBeenCalledWith(server, 'Alias');
    expect(calls.read).toHaveBeenCalledWith(server, 'Alias', expect.any(AbortSignal));
    expect(complete).not.toHaveBeenCalled();
    const field = container.querySelector('textarea')!;
    expect(field.dataset.secure).toBe('true'); expect(field.dataset.capitalize).toBe('none');
    await input(container, '  secret-code  ');
    await click(container, m.contas_login_abrir()); await click(container, m.contas_login_copiar_link());
    expect(calls.open).toHaveBeenCalledWith('https://auth.example/authorize');
    expect(calls.copy).toHaveBeenCalledWith('https://auth.example/authorize');
    await click(container, m.contas_confirmar_codigo());
    expect(calls.code).toHaveBeenCalledWith(server, 'Alias', 'secret-code');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('a@example.com');
    await unmount(root); expect(calls.cancel).not.toHaveBeenCalled();
  });

  it('conclui pelo callback do navegador ao voltar ao app sem enviar código', async () => {
    const { root, container } = mount(); const complete = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: complete, onClose: vi.fn() })));
    calls.read.mockResolvedValue(completed);
    await act(async () => calls.foreground?.('active'));
    expect(container.textContent).toContain('a@example.com'); expect(complete).toHaveBeenCalledTimes(1);
    await ticks(6000); expect(complete).toHaveBeenCalledTimes(1); expect(calls.code).not.toHaveBeenCalled();
    await unmount(root); expect(calls.removeListener).toHaveBeenCalled(); expect(calls.cancel).not.toHaveBeenCalled();
  });

  it('consulta a cada dois segundos, para no erro de rede e só repete leitura a pedido', async () => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    await ticks(1999); expect(calls.read).toHaveBeenCalledTimes(1);
    calls.read.mockRejectedValueOnce(new Error('network unavailable'));
    await ticks(1); expect(container.textContent).toContain('network unavailable');
    await ticks(6000); expect(calls.read).toHaveBeenCalledTimes(2);
    await click(container, m.contas_atualizar()); expect(calls.read).toHaveBeenCalledTimes(3);
    expect(calls.start).toHaveBeenCalledTimes(1);
  });

  it('mostra falha de abrir/copiar sem perder link e código', async () => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    await input(container, 'keep-code');
    calls.open.mockRejectedValueOnce(new Error('browser blocked')); calls.copy.mockRejectedValueOnce(new Error('clipboard failed'));
    await click(container, m.contas_login_abrir()); expect(container.textContent).toContain('browser blocked');
    await click(container, m.contas_login_copiar_link()); expect(container.textContent).toContain('clipboard failed');
    expect(container.textContent).toContain(waiting.url); expect(container.querySelector('textarea')!.value).toBe('keep-code');
  });

  it.each(['http://auth.example', 'https://user:pass@auth.example', 'javascript:alert(1)'])('não abre nem copia URL insegura %s', async url => {
    calls.read.mockResolvedValue({ ...waiting, url });
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    await click(container, m.contas_login_abrir()); await click(container, m.contas_login_copiar_link());
    expect(calls.open).not.toHaveBeenCalled(); expect(calls.copy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Link de autorização inválido.');
  });

  it.each(['abc\nxyz', 'abc\rxyz', 'abc\0xyz', 'a'.repeat(4097), '   '])('recusa código inválido sem POST (%#)', async value => {
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    await input(container, value); await click(container, m.contas_confirmar_codigo());
    expect(calls.code).not.toHaveBeenCalled(); expect(container.textContent).toContain('Código inválido.');
  });

  it('código em voo bloqueia swipe e segundo envio, e falha mantém código para leitura manual', async () => {
    const pending = deferred<{ ok: boolean }>(); calls.code.mockReturnValueOnce(pending.promise);
    const { root, container } = mount(); const complete = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: complete, onClose: vi.fn() })));
    await input(container, 'code');
    await click(container, m.contas_confirmar_codigo()); await click(container, m.contas_confirmar_codigo());
    expect(calls.code).toHaveBeenCalledTimes(1); expect(container.querySelector('section')!.dataset.dismissible).toBe('false');
    await act(async () => pending.reject(new Error('code response lost')));
    expect(container.textContent).toContain('code response lost'); expect(container.querySelector('textarea')!.value).toBe('code');
    await ticks(5000); expect(calls.code).toHaveBeenCalledTimes(1); expect(complete).not.toHaveBeenCalled();
    calls.read.mockResolvedValueOnce(completed); await click(container, m.contas_atualizar()); expect(complete).toHaveBeenCalledTimes(1);
  });

  it('cancel ok false conserva tentativa e não fecha', async () => {
    calls.cancel.mockResolvedValueOnce({ ok: false });
    const { root, container } = mount(); const close = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: close })));
    await click(container, m.comum_cancelar()); expect(close).not.toHaveBeenCalled(); expect(container.textContent).toContain(waiting.url);
    expect(container.textContent).toContain(m.contas_login_nao_confirmado());
    await click(container, m.comum_cancelar()); expect(close).toHaveBeenCalledTimes(1);
  });

  it('leitura antiga abortada não conclui a conta da nova máquina', async () => {
    const pending = deferred<typeof completed>(); calls.read.mockReturnValueOnce(pending.promise);
    const { root, container } = mount(); const complete = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: complete, onClose: vi.fn() })));
    const signal = calls.read.mock.calls[0][2] as AbortSignal;
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server: other, label: 'work', onComplete: complete, onClose: vi.fn() })));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(completed));
    expect(complete).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('a@example.com');
  });

  it('POST não confirmado não conclui nem se repete automaticamente', async () => {
    calls.code.mockResolvedValue({ ok: false });
    const { root, container } = mount(); const complete = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: complete, onClose: vi.fn() })));
    await input(container, 'code'); await click(container, m.contas_confirmar_codigo());
    expect(complete).not.toHaveBeenCalled(); expect(container.textContent).toContain(m.contas_login_nao_confirmado());
    await ticks(8000); expect(calls.code).toHaveBeenCalledTimes(1);
  });

  it('cancelamento que falha conserva tentativa e recomeçar só abre após cancelar de verdade', async () => {
    const { root, container } = mount(); const close = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: close })));
    calls.cancel.mockRejectedValueOnce(new Error('cancel failed'));
    await click(container, m.comum_cancelar());
    expect(close).not.toHaveBeenCalled(); expect(container.textContent).toContain('cancel failed'); expect(container.textContent).toContain(waiting.url);
    const pending = deferred<{ ok: boolean }>(); calls.cancel.mockReturnValueOnce(pending.promise);
    await click(container, m.novacred_codex_tentar());
    expect(calls.start).toHaveBeenCalledTimes(1); expect(container.querySelector('section')!.dataset.dismissible).toBe('false');
    await act(async () => pending.resolve({ ok: true }));
    expect(calls.start).toHaveBeenCalledTimes(2);
  });

  it('swipe com falha ao cancelar reapresenta a tentativa com causa e cancelamento repetível', async () => {
    const { root, container } = mount(); const close = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: close })));
    calls.cancel.mockRejectedValueOnce(new Error('swipe cancel failed'));
    await click(container, 'dismiss-sheet');
    expect(container.textContent).toContain('swipe cancel failed'); expect(container.textContent).toContain(waiting.url);
    expect(close).not.toHaveBeenCalled();
    await click(container, m.comum_cancelar()); expect(close).toHaveBeenCalledTimes(1);
  });

  it('idle e 409 encerram polling com causa e permitem recomeçar explicitamente', async () => {
    calls.read.mockResolvedValueOnce({ ...waiting, etapa: 'idle', url: null });
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    expect(container.textContent).toContain(m.erro_login_sem_tentativa());
    await ticks(5000); expect(calls.read).toHaveBeenCalledTimes(1);
    calls.read.mockRejectedValueOnce(Object.assign(new Error('409: attempt ended'), { status: 409 }));
    await click(container, m.novacred_codex_tentar());
    expect(container.textContent).toContain('409: attempt ended');
    await act(async () => calls.foreground?.('active')); await ticks(5000);
    expect(calls.read).toHaveBeenCalledTimes(2);
  });

  it('trocar servidor durante abertura limpa o original e não cancela a tentativa nova', async () => {
    const pending = deferred<{ ok: boolean }>(); calls.start.mockReturnValueOnce(pending.promise);
    const { root, container } = mount(); const complete = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: complete, onClose: vi.fn() })));
    expect(container.querySelector('section')!.dataset.dismissible).toBe('false');
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server: other, label: 'work', onComplete: complete, onClose: vi.fn() })));
    expect(calls.start).toHaveBeenCalledWith(other, 'work'); expect(calls.cancel).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ ok: true }));
    expect(calls.cancel).toHaveBeenCalledWith(server, 'work'); expect(calls.cancel).not.toHaveBeenCalledWith(other, 'work');
    expect(complete).not.toHaveBeenCalled(); expect(container.textContent).toContain(m.contas_login_servidor({ nome: 'C' }));
  });

  it('mesma máquina com novo endereço e token espera cleanup original antes de abrir de novo', async () => {
    const pending = deferred<{ ok: boolean }>(), cleanup = deferred<{ ok: boolean }>();
    calls.start.mockReturnValueOnce(pending.promise); calls.cancel.mockReturnValueOnce(cleanup.promise);
    const moved = { ...server, baseUrl: 'https://b-new.local', token: 'new-token' };
    const first = mount();
    await act(async () => first.root.render(createElement(ClaudeAccountLogin, { server, label: 'moved', onComplete: vi.fn(), onClose: vi.fn() })));
    await unmount(first.root);
    const next = mount();
    try {
      await act(async () => next.root.render(createElement(ClaudeAccountLogin, { server: moved, label: 'moved', onComplete: vi.fn(), onClose: vi.fn() })));
      expect(calls.start).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve({ ok: true }));
      expect(calls.cancel).toHaveBeenCalledWith(server, 'moved'); expect(calls.start).toHaveBeenCalledTimes(1);
      await act(async () => cleanup.resolve({ ok: true }));
      expect(calls.start).toHaveBeenCalledTimes(2); expect(calls.start).toHaveBeenLastCalledWith(moved, 'moved');
      expect(calls.cancel).not.toHaveBeenCalledWith(moved, 'moved');
    } finally { await act(async () => { pending.resolve({ ok: true }); cleanup.resolve({ ok: true }); }); }
  });

  it('remontagem da mesma conta espera limpeza da abertura antiga', async () => {
    const pending = deferred<{ ok: boolean }>(); calls.start.mockReturnValueOnce(pending.promise);
    const first = mount();
    await act(async () => first.root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    await unmount(first.root);
    const cleanup = deferred<{ ok: boolean }>(); calls.cancel.mockReturnValueOnce(cleanup.promise);
    const next = mount();
    await act(async () => next.root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    await act(async () => pending.resolve({ ok: true }));
    expect(calls.start).toHaveBeenCalledTimes(1); expect(calls.cancel).toHaveBeenCalledTimes(1);
    await act(async () => cleanup.resolve({ ok: true })); expect(calls.start).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('código pendente no servidor antigo (%s) nunca cancela o novo login', async confirmed => {
    const code = deferred<{ ok: boolean }>(); calls.code.mockReturnValueOnce(code.promise);
    const first = mount(); const complete = vi.fn();
    await act(async () => first.root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: complete, onClose: vi.fn() })));
    await input(first.container, 'code'); await click(first.container, m.contas_confirmar_codigo());
    await unmount(first.root);
    const next = mount();
    await act(async () => next.root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    expect(calls.start).toHaveBeenCalledTimes(1);
    await act(async () => code.resolve({ ok: confirmed }));
    expect(calls.start).toHaveBeenCalledTimes(2); expect(calls.cancel).toHaveBeenCalledTimes(confirmed ? 0 : 1);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([true, false])('troca de máquina com código pendente confirmado=%s limpa só a origem', async confirmed => {
    const pending = deferred<{ ok: boolean }>(); calls.code.mockReturnValueOnce(pending.promise);
    const { root, container } = mount(); const complete = vi.fn();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: complete, onClose: vi.fn() })));
    await input(container, 'code'); await click(container, m.contas_confirmar_codigo());
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server: other, label: 'work', onComplete: complete, onClose: vi.fn() })));
    expect(calls.start).toHaveBeenLastCalledWith(other, 'work'); expect(calls.cancel).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ ok: confirmed }));
    if (confirmed) expect(calls.cancel).not.toHaveBeenCalled();
    else expect(calls.cancel).toHaveBeenCalledExactlyOnceWith(server, 'work');
    expect(calls.cancel).not.toHaveBeenCalledWith(other, 'work'); expect(complete).not.toHaveBeenCalled();
  });

  it('falha de atualizar após entrar não oculta a conta conectada', async () => {
    calls.read.mockResolvedValueOnce(completed);
    const { root, container } = mount();
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work',
      onComplete: () => Promise.reject(new Error('refresh unavailable')), onClose: vi.fn() })));
    expect(container.textContent).toContain('a@example.com');
    expect(container.textContent).toContain(m.contas_login_atualizar_erro());
    expect(container.textContent).toContain('refresh unavailable');
    await unmount(root); expect(calls.cancel).not.toHaveBeenCalled();
  });

  it('falha de cleanup no unmount fica visível em alerta com a máquina original', async () => {
    const { root } = mount(); calls.cancel.mockRejectedValue(new Error('cleanup unavailable'));
    await act(async () => root.render(createElement(ClaudeAccountLogin, { server, label: 'work', onComplete: vi.fn(), onClose: vi.fn() })));
    await unmount(root);
    expect(calls.alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('cleanup unavailable'));
    expect(calls.alert.mock.calls[0][1]).toContain('B');
  });
});
