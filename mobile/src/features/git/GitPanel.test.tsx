// @vitest-environment happy-dom
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi, type ChangedFile, type GitCommit, type SessionInfo } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const boundary = vi.hoisted(() => ({ fetch: vi.fn(), alert: vi.fn(), back: vi.fn(), params: { server: 'route-b', name: 'fixture-session' } }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => boundary.params, useRouter: () => ({ back: boundary.back }) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }));
vi.mock('react-native-keyboard-controller', async () => ({ KeyboardAvoidingView: (await import('react-native')).View }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return { ...actual, Alert: { alert: boundary.alert },
    ScrollView: ({ nestedScrollEnabled, ...props }: any) => createElement(actual.ScrollView, { ...props, 'data-scroll': true }),
    Text: ({ selectable, ellipsizeMode, ...props }: any) => createElement(actual.Text, { ...props, 'data-selectable': !!selectable }),
    Pressable: ({ accessibilityState, accessibilityHint, ...props }: any) => createElement(actual.Pressable, { ...props, 'aria-checked': accessibilityState?.checked, 'aria-selected': accessibilityState?.selected }),
    TextInput: ({ onChangeText, accessibilityLabel, value, editable, ...props }: any) => createElement('textarea', {
      'aria-label': accessibilityLabel, value: value ?? '', disabled: editable === false,
      onInput: (event: React.FormEvent<HTMLTextAreaElement>) => onChangeText?.(event.currentTarget.value),
    }),
  };
});
import GitRoute from '../../../app/s/[server]/[name]/git';
import { useServers } from '../../stores/servers';
import * as m from '../../paraglide/messages';
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
  boundary.fetch.mockReset().mockImplementation(respond); boundary.alert.mockReset(); boundary.back.mockReset();
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

describe('Git pela rota explícita', () => {
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
    expect(el.textContent).toContain(m.native_git_push_failed({ reason: 'fixture-push-refused' }));
    expect(el.textContent).toContain('fixture-refresh-refused');
    expect(el.textContent).not.toContain(m.native_git_pushed());
    expect(el.querySelector('textarea')?.value).toBe('');
    expect(reads().filter(([url]) => String(url).endsWith('/git/files'))).toHaveLength(2);
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

  it('mostra diff por arquivo com carregamento e corte, ignorando resposta antiga', async () => {
    const old = deferred<Response>();
    boundary.fetch.mockImplementation((url, init) => {
      if (String(url).endsWith('/git/diff')) return JSON.parse(init!.body as string).path === 'a.ts' ? old.promise : json({ path: 'b.ts', diff: '+fixture-new-diff', truncated: true });
      return respond(url, init);
    });
    await render(); await click('a.ts');
    expect(el.textContent).toContain(m.native_git_diff_loading());
    await click('b.ts');
    expect(el.textContent).toContain('+fixture-new-diff');
    expect(el.textContent).toContain(m.git_diff_cortado());
    expect(el.querySelector('[data-selectable="true"]')).toBeTruthy();
    await act(async () => old.resolve(json({ path: 'a.ts', diff: '+fixture-stale-diff', truncated: false })));
    expect(el.textContent).not.toContain('+fixture-stale-diff');
    await click(m.git_voltar_arquivos());
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
    expect(el.textContent).toContain(m.native_git_push_failed({ reason: m.mobile_git_context_changed() }));
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
    useServers.setState({ servers: kind === 'missing' ? [] : [{ ...server, [kind]: true }] });
    await render(); expect(boundary.fetch).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')).toBeTruthy();
    await click(m.comum_voltar()); expect(boundary.back).toHaveBeenCalledOnce();
  });
});
