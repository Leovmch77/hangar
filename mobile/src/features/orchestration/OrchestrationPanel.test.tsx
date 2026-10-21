// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureApi, type AggSession, type OrqPanel, type Server } from '@hangar/core';
import { AppState, Linking } from 'react-native';
import { toast } from '../../ui/Toast';
import { useServers } from '../../stores/servers';
import { useSessions, _resetSessionsForTests } from '../../stores/sessions';
import * as m from '../../paraglide/messages';
import { OrchestrationContent, OrchestrationPanel } from './OrchestrationPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nativeRender = vi.hoisted(() => ({ texts: [] as unknown[] }));
vi.mock('react-native', async importOriginal => {
  const actual = await importOriginal<typeof import('react-native')>();
  return { ...actual, Text: (props: { children?: ReactNode }) => { nativeRender.texts.push(props.children); return createElement(actual.Text, props); } };
});
const navigation = vi.hoisted(() => ({ focused: true, push: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', () => ({ useIsFocused: () => navigation.focused, useRouter: () => navigation, useLocalSearchParams: () => ({ server: 'b', name: 'orq-fixture' }), Stack: { Screen: () => null } }));
vi.mock('expo-secure-store', () => ({ setItemAsync: vi.fn().mockResolvedValue(undefined), getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('../../ui/Screen', () => ({ Screen: ({ children, independent }: { children: ReactNode; independent?: boolean }) => createElement('main', { 'data-independent': independent }, children) }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('section', null, children) }));
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({ paragraph: {} }) }));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown, onLinkPress }: { markdown: string; onLinkPress?: (event: { url: string }) => void }) =>
    createElement('article', { onClick: () => onLinkPress?.({ url: markdown.match(/\]\(([^)]+)\)/)?.[1] ?? '' }) }, markdown),
}));
vi.mock('../../ui/Toast', () => ({ toast: { erro: vi.fn() } }));

export const panelFixture = (): OrqPanel => ({
  run: 'run-1', gid: 'group-1', empty: false,
  metadata: { title: 'fixture-title', repo: '/repo/fixture', plan: '/plans/fixture.md', total_tasks: 3, error: 'metadata-warning' },
  errors: [{ file: 'events', error: 'partial-events' }],
  timing: { started_at: '2026-10-01T10:00:00Z', finished_at: null, elapsed_seconds: 125 },
  tasks: { integrated: 1, total: 3, total_known: true, rows: [
    { n: 1, title: 'integrated-task', state: 'integrated', round: 1 },
    { n: 2, title: 'future-task', state: 'future-state' as never, round: null, timing: { started_at: null, finished_at: null, elapsed_seconds: 65 } },
    { n: 3, title: 'queued-task', state: 'queued', round: null },
  ] },
  team: [{ name: 'old-arbiter', role: 'arbiter', task: null, current: true, last: null }, { name: 'ended-worker', role: 'executor', task: 1, current: false, last: null }],
  decisions: [{ task: 2, ts: '2026-10-01T10:01:00Z', question: 'fixture-question', parecer: '/outside/review.md', event_id: 'event-1' }],
  automation: { mode: { jev: 'future-mode', regex: 'shadow' }, woke: { total: 7, decisions: 2, alarms: 3, messages: 2 }, alone: { total: 9, opened: 3, integrated: 4, dropped: 2 }, dropped_by_jev: 8, advanced: { would_drop: 4, disagree: 2, judged: 9, min_confidence: { p: 0.62, choice: 'act', ts: '2026-10-01T10:00:00Z', text: 'low-confidence' }, by_rule: 5 } },
  consumption: { computed_at: '2026-10-01T10:00:00Z', since: '2026-10-01T10:00:00Z', until: '2026-10-01T11:00:00Z', sessions: { team: 3, measured: 2, missing: ['missing-worker'] }, totals: { new: 1234, cache_read: 5678, usd: 1.25, usd_partial: true }, providers: [{ provider: 'future-provider', sessions: 2, new: 1234, cache_read: 5678, usd: 1.25, models: [{ model: 'fixture-model', sessions: 2, new: 1234, cache_read: 5678, usd: null }] }], missing_prices: ['unpriced-model'], subagents: true },
  integration: { branch: 'fixture-branch', last: { task: 1, commit: 'abc123', ts: '2026-10-01T10:00:00Z' }, outcome: 'future-outcome' as never, red_log: null, delivery_checks: { ok: 1, total: 2, failing: [2] } },
});
const server: Server = { id: 'b', label: 'machine-b', baseUrl: 'http://b:8765', token: 'token-b' };
let container: HTMLDivElement;
let root: Root;
let fetcher: ReturnType<typeof vi.fn>;
const reply = (data: unknown) => new Response(JSON.stringify(data));
const renderContent = (panel = panelFixture(), history = false) => act(async () => root.render(createElement(OrchestrationContent, { panel, serverId: 'b', name: 'orq-fixture', history })));
const renderPanel = () => act(async () => root.render(createElement(OrchestrationPanel)));
const click = (label: string) => act(async () => { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label || b.querySelector('span')?.textContent === label); expect(button, label).toBeTruthy(); button!.click(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  container = document.createElement('div'); root = createRoot(container);
  navigation.focused = true; navigation.push.mockClear(); navigation.back.mockClear(); nativeRender.texts = [];
  useServers.setState({ ready: true, servers: [server, { ...server, id: 'a', baseUrl: 'http://a:8765' }], activeId: 'a' });
  _resetSessionsForTests();
  useSessions.setState({ byServerRecord: {} });
  configureApi({ getBaseUrl: () => 'http://a:8765', getToken: () => 'token-a', onUnauthorized: vi.fn(), origin: null, createEventSource: () => ({ addEventListener() {}, removeEventListener() {}, close() {}, onerror: null, onopen: null, readyState: 1 }) as never });
  fetcher = vi.fn().mockResolvedValue(reply(panelFixture())); vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); _resetSessionsForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('a folha de orquestração pede fundo próprio mesmo dentro da janela de tablet', async () => {
  await renderPanel();
  expect(container.querySelector('main')?.getAttribute('data-independent')).toBe('true');
});

it.each([false, true])('panel metadata error separates the warning title from the complete smaller detail with history=%s', async (history) => {
  const panel = panelFixture();
  const error = "Não consegui ler orq.json: FileNotFoundError: [Errno 2] No such file or directory: '/repo/fixture/run-1/orq.json'";
  panel.metadata!.error = error;
  await renderContent(panel, history);
  const texts = [...container.querySelectorAll('span')];
  const title = texts.find(text => text.textContent === 'Could not read the data for this run.');
  const detail = texts.find(text => text.textContent === error);
  expect(title, 'translated warning title must be separate from the technical error').toBeDefined();
  expect(detail, 'complete technical detail must remain visible').toBeDefined();
  expect(title!.parentElement).toBe(detail!.parentElement);
  expect(Number.parseFloat(detail!.style.fontSize)).toBeLessThan(Number.parseFloat(title!.style.fontSize));
  expect(detail!.style.color).not.toBe(title!.style.color);
  expect(container.textContent).toContain('fixture-title');
  expect(container.textContent).toContain('T2 · future-task');
});

it.each([false, true])('plan read error uses a translated title and preserves smaller detail and partial data with history=%s', async (history) => {
  const panel = panelFixture();
  const error = "FileNotFoundError: [Errno 2] No such file or directory: '/repo/fixture/plans/fixture.md'";
  panel.errors.push({ file: 'plan', error });
  await renderContent(panel, history);
  const texts = [...container.querySelectorAll('span')];
  const title = texts.find(text => text.textContent === 'Could not read the plan.');
  const detail = texts.find(text => text.textContent === error);
  expect(title, 'translated plan warning title must be separate from the technical error').toBeDefined();
  expect(detail, 'complete technical detail must remain visible').toBeDefined();
  expect(title!.parentElement).toBe(detail!.parentElement);
  expect(Number.parseFloat(detail!.style.fontSize)).toBeLessThan(Number.parseFloat(title!.style.fontSize));
  expect(detail!.style.color).not.toBe(title!.style.color);
  expect(container.textContent).toContain('fixture-title');
  expect(container.textContent).toContain('T2 · future-task');
  expect(texts.some(text => text.textContent === 'Could not read events.')).toBe(true);
  expect(container.textContent).toContain('partial-events');
  expect(m.orq_mobile_plan_read_error({}, { locale: 'pt' })).toBe('Não foi possível ler o plano.');
});

it('erro de arquivo mostra frase traduzida e causa técnica em detalhe menor', async () => {
  const panel = panelFixture();
  const error = "FileNotFoundError: [Errno 2] No such file or directory: '/run/orq.json'";
  panel.errors = [{ file: 'orq.json', error }];
  fetcher.mockImplementation((url: string) => Promise.resolve(reply(url.endsWith('/orq/panel') ? panel : [])));
  await renderPanel();
  const texts = [...container.querySelectorAll('span')];
  const heading = texts.find(text => text.textContent === 'Could not read orq.json.');
  expect(heading, 'file warning title must be separate from the technical error').toBeDefined();
  const detail = texts.find(text => text.textContent === error);
  expect(detail).toBeDefined();
  expect(heading!.parentElement).toBe(detail!.parentElement);
  expect(parseFloat(detail!.style.fontSize)).toBeLessThan(parseFloat(heading!.style.fontSize));
  expect(detail!.style.color).not.toBe(heading!.style.color);
  expect(container.textContent).toContain('fixture-title');
  expect(container.textContent).toContain('T2 · future-task');
});

it('conteúdo sete seções preserva dados, recolhe corpo e filtra somente integradas', async () => {
  await renderContent();
  expect(container.textContent).toContain('fixture-title');
  expect(container.textContent).toContain('metadata-warning');
  expect(container.textContent).toContain('partial-events');
  for (const title of [m.orq_time_title(), m.orq_tasks_title(), m.orq_team_title(), m.orq_decisions_title(), m.orq_auto_title(), m.orq_use_title(), m.orq_int_title()]) expect(container.textContent).toContain(title);
  expect(container.textContent).toContain(m.orq_tasks_count({ n: 1, total: 3 }));
  expect(container.textContent).toContain('future-state');
  expect(container.textContent).toContain('future-mode');
  expect(container.textContent).toContain('future-provider');
  expect(container.textContent).toContain('future-outcome');
  expect(container.textContent).toContain('fixture-model');
  expect(container.textContent).toContain('missing-worker');
  expect(container.textContent).toContain('unpriced-model');
  expect(container.textContent).toContain('1.25*');
  expect(container.textContent).not.toContain('queued-task');
  expect(container.textContent).not.toContain('ended-worker');
  expect(container.textContent).not.toContain('62%');
  await click(m.orq_adv_title()); expect(container.textContent).toContain('62%');
  await click(m.orq_tasks_queued({ n: 1 })); expect(container.textContent).toContain('queued-task');
  await click(m.orq_show_pending_tasks()); expect(container.textContent).not.toContain('integrated-task'); expect(container.textContent).toContain('queued-task'); expect(container.textContent).toContain('future-task');
  await click(m.orq_team_show_ended({ n: 1 })); expect(container.textContent).toContain('ended-worker');
  await click(m.orq_collapse_all()); expect(container.textContent).not.toContain('fixture-question'); expect(container.textContent).not.toContain('future-task'); expect(container.textContent).not.toContain('fixture-model');
  await click(m.orq_expand_all()); expect(container.textContent).toContain('fixture-question');
});

it.each([false, true])('plan fallback preserves nonblank text with history=%s', async (history) => {
  for (const [plan, expectedPath] of [['', '—'], [' \t ', '—'], ['/plans/fixture.md', '/plans/fixture.md'], [' /plans/fixture.md ', ' /plans/fixture.md ']]) {
    const panel = panelFixture();
    panel.metadata!.plan = plan;
    await renderContent(panel, history);
    const texts = [...container.querySelectorAll('span')].map(span => span.textContent);
    expect(texts).toContain(m.orq_history_plan({ path: expectedPath }));
  }
});

it.each([false, true])('task label omits blank title and preserves valid text with history=%s', async (history) => {
  for (const [title, label] of [['', 'T1'], [' \t ', 'T1'], ['integrated-task', 'T1 · integrated-task'], [' integrated-task ', 'T1 ·  integrated-task ']]) {
    const panel = panelFixture();
    panel.tasks.rows[0].title = title;
    await renderContent(panel, history);
    const texts = [...container.querySelectorAll('span')].map(span => span.textContent);
    expect(texts).toContain(label);
  }
});

it('pergunta Markdown usa renderer nativo tanto no painel vivo quanto no histórico', async () => {
  const panel = panelFixture();
  panel.decisions[0].question = 'Revisar `file.tsx` e [parecer](https://example.com/review)?';
  for (const history of [false, true]) {
    await renderContent(panel, history);
    expect(container.querySelector('article')?.textContent).toBe('Revisar `file.tsx` e [parecer](https://example.com/review)?');
    expect([...container.querySelectorAll('span')].some(span => span.textContent === panel.decisions[0].question)).toBe(false);
  }
});

it.each([false, true])('links do painel com histórico=%s abrem só esquemas seguros e mostram falha', async (history) => {
  const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  vi.mocked(toast.erro).mockClear();
  const pressLink = async (url: string) => {
    const panel = panelFixture();
    panel.decisions[0].question = `[review](${url})`;
    await renderContent(panel, history);
    await act(async () => container.querySelector('article')!.click());
  };
  for (const url of ['http://example.test/review', 'HTTPS://example.test/review', 'mailto:review@example.test']) {
    await pressLink(url);
    expect(openURL).toHaveBeenLastCalledWith(url);
  }
  openURL.mockClear();
  for (const url of ['app://session', 'javascript:void', 'file:///review.md']) await pressLink(url);
  expect(openURL).not.toHaveBeenCalled();
  expect(toast.erro).not.toHaveBeenCalled();
  openURL.mockRejectedValueOnce(new Error('open-link-failed'));
  await pressLink('https://example.test/review');
  expect(toast.erro).toHaveBeenCalledExactlyOnceWith('open-link-failed');
});

it('rótulo acessível do painel inclui resumo da seção e papel e estado do membro', async () => {
  const panel = panelFixture();
  await act(async () => root.render(createElement(OrchestrationContent, { panel, onOpenArbiter: vi.fn() })));
  const buttons = [...container.querySelectorAll('button')];
  const tasks = buttons.find(button => button.textContent?.startsWith(m.orq_tasks_title()))!;
  expect(tasks.getAttribute('aria-label')).toContain(m.orq_tasks_count({ n: 1, total: 3 }));
  const arbiter = buttons.find(button => button.textContent?.startsWith('old-arbiter'))!;
  expect(arbiter.getAttribute('aria-label')).toContain(m.orq_role_arbiter());
  expect(arbiter.getAttribute('aria-label')).toContain(m.orq_live_idle());
});

it('linhas memoizadas não redesenham Task quando apenas estado do time muda', async () => {
  const panel = panelFixture();
  await act(async () => root.render(createElement(OrchestrationContent, { panel })));
  expect(nativeRender.texts.filter(text => text === 'T2 · future-task')).toHaveLength(1);
  await act(async () => root.render(createElement(OrchestrationContent, { panel, live: [{ name: 'old-arbiter', state: 'working' }] as AggSession[] })));
  expect(container.textContent).toContain(m.orq_live_working());
  expect(nativeRender.texts.filter(text => text === 'T2 · future-task')).toHaveLength(1);
});

it('painel vivo consulta servidor da rota, pausa fora do foco e conserva dado bom no retry', async () => {
  vi.useFakeTimers();
  let appState: ((state: string) => void) | undefined;
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { appState = listener as (state: string) => void; return { remove() {} } as never; });
  const initial = deferred<Response>();
  let panelCalls = 0;
  const urls: string[] = [];
  fetcher.mockImplementation((url: string) => {
    urls.push(url);
    if (!url.endsWith('/orq/panel')) return Promise.resolve(reply([]));
    panelCalls++;
    if (panelCalls === 1) return initial.promise;
    if (panelCalls === 2) return Promise.reject(new Error('refresh-failed'));
    return Promise.resolve(reply({ ...panelFixture(), metadata: { ...panelFixture().metadata!, title: 'refreshed-title' } }));
  });
  await renderPanel();
  expect(container.textContent).toContain(m.orq_panel_loading());
  expect(urls).toContain('http://b:8765/api/sessions/orq-fixture/orq/panel');
  expect(urls).not.toContain('http://a:8765/api/sessions/orq-fixture/orq/panel');
  await act(async () => initial.resolve(reply(panelFixture())));
  expect(container.textContent).toContain('fixture-title');
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(container.textContent).toContain('fixture-title');
  expect(container.textContent).toContain('refresh-failed');
  await click(m.orq_panel_retry());
  expect(container.textContent).toContain('refreshed-title');
  expect(container.textContent).not.toContain('refresh-failed');
  navigation.focused = false; await renderPanel();
  const paused = panelCalls;
  await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(panelCalls).toBe(paused);
  navigation.focused = true; await renderPanel(); expect(panelCalls).toBe(paused + 1);
  await act(async () => appState!('inactive'));
  await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(panelCalls).toBe(paused + 1);
  await act(async () => appState!('active')); expect(panelCalls).toBe(paused + 2);
  await click(m.orq_history_title());
  expect(navigation.push).toHaveBeenCalledWith({ pathname: '/config/orchestration-history', params: { server: 'b' } });
});

it('painel vivo descarta resposta após desfocar e bloqueia convite ou servidor removido', async () => {
  const old = deferred<Response>();
  const requested: string[] = [];
  fetcher.mockImplementation((url: string) => { requested.push(url); return url.endsWith('/orq/panel') ? old.promise : Promise.resolve(reply([])); });
  await renderPanel();
  navigation.focused = false; await renderPanel();
  await act(async () => old.resolve(reply(panelFixture())));
  expect(container.textContent).not.toContain('fixture-title');
  await act(async () => useServers.setState({ servers: [{ ...server, invite: true }] }));
  navigation.focused = true; await renderPanel();
  expect(container.textContent).toContain(m.lista_acesso_recusado());
  expect(requested.filter(url => url.endsWith('/orq/panel'))).toHaveLength(1);
  await act(async () => useServers.setState({ servers: [] }));
  expect(container.textContent).toContain(m.chat_servidor_removido());
});
