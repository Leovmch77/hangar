// @vitest-environment happy-dom
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi, configureLocale, localeAtual, type ChangedFile, type GitCommit, type SessionInfo } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const boundary = vi.hoisted(() => ({
  fetch: vi.fn(), alert: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: true,
  selection: vi.fn(), notification: vi.fn(), header: {} as Record<string, any>,
  params: { server: 'route-b', name: 'fixture-session' },
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => boundary.params,
  useRouter: () => ({ back: boundary.back, replace: boundary.replace, canGoBack: () => boundary.canGoBack }),
  Stack: { Screen: ({ options }: any) => { boundary.header = options; return null; } },
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 64 }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }));
vi.mock('expo-blur', () => ({ BlurView: () => null }));
vi.mock('expo-glass-effect', () => ({ GlassView: () => null, isLiquidGlassAvailable: () => false }));
vi.mock('expo-haptics', async (original) => ({ ...await original<typeof import('expo-haptics')>(), selectionAsync: boundary.selection, notificationAsync: boundary.notification }));
vi.mock('react-native-safe-area-context', async (original) => ({ ...await original<typeof import('react-native-safe-area-context')>(), useSafeAreaInsets: () => ({ top: 20, bottom: 24, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', async () => {
  const { View } = await import('react-native');
  return { KeyboardAvoidingView: ({ automaticOffset, behavior, style, ...props }: any) => createElement(View, { ...props, style: [style, { paddingBottom: 0 }], 'data-keyboard': behavior, 'data-automatic-offset': !!automaticOffset }) };
});
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return { ...actual, Alert: { alert: boundary.alert },
    ScrollView: ({ nestedScrollEnabled, contentContainerStyle, ...props }: any) => createElement(actual.ScrollView, { ...props, 'data-scroll': true, 'data-content-padding-horizontal': contentContainerStyle?.paddingHorizontal }),
    Text: ({ selectable, ellipsizeMode, numberOfLines, style, ...props }: any) => {
      const textStyle = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style;
      return createElement(actual.Text, { ...props, style, 'data-selectable': !!selectable, 'data-lines': numberOfLines, 'data-ellipsis': ellipsizeMode, 'data-padding-horizontal': textStyle?.paddingHorizontal ?? textStyle?.padding });
    },
    Pressable: ({ accessibilityState, accessibilityHint, ...props }: any) => createElement(actual.Pressable, { ...props, 'aria-checked': accessibilityState?.checked, 'aria-selected': accessibilityState?.selected }),
    TextInput: ({ onChangeText, accessibilityLabel, value, editable, ...props }: any) => createElement('textarea', {
      'aria-label': accessibilityLabel, value: value ?? '', disabled: editable === false,
      onInput: (event: React.FormEvent<HTMLTextAreaElement>) => onChangeText?.(event.currentTarget.value),
    }),
  };
});
import { Platform } from 'react-native';
import GitRoute from '../../../app/s/[server]/[name]/git';
import { GitPanel } from './GitPanel';
import { useServers } from '../../stores/servers';
import * as m from '../../paraglide/messages';
import { getLocale, overwriteGetLocale } from '../../paraglide/runtime';
const server = { id: 'route-b', label: 'fixture-route-b', baseUrl: 'https://route-b.test', token: 'token-b' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const changed = (path: string, staged = false): ChangedFile => ({ path, staged, code: staged ? 'M ' : ' M', added: 2, removed: 1 });
const committed = (index: number): GitCommit => ({ hash: index.toString(16).padStart(40, '0'), short: index.toString(16).padStart(7, '0'), parents: [], refs: '', author: 'fixture-author', ts: 1700000000, rel: 'fixture-date', subject: `fixture-history-${index}`, body: '', local: true });
let session: SessionInfo | null;
let files: ChangedFile[];
let branches: { current: string; branches: string[]; dirty: boolean; elsewhere?: Record<string, { path: string; main: boolean }> };
let root: Root;
let el: HTMLDivElement;
let mounted: boolean;
const reads = () => boundary.fetch.mock.calls.filter(([url, init]) => !init?.method && new URL(String(url)).pathname !== '/api/sessions');
const writes = () => boundary.fetch.mock.calls.filter(([url, init]) => init?.method === 'POST' && !String(url).endsWith('/git/diff'));
const button = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label);
async function click(label: string) { expect(button(label), label).toBeTruthy(); await act(async () => button(label)!.click()); }
async function fill(label: string, value: string) {
  const input = [...el.querySelectorAll('textarea')].find((x) => x.getAttribute('aria-label') === label);
  expect(input, label).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true })); });
}
const accept = () => boundary.alert.mock.calls.at(-1)![2].find((b: { style?: string }) => b.style !== 'cancel').onPress as () => void;
const render = () => act(async () => root.render(<GitRoute />));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function respond(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  if (init?.method === 'POST') return json({ ok: true, output: 'fixture-operation', current: 'next' });
  if (path === '/api/sessions') return json(session ? [session] : []);
  if (path.endsWith('/branches')) return json(branches);
  if (path.endsWith('/git/files')) return json({ files, sequencer: null });
  if (path.endsWith('/git/log')) return json({ commits: [], ahead: 2, behind: 3 });
  throw new Error(`unexpected-fetch:${url}`);
}
beforeEach(() => {
  boundary.fetch.mockReset().mockImplementation(respond); boundary.alert.mockReset(); boundary.back.mockReset(); boundary.replace.mockReset();
  boundary.selection.mockReset().mockResolvedValue(undefined); boundary.notification.mockReset().mockResolvedValue(undefined);
  boundary.header = {}; boundary.canGoBack = true;
  boundary.params = { server: server.id, name: 'fixture-session' };
  configureApi({ getBaseUrl: () => 'https://wrong-active.test', getToken: () => 'wrong-token', origin: null, onUnauthorized: vi.fn(), createEventSource: vi.fn() });
  vi.stubGlobal('fetch', boundary.fetch);
  session = { name: 'fixture-session', cwd: '/fixture/opening', git_cwd: '/fixture/repo-a', jsonl: '/fixture/life-a.jsonl', provider: 'claude', state: 'idle', headless: false };
  files = [changed('a.ts', true), changed('b.ts')];
  branches = { current: 'main', branches: ['main', 'next'], dirty: true };
  useServers.setState({ ready: true, servers: [server], activeId: 'wrong-active' });
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); mounted = true;
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); el.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('iOS Git', () => {
  beforeEach(() => { Platform.OS = 'ios'; });
  afterEach(() => { Platform.OS = 'android'; });

  it('usa cabeçalho nativo e mantém os controles abaixo dele com compensação do teclado', async () => {
    await render();
    expect(boundary.header).toMatchObject({ headerShown: true, headerTransparent: true, headerBackButtonDisplayMode: 'minimal', title: m.sessao_git() });
    expect(boundary.header.headerBackground).toBeTypeOf('function');
    expect(boundary.header.headerLeft).toBeUndefined();
    expect(button(m.comum_voltar())).toBeUndefined();
    const content = button(m.native_git_reload())?.closest<HTMLElement>('[data-keyboard]');
    expect(content?.style.paddingTop).toBe('64px');
    expect(content?.style.paddingBottom).toBe('0px');
    expect(content?.getAttribute('data-keyboard')).toBe('padding');
    expect(content?.getAttribute('data-automatic-offset')).toBe('true');
    expect(button(m.native_git_commit())).toBeTruthy();
  });

  it('preserva inset do composer em View interna quando teclado sobrescreve padding animado', async () => {
    await render();
    const input = el.querySelector('textarea')!;
    const keyboard = input.closest<HTMLElement>('[data-keyboard]')!;
    expect(keyboard.style.paddingBottom).toBe('0px');
    const content = [...keyboard.children].find((node) => node.contains(input)) as HTMLElement;
    expect(content.style.paddingBottom).toBe('24px');
    expect(content.style.flex).toBe('1 1 0%');
    expect(content.parentElement).toBe(keyboard);
    expect(content.contains(button(m.native_git_reload())!)).toBe(true);
  });

  it('vibra ao trocar aba e marcar arquivo, não ao tocar a aba já selecionada', async () => {
    await render();
    expect(boundary.selection).not.toHaveBeenCalled();
    await click(m.git_aba_branches());
    expect(boundary.selection).toHaveBeenCalledTimes(1);
    await click(m.git_aba_branches());
    expect(boundary.selection).toHaveBeenCalledTimes(1);
    await click(m.native_git_changes());
    expect(boundary.selection).toHaveBeenCalledTimes(2);
    await click(m.native_git_include({ path: 'a.ts' }));
    expect(button(m.native_git_include({ path: 'a.ts' }))?.getAttribute('aria-checked')).toBe('false');
    expect(boundary.selection).toHaveBeenCalledTimes(3);
    await click(m.native_git_include({ path: 'a.ts' }));
    expect(boundary.selection).toHaveBeenCalledTimes(4);
    expect(boundary.notification).not.toHaveBeenCalled();
  });

  it('vibra ao escolher arquivo e commit sem vibrar quando o diff termina de carregar', async () => {
    const item = committed(1); const diff = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/diff') || String(url).endsWith('/diff-full')) return diff.promise.then((response) => response.clone());
      if (String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1') return json({ commits: [item], ahead: null, behind: null });
      return respond(url, init);
    });
    await render(); await click('a.ts');
    expect(boundary.selection).toHaveBeenCalledTimes(1);
    await act(async () => diff.resolve(json({ diff: '+fixture-diff', truncated: false })));
    expect(el.textContent).toContain('+fixture-diff');
    expect(boundary.selection).toHaveBeenCalledTimes(1);
    await click(m.native_git_history());
    expect(boundary.selection).toHaveBeenCalledTimes(2);
    await click(m.git_titulo_commit({ short: item.short, subject: item.subject }));
    expect(el.textContent).toContain('+fixture-diff');
    expect(boundary.selection).toHaveBeenCalledTimes(3);
    expect(boundary.notification).not.toHaveBeenCalled();
  });

  it.each([true, false])('notifica o resultado da operação ok:%s uma vez, sem repetir na releitura', async (ok) => {
    await render(); await fill(m.native_git_message(), 'fixture-haptic-commit');
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/commit') ? json({ ok, output: 'fixture-operation-result' }) : respond(url, init));
    await click(m.native_git_commit());
    expect(el.textContent).toContain(ok ? m.native_git_committed() : 'fixture-operation-result');
    expect(boundary.notification).toHaveBeenCalledExactlyOnceWith(ok ? 'success' : 'error');
    await click(m.native_git_reload());
    expect(boundary.notification).toHaveBeenCalledTimes(1);
  });

  it('notifica a recusa local de checkout sem enviar operação', async () => {
    await render(); await click(m.git_aba_branches()); await click('next');
    expect(el.textContent).toContain(m.git_working_tree_suja());
    expect(boundary.notification).toHaveBeenCalledExactlyOnceWith('error');
    expect(writes()).toHaveLength(0);
  });

  it('não vibra por leituras, falha de leitura, status ou confirmação cancelada', async () => {
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/files') ? json({ detail: 'fixture-read-refused' }, 503) : respond(url, init));
    await render();
    expect(el.textContent).toContain('fixture-read-refused');
    boundary.fetch.mockImplementation(respond); await click(m.native_git_reload());
    await click(m.mobile_git_status());
    expect(el.textContent).toContain('fixture-operation');
    await click(m.native_git_push());
    await act(async () => boundary.alert.mock.calls.at(-1)![2].find((b: { style: string }) => b.style === 'cancel').onPress());
    expect(boundary.selection).not.toHaveBeenCalled();
    expect(boundary.notification).not.toHaveBeenCalled();
  });

  it('não notifica resultado atrasado depois de sair da rota', async () => {
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/commit') ? pending.promise : respond(url, init));
    await render(); await fill(m.native_git_message(), 'fixture-late-commit'); await click(m.native_git_commit());
    await act(async () => root.unmount()); mounted = false;
    await act(async () => pending.resolve(json({ ok: true })));
    expect(boundary.notification).not.toHaveBeenCalled();
  });

  it.each(['pt', 'en'] as const)('volta do diff para arquivos com um único chevron e sem seta no texto em %s', async (locale) => {
    const previous = getLocale(); overwriteGetLocale(() => locale);
    try {
      boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/diff') ? json({ diff: '+fixture-back-diff', truncated: false }) : respond(url, init));
      await render(); await click('a.ts');
      const back = button(m.arq_aba());
      expect(back?.textContent).toBe(m.arq_aba());
      expect(back?.querySelectorAll('[data-symbol]')).toHaveLength(1);
      expect(back?.querySelector('[data-symbol]')?.getAttribute('data-symbol')).toBe('chevron.left');
      await click(m.arq_aba());
      expect(button('a.ts')).toBeTruthy();
      expect(el.textContent).not.toContain('+fixture-back-diff');
    } finally { overwriteGetLocale(() => previous); }
  });

  it('desenha os símbolos iOS de arquivo marcado e desmarcado', async () => {
    await render();
    expect(button(m.native_git_include({ path: 'a.ts' }))?.querySelector('[data-symbol="checkmark.square"]')).toBeTruthy();
    await click(m.native_git_include({ path: 'a.ts' }));
    expect(button(m.native_git_include({ path: 'a.ts' }))?.querySelector('[data-symbol="square"]')).toBeTruthy();
  });
});

describe('Git pela rota explícita', () => {
  it.each(['android', 'ios'] as const)('compensa teclado com padding e offset automático no %s', async (platform) => {
    const previous = Platform.OS;
    try {
      Platform.OS = platform;
      await render();
      const content = button(m.native_git_reload())?.closest<HTMLElement>('[data-automatic-offset]');
      expect(content?.getAttribute('data-keyboard')).toBe('padding');
      expect(content?.getAttribute('data-automatic-offset')).toBe('true');
      expect(content?.style.paddingTop).toBe('64px');
      expect(content?.style.paddingBottom).toBe('0px');
    } finally { Platform.OS = previous; }
  });

  it('aguarda o cofre e carrega apenas o destino da rota, sem montar histórico oculto', async () => {
    useServers.setState({ ready: false });
    await render(); expect(boundary.fetch).not.toHaveBeenCalled(); expect(el.textContent).toContain(m.native_git_loading());
    await act(async () => useServers.setState({ ready: true }));
    expect(el.textContent).toContain('a.ts');
    expect(el.textContent).toContain(m.native_git_ahead({ n: 2 }));
    expect(el.textContent).toContain(m.native_git_behind({ n: 3 }));
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(1);
    for (const [url, init] of boundary.fetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/route-b.test\/api\/sessions(?:$|\/fixture-session\/)/);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-b');
    }
    expect(boundary.fetch.mock.calls.some(([url]) => String(url).includes('/git/log?n=1'))).toBe(true);
  });

  it.each(['repo', 'file', 'history', 'commit', 'write'] as const)('resume erro técnico de %s e mantém diagnóstico selecionável menor', async (kind) => {
    const item = committed(1);
    const detail = kind === 'repo' ? 'fatal: not a git repository (or any of the parent directories): .git' : `fatal: fixture-${kind}-failed`;
    boundary.fetch.mockImplementation((url, init) => {
      const path = new URL(String(url)).pathname;
      if (kind === 'repo' && path.endsWith('/branches')) return json({ detail }, 500);
      if (kind === 'file' && path.endsWith('/git/diff') || kind === 'commit' && path.endsWith('/diff-full')) return json({ detail }, 500);
      if (path.endsWith('/git/log') && new URL(String(url)).searchParams.get('n') !== '1') return kind === 'history' ? json({ detail }, 500) : json({ commits: [item], ahead: null, behind: null });
      if (kind === 'write' && path.endsWith('/git/commit')) return json({ ok: false, output: detail });
      return respond(url, init);
    });
    await render();
    if (kind === 'file') await click('a.ts');
    if (kind === 'history' || kind === 'commit') await click(m.native_git_history());
    if (kind === 'commit') await click(m.git_titulo_commit({ short: item.short, subject: item.subject }));
    if (kind === 'write') { await fill(m.native_git_message(), 'fixture-failed-commit'); await click(m.native_git_commit()); }
    const summary = kind === 'repo' ? m.native_git_not_repo() : m.mobile_git_operation_failed();
    const alerts = el.querySelectorAll<HTMLElement>('[role="alert"]');
    expect([...alerts].map((node) => node.textContent)).toEqual([summary]);
    const diagnostic = [...el.querySelectorAll<HTMLElement>('[data-selectable="true"]')].find((node) => node.textContent?.includes(detail) && node.childElementCount === 0)!;
    expect(diagnostic?.textContent).toContain(detail);
    expect(parseFloat(diagnostic.style.fontSize)).toBeLessThan(parseFloat(alerts[0].style.fontSize));
    expect(diagnostic.closest('[data-scroll="true"]')).toBeTruthy();
  });

  it.each(['changes', 'history', 'branches'] as const)('explica repo indisponível no conteúdo de %s sem vazio falso nem histórico oculto', async (tab) => {
    const labels = { changes: m.native_git_changes(), history: m.native_git_history(), branches: m.git_aba_branches() };
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/branches') ? json({ detail: 'fatal: not a git repository' }, 400) : respond(url, init));
    await render(); await click(labels[tab]);
    const activeTab = [...el.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.getAttribute('aria-selected') === 'true')!;
    expect(activeTab.getAttribute('aria-label')).toBe(labels[tab]);
    const alerts = el.querySelectorAll('[role="alert"]');
    expect([...alerts].map((node) => node.textContent)).toEqual([m.native_git_not_repo()]);
    expect(activeTab.compareDocumentPosition(alerts[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.textContent).not.toContain(m.native_git_no_commits());
    expect(el.textContent).not.toContain(m.native_git_no_branch());
    expect(el.textContent).not.toContain(m.native_git_clean());
    expect(boundary.fetch.mock.calls.some(([url]) => String(url).includes('/git/log'))).toBe(false);
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/files') ? pending.promise : respond(url, init));
    await click(m.native_git_reload());
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain(m.native_git_loading());
    expect(el.textContent).not.toContain(m.native_git_no_commits());
    expect(el.textContent).not.toContain(m.native_git_no_branch());
    await act(async () => pending.resolve(json({ files, sequencer: null })));
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label')).toBe(labels[tab]);
    if (tab === 'changes') expect(button('a.ts')).toBeTruthy();
    if (tab === 'branches') expect(button('next')).toBeTruthy();
    if (tab === 'history') expect(el.textContent).toContain(m.native_git_no_commits());
  });

  it('não duplica a falha do repo com uma falha de histórico na releitura', async () => {
    await render(); await click(m.native_git_history());
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/files') || String(url).includes('/git/log')
      ? json({ detail: 'fatal: fixture-repo-offline' }, 503) : respond(url, init));
    await click(m.native_git_reload());
    expect([...el.querySelectorAll('[role="alert"]')].map((node) => node.textContent)).toEqual([m.mobile_git_operation_failed()]);
    expect(el.textContent).not.toContain(m.native_git_no_commits());
  });

  it('suspende diff com repo indisponível e recupera arquivo, rascunho e seleção ao reler', async () => {
    let offline = false;
    boundary.fetch.mockImplementation((url, init) => {
      const path = new URL(String(url)).pathname;
      if (offline && (path.endsWith('/branches') || path.endsWith('/git/diff'))) return json({ detail: 'fatal: not a git repository' }, 503);
      if (path.endsWith('/git/diff')) return json({ path: 'a.ts', diff: '+fixture-recovered-diff', truncated: false });
      return respond(url, init);
    });
    await render(); await fill(m.native_git_message(), 'fixture-offline-draft');
    await click(m.native_git_include({ path: 'b.ts' })); await click('a.ts');
    expect(el.textContent).toContain('+fixture-recovered-diff');
    offline = true; await click(m.native_git_reload());
    expect([...el.querySelectorAll('[role="alert"]')].map((node) => node.textContent)).toEqual([m.native_git_not_repo()]);
    for (const empty of [m.native_git_clean(), m.native_git_diff_empty(), m.native_git_no_commits(), m.native_git_no_branch()]) expect(el.textContent).not.toContain(empty);
    expect(el.textContent).not.toContain('+fixture-recovered-diff');
    const diffRequests = () => boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/git/diff'));
    const failedReads = diffRequests().length;
    await click(m.native_git_history()); await click(m.native_git_changes());
    expect(diffRequests()).toHaveLength(failedReads);
    offline = false; await click(m.native_git_reload());
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain('+fixture-recovered-diff');
    expect(JSON.parse(diffRequests().at(-1)![1].body)).toEqual({ path: 'a.ts' });
    expect(el.querySelector('textarea')).toBeNull();
    await click(m.arq_aba());
    expect(el.querySelector('textarea')?.value).toBe('fixture-offline-draft');
    expect(button(m.native_git_include({ path: 'a.ts' }))?.getAttribute('aria-checked')).toBe('true');
    expect(button(m.native_git_include({ path: 'b.ts' }))?.getAttribute('aria-checked')).toBe('false');
    expect(writes()).toHaveLength(0);
  });

  it.each(['history', 'branches'] as const)('mostra vazio real de %s somente depois da leitura bem-sucedida', async (tab) => {
    files = []; branches = { current: 'main', branches: [], dirty: false };
    await render(); await click(tab === 'history' ? m.native_git_history() : m.git_aba_branches());
    expect(el.textContent).toContain(tab === 'history' ? m.native_git_no_commits() : m.native_git_no_branch());
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).not.toContain(m.native_git_loading());
  });

  it('mostra erro de leitura selecionável e recupera ao reler sem fingir árvore limpa', async () => {
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/files') ? json({ detail: 'fixture-files-offline' }, 503) : respond(url, init));
    await render();
    expect(el.textContent).toContain('fixture-files-offline');
    expect(el.querySelector('[role="alert"][data-selectable="true"]')).toBeTruthy();
    expect(el.textContent).not.toContain(m.native_git_clean());
    boundary.fetch.mockImplementation(respond);
    await click(m.native_git_reload());
    expect(el.textContent).toContain('a.ts');
    expect(el.textContent).not.toContain('fixture-files-offline');
    files = []; branches.dirty = false;
    await click(m.native_git_reload());
    expect(el.textContent).toContain(m.native_git_clean());
  });

  it.each(['pt', 'en'] as const)('mostra estado traduzido sem código cru nem staging em %s', async (locale) => {
    const previous = getLocale(); overwriteGetLocale(() => locale);
    try {
      const cases = [
        [' ?? ', m.git_tag_novo], ['A ', m.git_tag_novo], ['AD', m.git_tag_novo], ['AU', m.git_tag_novo],
        [' D', m.git_tag_del], ['DU', m.git_tag_del], ['RD', m.git_tag_del],
        ['R ', m.git_tag_ren], ['RU', m.git_tag_ren], ['UU', m.git_tag_conflito],
        [' M', m.git_tag_mod], ['M ', m.git_tag_mod], [' T', m.git_tag_mod],
      ] as const;
      files = cases.map(([code], index) => ({ ...changed(`fixture-status-${index}.ts`, index % 2 === 0), code }));
      await render();
      for (const [index, [, label]] of cases.entries()) {
        const row = button(files[index].path)!.parentElement!;
        expect(row.lastElementChild?.firstElementChild?.textContent).toBe(label());
      }
    } finally { overwriteGetLocale(() => previous); }
  });

  it('marca ?? e A inicialmente e preserva desmarcados ao reler inclusive quando ?? vira A', async () => {
    files = [{ ...changed('fixture-untracked.ts'), code: '??' }, { ...changed('fixture-added.ts', true), code: 'A ' }];
    await render();
    for (const file of files) {
      expect(button(m.native_git_include({ path: file.path }))?.getAttribute('aria-checked')).toBe('true');
      await click(m.native_git_include({ path: file.path }));
    }
    await click(m.native_git_reload());
    for (const file of files) expect(button(m.native_git_include({ path: file.path }))?.getAttribute('aria-checked')).toBe('false');
    files = files.map((file) => ({ ...file, code: 'A ', staged: true }));
    await click(m.native_git_reload());
    for (const file of files) expect(button(m.native_git_include({ path: file.path }))?.getAttribute('aria-checked')).toBe('false');
    expect(el.textContent).toContain(m.native_git_picked({ n: 0, total: 2 }));
    expect(writes()).toHaveLength(0);
  });

  it('preserva desmarcados e seleção recente durante releitura e remove arquivos sumidos', async () => {
    await render();
    expect(button(m.native_git_include({ path: 'a.ts' }))?.getAttribute('aria-checked')).toBe('true');
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/files') ? pending.promise : respond(url, init));
    // A leitura antiga não pode capturar a seleção antes deste toque.
    await click(m.native_git_reload());
    await click(m.native_git_include({ path: 'a.ts' }));
    await act(async () => pending.resolve(json({ files: [changed('a.ts'), changed('c.ts')], sequencer: null })));
    expect(button(m.native_git_include({ path: 'a.ts' }))?.getAttribute('aria-checked')).toBe('false');
    expect(button(m.native_git_include({ path: 'c.ts' }))?.getAttribute('aria-checked')).toBe('true');
    expect(button(m.native_git_include({ path: 'b.ts' }))).toBeUndefined();
  });

  it('commita apenas os caminhos escolhidos, exige mensagem e bloqueia duplo toque síncrono', async () => {
    await render();
    expect(button(m.native_git_commit())?.disabled).toBe(true);
    await fill(m.native_git_message(), '  ');
    expect(button(m.native_git_commit())?.disabled).toBe(true);
    await click(m.native_git_include({ path: 'b.ts' }));
    await fill(m.native_git_message(), 'fixture-commit');
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/commit') ? pending.promise : respond(url, init));
    await act(async () => { button(m.native_git_commit())!.click(); button(m.native_git_commit())!.click(); });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('https://route-b.test/api/sessions/fixture-session/git/commit');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ message: 'fixture-commit', paths: ['a.ts'], amend: false, new_branch: null });
    files = [];
    await act(async () => pending.resolve(json({ ok: true, output: 'fixture-created' })));
    expect(el.textContent).toContain(m.native_git_committed());
    expect(el.querySelector('textarea')?.value).toBe('');
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(2);
  });

  it('mantém recusa ok:false visível e relê mesmo se a escrita alterou o stage', async () => {
    await render(); await fill(m.native_git_message(), 'fixture-commit');
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/commit') ? json({ ok: false, output: 'fixture-hook-refused' }) : respond(url, init));
    await click(m.native_git_commit());
    expect(el.textContent).toContain('fixture-hook-refused');
    expect(el.textContent).not.toContain(m.native_git_committed());
    expect(el.querySelector('[role="alert"][data-selectable="true"]')).toBeTruthy();
    expect(el.querySelector('textarea')?.value).toBe('fixture-commit');
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(2);
    expect(writes()).toHaveLength(1);
  });

  it('confirma publicação e diferencia commit feito de push falho, mesmo quando refresh falha', async () => {
    await render(); await fill(m.native_git_message(), 'fixture-publish');
    let committed = false;
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/commit')) { committed = true; return json({ ok: true, output: 'fixture-created' }); }
      if (String(url).endsWith('/git/push')) return json({ ok: false, output: 'fixture-push-refused' });
      if (committed && String(url).endsWith('/git/files')) return json({ detail: 'fixture-refresh-refused' }, 503);
      return respond(url, init);
    });
    await click(m.native_git_commit_push());
    expect(writes()).toHaveLength(0);
    const confirmed = accept();
    await act(async () => { confirmed(); confirmed(); });
    expect(writes()).toHaveLength(2);
    expect([...el.querySelectorAll('[role="alert"]')].map((node) => node.textContent)).toEqual([
      m.mobile_git_operation_failed(), `${m.native_git_committed()} ${m.native_git_sync_failed({ op: m.native_git_push() })}`,
    ]);
    expect(el.textContent).toContain('fixture-push-refused');
    expect(el.textContent).toContain('fixture-refresh-refused');
    expect(el.textContent).not.toContain(m.native_git_pushed());
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(2);
    boundary.fetch.mockImplementation(respond); await click(m.native_git_reload());
    expect(el.querySelector('textarea')?.value).toBe('');
    expect(writes()).toHaveLength(2);
  });

  it.each(['refusal', 'timeout'] as const)('separa resumo do commit feito da causa de push %s', async (kind) => {
    if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<Response>();
    const detail = kind === 'refusal' ? 'fatal: Authentication failed' : m.mobile_git_write_timeout();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/push')
      ? kind === 'refusal' ? json({ ok: false, output: detail }) : pending.promise : respond(url, init));
    await render(); await fill(m.native_git_message(), 'fixture-partial-commit');
    await click(m.native_git_commit_push()); await act(async () => accept()());
    if (kind === 'timeout') await act(async () => vi.advanceTimersByTimeAsync(60000));
    const alerts = el.querySelectorAll<HTMLElement>('[role="alert"]');
    expect([...alerts].map((node) => node.textContent)).toEqual([`${m.native_git_committed()} ${m.native_git_sync_failed({ op: m.native_git_push() })}`]);
    const diagnostic = [...el.querySelectorAll<HTMLElement>('[data-selectable="true"]')].find((node) => node.textContent === detail)!;
    expect(diagnostic).toBeTruthy();
    expect(parseFloat(diagnostic.style.fontSize)).toBeLessThan(parseFloat(alerts[0].style.fontSize));
    expect(diagnostic.closest('[data-scroll="true"]')).toBeTruthy();
    expect(el.querySelector('textarea')?.value).toBe('');
    expect(writes().map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/sessions/fixture-session/git/commit', '/api/sessions/fixture-session/git/push',
    ]);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ message: 'fixture-partial-commit', paths: ['a.ts', 'b.ts'], amend: false, new_branch: null });
    if (kind === 'timeout') await act(async () => pending.resolve(json({ ok: true })));
    expect(writes()).toHaveLength(2);
    expect(el.textContent).not.toContain(m.native_git_pushed());
  });

  it('publica somente após confirmar, e mantém resultado se refresh falhar', async () => {
    await render();
    let published = false;
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/push')) { published = true; return json({ ok: true, output: 'fixture-published' }); }
      if (published && String(url).endsWith('/git/files')) return json({ detail: 'fixture-refresh-refused' }, 503);
      return respond(url, init);
    });
    await click(m.native_git_push()); expect(writes()).toHaveLength(0);
    await act(async () => accept()());
    expect(el.textContent).toContain(m.native_git_pushed());
    expect(el.textContent).toContain('fixture-refresh-refused');
    expect(writes()).toHaveLength(1);
  });

  it.each(['unmount', 'destination', 'removed'])('não escreve com confirmação atrasada após %s', async (kind) => {
    await render(); await click(m.native_git_push()); const confirmed = accept();
    if (kind === 'unmount') { await act(async () => root.unmount()); mounted = false; }
    else if (kind === 'destination') { boundary.params = { server: 'route-c', name: 'fixture-other' }; await render(); }
    else await act(async () => useServers.setState({ servers: [] }));
    await act(async () => confirmed());
    expect(writes()).toHaveLength(0);
  });

  it.each(['fetch', 'pull', 'status'] as const)('executa %s no destino explícito e relê inclusive quando ok:false', async (action) => {
    await render();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git') ? json({ ok: false, output: `fixture-${action}-refused` }) : respond(url, init));
    const labels = { fetch: m.native_git_fetch(), pull: m.native_git_pull(), status: m.mobile_git_status() };
    await click(labels[action]);
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ action });
    expect(writes()[0][0]).toBe('https://route-b.test/api/sessions/fixture-session/git');
    expect(el.textContent).toContain(`fixture-${action}-refused`);
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(2);
  });

  it('bloqueia troca e criação de branch com árvore suja sem POST', async () => {
    await render(); await click(m.git_aba_branches());
    await click('next');
    expect(el.textContent).toContain(m.git_working_tree_suja());
    await fill(m.git_branch_nome_placeholder(), 'fixture-new');
    await click(m.native_git_branch_create({ n: 'fixture-new' }));
    expect(el.textContent).toContain(m.git_working_tree_suja());
    expect(writes()).toHaveLength(0); expect(boundary.alert).not.toHaveBeenCalled();
  });

  it('exibe a pasta de branch ocupada e bloqueia checkout sem remover worktree', async () => {
    files = []; branches.dirty = false; branches.elsewhere = { next: { path: '/fixture/occupied', main: true } };
    await render(); await click(m.git_aba_branches()); await click('next');
    expect(el.textContent).toContain(m.native_git_elsewhere_title({ branch: 'next' }));
    expect(el.textContent).toContain(m.native_git_elsewhere_body({ branch: 'next' }));
    expect(el.textContent).toContain('/fixture/occupied');
    expect(writes()).toHaveLength(0);
  });

  it('filtra branches e confirma troca limpa antes do checkout', async () => {
    files = []; branches.dirty = false;
    await render(); await click(m.git_aba_branches());
    await fill(m.native_git_branch_search(), 'no-match');
    expect(el.textContent).toContain(m.native_git_no_branch());
    expect(button('next')).toBeUndefined();
    await fill(m.native_git_branch_search(), 'next'); await click('next');
    expect(writes()).toHaveLength(0);
    const confirmed = accept(); await act(async () => { confirmed(); confirmed(); });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('https://route-b.test/api/sessions/fixture-session/checkout');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ branch: 'next' });
  });

  it('confirma criação limpa com switch_after e revalida sujeira antes de POST', async () => {
    files = []; branches.dirty = false;
    await render(); await click(m.git_aba_branches());
    await fill(m.git_branch_nome_placeholder(), 'fixture-new'); await click(m.native_git_branch_create({ n: 'fixture-new' }));
    expect(writes()).toHaveLength(0);
    await act(async () => accept()());
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ name: 'fixture-new', switch_after: true });
    expect(el.textContent).toContain(m.native_git_branch_created({ n: 'fixture-new' }));
    await fill(m.git_branch_nome_placeholder(), 'fixture-later'); await click(m.native_git_branch_create({ n: 'fixture-later' }));
    branches.dirty = true;
    await act(async () => accept()());
    expect(writes()).toHaveLength(1);
    expect(el.textContent).toContain(m.git_working_tree_suja());
  });

  it('substitui lista e composer pelo diff e conserva rascunho e seleção ao voltar', async () => {
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/diff') ? json({ diff: '+fixture-isolated-diff', truncated: false }) : respond(url, init));
    await render(); await fill(m.native_git_message(), 'fixture-kept-draft');
    await click(m.native_git_include({ path: 'b.ts' }));
    await click('a.ts');
    expect(el.textContent).toContain('+fixture-isolated-diff');
    expect(button('b.ts')).toBeUndefined();
    expect(el.querySelector('[role="checkbox"]')).toBeNull();
    expect(el.querySelector('textarea')).toBeNull();
    await click(m.native_git_reload());
    expect(button('b.ts')).toBeUndefined();
    expect(el.textContent).toContain('+fixture-isolated-diff');
    await click(m.arq_aba());
    expect(el.querySelector('textarea')?.value).toBe('fixture-kept-draft');
    expect(button(m.native_git_include({ path: 'b.ts' }))?.getAttribute('aria-checked')).toBe('false');
    await click('a.ts'); files = [changed('b.ts')];
    await click(m.native_git_reload());
    expect(button(m.arq_aba())).toBeUndefined();
    expect(button('b.ts')).toBeTruthy();
    expect(el.querySelector('textarea')?.value).toBe('fixture-kept-draft');
  });

  it('mostra diff por arquivo com carregamento e corte, ignorando resposta antiga', async () => {
    const old = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/diff')) return JSON.parse(init!.body as string).path === 'a.ts' ? old.promise : json({ path: 'b.ts', diff: '+fixture-new-diff', truncated: true });
      return respond(url, init);
    });
    await render(); await click('a.ts');
    expect(el.textContent).toContain(m.native_git_diff_loading());
    await click(m.arq_aba());
    await click('b.ts');
    expect(el.textContent).toContain('+fixture-new-diff');
    expect(el.textContent).toContain(m.git_diff_cortado());
    expect(el.querySelector('[data-selectable="true"]')).toBeTruthy();
    await act(async () => old.resolve(json({ path: 'a.ts', diff: '+fixture-stale-diff', truncated: false })));
    expect(el.textContent).not.toContain('+fixture-stale-diff');
    await click(m.arq_aba());
    expect(el.textContent).not.toContain('+fixture-new-diff');
    expect(writes()).toHaveLength(0);
  });

  it('recupera erro de diff pela releitura e distingue diff vazio', async () => {
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/diff') ? json({ detail: 'fixture-diff-offline' }, 503) : respond(url, init));
    await render(); await click('a.ts');
    expect(el.textContent).toContain('fixture-diff-offline');
    expect(el.querySelector('[role="alert"][data-selectable="true"]')).toBeTruthy();
    expect(el.textContent).not.toContain(m.native_git_diff_empty());
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/diff') ? json({ path: 'a.ts', diff: '', truncated: false }) : respond(url, init));
    await click(m.native_git_reload());
    expect(el.textContent).not.toContain('fixture-diff-offline');
    expect(el.textContent).toContain(m.native_git_diff_empty());
  });

  it('confirma descarte individual e relê após recusa sem repetir a escrita', async () => {
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/discard') ? json({ ok: false, output: 'fixture-discard-refused' }) : respond(url, init));
    await render(); await click('a.ts'); await click(m.native_git_discard_hint());
    expect(writes()).toHaveLength(0);
    expect(boundary.alert.mock.calls.at(-1)![0]).toBe(m.native_git_discard_title({ path: 'a.ts' }));
    const confirmed = accept(); await act(async () => { confirmed(); confirmed(); });
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ path: 'a.ts' });
    expect(el.textContent).toContain('fixture-discard-refused');
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(2);
  });

  it('mostra duas horas em português a partir do timestamp e ignora rel do servidor', async () => {
    const previousCore = localeAtual(); const previousMobile = getLocale();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1700007200000);
    configureLocale({ getLocale: () => 'pt' }); overwriteGetLocale(() => 'pt');
    try {
      const item = { ...committed(1), ts: 1700000000, rel: '2 hours ago' };
      boundary.fetch.mockImplementation((url, init) => String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1'
        ? json({ commits: [item], ahead: null, behind: null }) : respond(url, init));
      await render(); await click(m.native_git_history());
      expect(el.textContent).toContain(`${item.short} · fixture-author · ${m.tempo_h_atras({ n: 2 })}`);
      expect(el.textContent).not.toContain('2 hours ago');
    } finally {
      clock.mockRestore(); configureLocale({ getLocale: () => previousCore }); overwriteGetLocale(() => previousMobile);
    }
  });

  it('monta histórico só na aba visível, pagina e não busca quando oculto', async () => {
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/git/log') && parsed.searchParams.get('n') !== '1') {
        if (parsed.searchParams.get('n') === '30') return pending.promise;
        return json({ commits: Array.from({ length: 31 }, (_, i) => committed(i + 1)), ahead: 2, behind: 3 });
      }
      return respond(url, init);
    });
    await render(); await click(m.native_git_history());
    expect(el.textContent).toContain(m.native_git_loading());
    await act(async () => pending.resolve(json({ commits: Array.from({ length: 30 }, (_, i) => committed(i + 1)), ahead: 2, behind: 3 })));
    expect(el.textContent).toContain('fixture-history-30');
    expect(el.textContent).toContain('fixture-author');
    expect(el.textContent).toContain(m.native_git_commit_local());
    await click(m.native_git_more());
    expect(el.textContent).toContain('fixture-history-31');
    expect(boundary.fetch.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('n') === '60')).toBe(true);
    await click(m.native_git_changes());
    expect(el.textContent).not.toContain('fixture-history-31');
    const historyReads = () => boundary.fetch.mock.calls.filter(([url]) => String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1').length;
    const previous = historyReads(); await click(m.native_git_reload());
    expect(historyReads()).toBe(previous);
  });

  it('mostra falha de histórico sem vazio falso e recupera ao reler', async () => {
    let failed = true;
    boundary.fetch.mockImplementation((url, init) => String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1'
      ? failed ? json({ detail: 'fixture-history-offline' }, 503) : json({ commits: [], ahead: null, behind: null }) : respond(url, init));
    await render(); await click(m.native_git_history());
    expect(el.textContent).toContain('fixture-history-offline');
    expect(el.textContent).not.toContain(m.native_git_no_commits());
    expect(el.querySelector('[role="alert"][data-selectable="true"]')).toBeTruthy();
    failed = false; await click(m.native_git_reload());
    expect(el.textContent).toContain(m.native_git_no_commits());
    expect(el.textContent).not.toContain('fixture-history-offline');
  });

  it('alinha o assunto às demais linhas do histórico com 4 pt de margem horizontal', async () => {
    const item = { ...committed(1), refs: 'fixture-ref' };
    boundary.fetch.mockImplementation((url, init) => String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1'
      ? json({ commits: [item], ahead: null, behind: null }) : respond(url, init));
    await act(async () => root.render(<GitPanel server={server} name="fixture-session" />));
    await click(m.native_git_history());
    const row = button(m.git_titulo_commit({ short: item.short, subject: item.subject }))!;
    expect([...row.querySelectorAll('span')].map((node) => node.getAttribute('data-padding-horizontal'))).toEqual(['4', '4', '4', '4']);
  });

  it('dá respiro horizontal ao assunto e corpo sem envolver a área do diff', async () => {
    const item = { ...committed(1), body: 'fixture-commit-body' };
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/diff-full')) return json({ diff: '+fixture-full-width-diff', truncated: false });
      if (String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1') return json({ commits: [item], ahead: null, behind: null });
      return respond(url, init);
    });
    await render(); await click(m.native_git_history()); await click(m.git_titulo_commit({ short: item.short, subject: item.subject }));
    const subject = [...el.querySelectorAll('span')].find((node) => node.textContent === item.subject)!;
    const body = [...el.querySelectorAll('span')].find((node) => node.textContent === item.body)!;
    const content = subject.closest('[data-scroll]')!;
    expect(Number(content.getAttribute('data-content-padding-horizontal'))).toBeGreaterThan(0);
    expect(content.contains(body)).toBe(true);
    expect(content.textContent).not.toContain('+fixture-full-width-diff');
    expect(el.textContent).toContain('+fixture-full-width-diff');
  });

  it('abre diff do commit com corte no destino explícito e ignora diff fechado atrasado', async () => {
    const first = committed(1); const second = committed(2); const old = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith(`/git/commit/${first.hash}/diff-full`)) return old.promise;
      if (String(url).endsWith(`/git/commit/${second.hash}/diff-full`)) return json({ sha: second.hash, diff: '+fixture-commit-diff', truncated: true });
      if (String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1') return json({ commits: [first, second], ahead: null, behind: null });
      return respond(url, init);
    });
    await render(); await click(m.native_git_history());
    await click(m.git_titulo_commit({ short: first.short, subject: first.subject }));
    expect(el.textContent).toContain(m.native_git_diff_loading());
    await click(m.native_git_commit_close());
    await click(m.git_titulo_commit({ short: second.short, subject: second.subject }));
    expect(el.textContent).toContain('+fixture-commit-diff');
    expect(el.textContent).toContain(m.git_diff_cortado());
    await act(async () => old.resolve(json({ sha: first.hash, diff: '+fixture-old-commit', truncated: false })));
    expect(el.textContent).not.toContain('+fixture-old-commit');
    const [url, init] = boundary.fetch.mock.calls.find(([url]) => String(url).endsWith(`/git/commit/${second.hash}/diff-full`))!;
    expect(url).toBe(`https://route-b.test/api/sessions/fixture-session/git/commit/${second.hash}/diff-full`);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-b');
  });

  it.each(['git_cwd', 'jsonl', 'provider', 'headless', 'missing', 'branch'] as const)('recusa confirmação se a identidade remota mudou em %s', async (change) => {
    await render(); await click(m.native_git_push());
    if (change === 'missing') session = null;
    else if (change === 'branch') branches.current = 'fixture-other-branch';
    else if (change === 'headless') session!.headless = true;
    else if (change === 'provider') session!.provider = 'codex';
    else session![change] = `fixture-other-${change}`;
    await act(async () => accept()());
    expect(writes()).toHaveLength(0);
    expect(el.textContent).toContain(m.mobile_git_context_changed());
    const remoteLists = boundary.fetch.mock.calls.filter(([url]) => String(url) === 'https://route-b.test/api/sessions');
    expect(remoteLists.length).toBeGreaterThan(1);
    expect(remoteLists.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer token-b')).toBe(true);
  });

  it('recusa snapshot do repositório se git_cwd muda durante sua leitura', async () => {
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/files') ? pending.promise : respond(url, init));
    await render(); session!.git_cwd = '/fixture/repo-b';
    await act(async () => pending.resolve(json({ files, sequencer: null })));
    expect(el.textContent).toContain(m.mobile_git_context_changed());
    expect(button(m.native_git_push())?.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it.each(['git_cwd', 'branch'] as const)('não envia push se %s muda depois do commit', async (change) => {
    await render(); await fill(m.native_git_message(), 'fixture-context-commit');
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/commit')) {
        if (change === 'git_cwd') session!.git_cwd = '/fixture/repo-b';
        else branches.current = 'fixture-other-branch';
        return json({ ok: true, output: 'fixture-created' });
      }
      return respond(url, init);
    });
    await click(m.native_git_commit_push()); await act(async () => accept()());
    expect(writes().map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/sessions/fixture-session/git/commit']);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(`${m.native_git_committed()} ${m.native_git_sync_failed({ op: m.native_git_push() })}`);
    expect(el.textContent).toContain(m.mobile_git_context_changed());
    expect(el.querySelector('textarea')?.value).toBe('');
  });

  it('revalida contexto depois da conferência de arquivos e antes de criar branch', async () => {
    files = []; branches.dirty = false;
    await render(); await click(m.git_aba_branches());
    await fill(m.git_branch_nome_placeholder(), 'fixture-new'); await click(m.native_git_branch_create({ n: 'fixture-new' }));
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/files')) { session!.git_cwd = '/fixture/repo-b'; return json({ files: [], sequencer: null }); }
      return respond(url, init);
    });
    await act(async () => accept()());
    expect(writes()).toHaveLength(0);
    expect(el.textContent).toContain(m.mobile_git_context_changed());
  });

  it('encerra leitura pendurada em 20 s, ignora resposta atrasada e permite reler', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/files') ? pending.promise : respond(url, init));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(el.textContent).toContain(m.mobile_git_read_timeout());
    expect(button(m.native_git_push())?.disabled).toBe(true);
    await act(async () => pending.resolve(json({ files: [changed('fixture-too-late.ts')], sequencer: null })));
    expect(el.textContent).not.toContain('fixture-too-late.ts');
    boundary.fetch.mockImplementation(respond); await click(m.native_git_reload());
    expect(el.textContent).toContain('a.ts');
    expect(el.textContent).not.toContain(m.mobile_git_read_timeout());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('vence prazo da revalidação remota sem escrever nem repetir confirmação', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render(); const pending = deferred<Response>(); let stalled = true;
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/api/sessions') && stalled) { stalled = false; return pending.promise; }
      return respond(url, init);
    });
    await click(m.native_git_push()); await act(async () => accept()());
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(el.textContent).toContain(m.mobile_git_read_timeout());
    expect(writes()).toHaveLength(0);
    await act(async () => pending.resolve(json([session])));
    expect(writes()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('marca escrita incerta em 60 s, relê e não envia push após commit atrasado', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/commit') ? pending.promise : respond(url, init));
    await render(); await fill(m.native_git_message(), 'fixture-slow-commit');
    await click(m.native_git_commit_push()); await act(async () => accept()());
    expect(writes()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(59999));
    expect(button(m.native_git_commit_push())?.disabled).toBe(true);
    expect(el.textContent).not.toContain(m.mobile_git_write_timeout());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(el.textContent).toContain(m.mobile_git_write_timeout());
    expect(el.querySelector('textarea')?.value).toBe('fixture-slow-commit');
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(2);
    await act(async () => pending.resolve(json({ ok: true, output: 'fixture-late-success' })));
    expect(writes()).toHaveLength(1);
    expect(el.textContent).not.toContain(m.native_git_pushed());
    expect(el.textContent).not.toContain(m.native_git_committed());
    expect(el.querySelector('textarea')?.value).toBe('fixture-slow-commit');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['file', 'history', 'commit'] as const)('limita leitura de %s a 20 s e ignora resultado atrasado', async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<Response>(); const item = committed(1);
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/diff') || String(url).endsWith('/diff-full')) return pending.promise;
      if (String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1') return kind === 'history' ? pending.promise : json({ commits: [item], ahead: null, behind: null });
      return respond(url, init);
    });
    await render();
    if (kind === 'file') await click('a.ts');
    else { await click(m.native_git_history()); if (kind === 'commit') await click(m.git_titulo_commit({ short: item.short, subject: item.subject })); }
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(el.textContent).toContain(m.mobile_git_read_timeout());
    expect(el.textContent).not.toContain(kind === 'history' ? m.native_git_no_commits() : m.native_git_diff_empty());
    await act(async () => pending.resolve(json(kind === 'history' ? { commits: [committed(99)], ahead: null, behind: null } : { diff: '+fixture-late-diff', truncated: false })));
    expect(el.textContent).not.toContain('fixture-late-diff');
    expect(el.textContent).not.toContain('fixture-history-99');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['repo', 'diff', 'history', 'write'] as const)('limpa timers ao desmontar com %s pendurado', async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => {
      if (kind === 'repo' && String(url).endsWith('/git/files')) return pending.promise;
      if (kind === 'diff' && String(url).endsWith('/git/diff')) return pending.promise;
      if (kind === 'history' && String(url).includes('/git/log') && new URL(String(url)).searchParams.get('n') !== '1') return pending.promise;
      if (kind === 'write' && String(url).endsWith('/git/commit')) return pending.promise;
      return respond(url, init);
    });
    await render();
    if (kind === 'diff') await click('a.ts');
    if (kind === 'history') await click(m.native_git_history());
    if (kind === 'write') { await fill(m.native_git_message(), 'fixture-teardown'); await click(m.native_git_commit()); }
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => root.unmount()); mounted = false;
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => pending.resolve(json({ ok: true, output: 'fixture-late-success', files: [], sequencer: null, diff: '', truncated: false, commits: [], ahead: null, behind: null })));
    expect(vi.getTimerCount()).toBe(0);
    expect(writes()).toHaveLength(kind === 'write' ? 1 : 0);
  });

  it.each(['constructor', 'toString', '__proto__'])('permite branch %s sem confundir propriedade herdada com worktree', async (branch) => {
    files = []; branches = { current: 'main', branches: ['main', branch], dirty: false, elsewhere: {} };
    await render(); await click(m.git_aba_branches()); await click(branch);
    expect(el.textContent).not.toContain(m.native_git_elsewhere_title({ branch }));
    expect(boundary.alert).toHaveBeenCalledOnce();
    await act(async () => accept()());
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ branch });
  });

  it('seleciona caminho constructor novo e preserva sua desmarcação na releitura', async () => {
    await render(); files = [changed('constructor')];
    await click(m.native_git_reload());
    expect(button(m.native_git_include({ path: 'constructor' }))?.getAttribute('aria-checked')).toBe('true');
    await click(m.native_git_include({ path: 'constructor' })); await click(m.native_git_reload());
    expect(button(m.native_git_include({ path: 'constructor' }))?.getAttribute('aria-checked')).toBe('false');
  });

  it('limita saída e erros extensos a caixas roláveis sem retirar os controles', async () => {
    await render();
    const output = 'fixture-long-status\n'.repeat(2000);
    const error = 'fixture-long-error\n'.repeat(2000);
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git') ? json({ ok: true, output }) : respond(url, init));
    await click(m.mobile_git_status());
    const result = [...el.querySelectorAll<HTMLElement>('[data-selectable="true"]')].find((node) => node.textContent === output);
    const outputBox = result?.closest<HTMLElement>('[data-scroll="true"]');
    expect(outputBox).toBeTruthy();
    expect(parseFloat(outputBox!.style.maxHeight)).toBeGreaterThan(0);
    expect(parseFloat(outputBox!.style.maxHeight)).toBeLessThanOrEqual(160);
    expect(button(m.native_git_push())?.disabled).toBe(false);
    await fill(m.native_git_message(), 'fixture-long-error-commit');
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/commit') ? json({ ok: false, output: error }) : respond(url, init));
    await click(m.native_git_commit());
    const errorBox = el.querySelector('[role="alert"][data-selectable="true"]')?.closest<HTMLElement>('[data-scroll="true"]');
    expect(errorBox).toBeTruthy();
    expect(parseFloat(errorBox!.style.maxHeight)).toBeLessThanOrEqual(160);
    expect(button(m.native_git_reload())?.disabled).toBe(false);
    expect(button(m.native_git_commit())?.disabled).toBe(false);
  });

  it.each([
    ['mobile/src/features/terminal/TerminalPanel.tsx', 'TerminalPanel.tsx', 'mobile/src/features/terminal/'],
    ['mobile/scripts/', 'scripts', 'mobile/'],
  ])('prioriza o nome de %s sem perder o caminho acessível ou enviado ao diff', async (path, filename, directory) => {
    files = [changed(path)];
    boundary.fetch.mockImplementation((url, init) => String(url).endsWith('/git/diff') ? json({ path, diff: '', truncated: false }) : respond(url, init));
    await render();
    const entry = button(path)!;
    const title = [...entry.querySelectorAll<HTMLElement>('span')].find((node) => node.textContent === filename);
    expect(title?.textContent).toBe(filename);
    expect(title?.getAttribute('data-lines')).toBe('1');
    expect(title?.getAttribute('data-ellipsis')).toBe('tail');
    expect(title?.style.fontWeight).toBe('600');
    expect(parseFloat(title!.parentElement!.style.minWidth)).toBe(0);
    expect(title?.parentElement?.style.flex).toBe('1 1 0%');
    const folder = [...entry.querySelectorAll<HTMLElement>('span')].find((node) => node.textContent === directory);
    expect(folder?.getAttribute('data-lines')).toBe('1');
    expect(folder?.getAttribute('data-ellipsis')).toBe('middle');
    expect(parseFloat(folder!.style.fontSize)).toBeLessThan(parseFloat(title!.style.fontSize));
    const stats = [...entry.parentElement!.children].find((node) => node !== entry && node.textContent?.includes('+2')) as HTMLElement;
    expect(stats.style.maxWidth).toBe('40%');
    await click(path);
    const diff = boundary.fetch.mock.calls.find(([url]) => String(url).endsWith('/git/diff'))!;
    expect(JSON.parse(diff[1].body)).toEqual({ path });
  });

  it('acomoda paths e branches longos em espaços flexíveis e mantém alvo de seleção 44', async () => {
    const path = `fixture/${'long-path-'.repeat(40)}.ts`;
    const branch = `fixture-${'long-branch-'.repeat(40)}`;
    const worktree = `/fixture/${'long-worktree-'.repeat(40)}`;
    files = [changed(path)]; branches.branches.push(branch); branches.elsewhere = { [branch]: { path: worktree, main: false } };
    await render();
    expect(button(m.native_git_include({ path }))?.style.minWidth).toBe('44px');
    expect(parseFloat(button(path)!.style.minWidth)).toBe(0);
    expect(button(path)?.querySelector<HTMLElement>('span')?.style.flexShrink).toBe('1');
    await click(m.git_aba_branches());
    expect(parseFloat(button(branch)!.style.minWidth)).toBe(0);
    expect(button(branch)?.querySelector<HTMLElement>('span')?.style.flexShrink).toBe('1');
    const location = [...el.querySelectorAll<HTMLElement>('[data-selectable="true"]')].find((node) => node.textContent?.includes(worktree));
    expect(parseFloat(location!.style.minWidth)).toBe(0);
    expect(location?.style.flexShrink).toBe('1');
  });

  it.each(['missing', 'removed', 'invite'])('recusa deep link de servidor %s sem usar o ativo', async (kind) => {
    boundary.canGoBack = false;
    useServers.setState({ servers: kind === 'missing' ? [] : [{ ...server, [kind]: true }] });
    await render(); expect(boundary.fetch).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')).toBeTruthy();
    expect(boundary.header.headerLeft).toBeTypeOf('function');
    await act(async () => root.render(boundary.header.headerLeft()));
    await click(m.comum_voltar());
    expect(boundary.replace).toHaveBeenCalledExactlyOnceWith('/s/route-b/fixture-session');
    expect(boundary.back).not.toHaveBeenCalled();
  });
});
