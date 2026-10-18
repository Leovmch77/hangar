// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppState } from 'react-native';
import { configureApi, _limparEsfriamentoParaTestes, type OrqExecucao, type OrqPanel, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import * as m from '../../paraglide/messages';
import { OrchestrationHistory } from './OrchestrationHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const navigation = vi.hoisted(() => ({ focused: true, params: {} as { server?: string }, push: vi.fn(), back: vi.fn(), screen: vi.fn() }));
vi.mock('expo-router', () => ({ useIsFocused: () => navigation.focused, useRouter: () => navigation, useLocalSearchParams: () => navigation.params, Stack: { Screen: ({ options }: { options: object }) => { navigation.screen(options); return null; } } }));
vi.mock('react-native-unistyles', async (original) => {
  const module = await original<typeof import('react-native-unistyles')>();
  return { ...module, useUnistyles: () => { const value = module.useUnistyles(); return { ...value, theme: new Proxy(value.theme, {}) }; } };
});
vi.mock('expo-secure-store', () => ({ setItemAsync: vi.fn().mockResolvedValue(undefined), getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('../../ui/Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => createElement('main', null, children) }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('section', null, children) }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: vi.fn() } }));
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({ paragraph: {} }) }));
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('article', null, markdown) }));

const server: Server = { id: 'b', label: 'machine-b', baseUrl: 'http://b:8765', token: 'token-b' };
const run = (id: string, title: string, plano = ''): OrqExecucao => ({ id, plano, metadata: { title, plan: plano, repo: '/repo/history', total_tasks: 4, error: null }, branch: 'history-branch', gid: 'group-1', inicio: '2026-10-01T10:00:00Z', fim: '2026-10-01T10:02:00Z', resultado: 'future-result', tasks: [], voltas: 0, aprovadas_primeira: 0, reconstruida: false });
const panel = (): OrqPanel => ({ run: 'run-1', gid: 'group-1', empty: false, errors: [], metadata: { title: 'history-detail', repo: '/repo/history', plan: '/plan.md', total_tasks: 0, error: null }, timing: { started_at: null, finished_at: null, elapsed_seconds: null }, tasks: { integrated: 0, total: 0, total_known: true, rows: [] }, team: [{ name: 'old-arbiter', role: 'arbiter', task: null, current: true, last: null }], decisions: [{ task: null, ts: '', question: 'history-question', parecer: '/outside/review.md', event_id: 'event-1' }], automation: { mode: { jev: 'off', regex: 'off' }, woke: { total: 0, decisions: 0, alarms: 0, messages: 0 }, alone: { total: 0, opened: 0, integrated: 0, dropped: 0 }, dropped_by_jev: 0, advanced: { would_drop: 0, disagree: 0, judged: 0, min_confidence: null, by_rule: 0 } }, consumption: null, integration: { branch: null, last: null, outcome: null, red_log: null, delivery_checks: { ok: 0, total: 0, failing: [] } } });
let container: HTMLDivElement;
let root: Root;
let fetcher: ReturnType<typeof vi.fn>;
const reply = (data: unknown) => new Response(JSON.stringify(data));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const render = () => act(async () => root.render(createElement(OrchestrationHistory)));
const click = (label: string) => act(async () => { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label || b.querySelector('span')?.textContent === label); expect(button, label).toBeTruthy(); button!.click(); });
beforeEach(() => {
  container = document.createElement('div'); root = createRoot(container);
  navigation.params = {}; navigation.focused = true; navigation.push.mockClear(); navigation.back.mockClear();
  _limparEsfriamentoParaTestes();
  useServers.setState({ ready: true, activeId: 'b', servers: [server, { ...server, id: 'a', label: 'machine-a', baseUrl: 'http://a:8765' }] });
  configureApi({ getBaseUrl: () => 'http://a:8765', getToken: () => 'token-a', onUnauthorized: vi.fn(), origin: null, createEventSource: vi.fn() });
  fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); _limparEsfriamentoParaTestes(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('preserva opções da tela ao redesenhar o histórico sem alteração', async () => {
  fetcher.mockResolvedValue(reply({ execucoes: [], fichas: [] }));
  await render();
  const initial = navigation.screen.mock.calls.at(-1)![0];
  await render();
  expect(navigation.screen.mock.calls.at(-1)![0]).toBe(initial);
});

it('histórico lista captura máquina, preserva toda execução e trata loading vazio erro e retry', async () => {
  const pending = deferred<Response>(); fetcher.mockReturnValueOnce(pending.promise);
  await render();
  expect(container.textContent).toContain(m.orq_panel_loading());
  await act(async () => useServers.setState({ activeId: 'a' }));
  await act(async () => pending.resolve(reply({ execucoes: [run('run-1', 'display-title'), run('run-2', ' ', '/fallback-plan.md'), run('run-3', '')], fichas: [] })));
  expect(container.textContent).toContain('machine-b');
  for (const title of ['display-title', '/fallback-plan.md', 'run-3']) expect(container.textContent).toContain(title);
  expect(container.textContent).toContain('/repo/history');
  expect(container.textContent).toContain(m.orq_history_tasks({ n: 4 }));
  expect(container.textContent).toContain(m.orq_elapsed_minutes({ n: 2 }));
  expect(container.textContent).toContain('future-result');
  fetcher.mockRejectedValueOnce(new Error('history-failed'));
  await click(m.orq_history_refresh());
  expect(container.textContent).toContain('history-failed');
  expect(container.textContent).toContain('display-title');
  fetcher.mockResolvedValueOnce(reply({ execucoes: [], fichas: [] }));
  await click(m.orq_panel_retry()); expect(container.textContent).toContain(m.orq_vazio());
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['http://b:8765/api/orq', 'http://b:8765/api/orq', 'http://b:8765/api/orq']);
  await click(m.comum_voltar()); expect(navigation.back).toHaveBeenCalledOnce();
});

it('history fetch error separates the warning from smaller detail and keeps partial content', async () => {
  fetcher.mockResolvedValueOnce(reply({ execucoes: [run('run-1', 'retained-history-title')], fichas: [] }));
  await render();
  fetcher.mockRejectedValueOnce(new Error('history fetch failed: ECONNREFUSED 127.0.0.1:8765'));
  await click(m.orq_history_refresh());
  const title = container.querySelector<HTMLElement>('[role="alert"]');
  expect(title?.textContent).toBe('Could not load the orchestration.');
  const detail = [...container.querySelectorAll('span')].find(text => text.textContent === 'Error: history fetch failed: ECONNREFUSED 127.0.0.1:8765');
  expect(detail, 'complete fetch error must remain visible separately').toBeDefined();
  expect(Number.parseFloat(detail!.style.fontSize)).toBeLessThan(Number.parseFloat(title!.style.fontSize));
  expect(detail!.style.color).not.toBe(title!.style.color);
  expect(container.textContent).toContain('retained-history-title');
  fetcher.mockResolvedValueOnce(reply({ execucoes: [run('run-2', 'reloaded-history-title')], fichas: [] }));
  await click(m.orq_panel_retry());
  expect(container.textContent).toContain('reloaded-history-title');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('ECONNREFUSED');
});

it('histórico lista recusa convite e servidor removido sem consultar APIs do dono', async () => {
  navigation.params = { server: 'b' };
  useServers.setState({ activeId: 'a', servers: [{ ...server, invite: true }] });
  await render(); expect(container.textContent).toContain(m.lista_acesso_recusado()); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => useServers.setState({ servers: [] }));
  expect(container.textContent).toContain(m.chat_servidor_removido()); expect(fetcher).not.toHaveBeenCalled();
});

it('history metadata error separates the warning title from the complete smaller detail', async () => {
  const error = "Não consegui ler orq.json: FileNotFoundError: [Errno 2] No such file or directory: '/repo/history/run-1/orq.json'";
  const data = run('run-1', 'partial-history-title'); data.metadata!.error = error;
  fetcher.mockResolvedValue(reply({ execucoes: [data], fichas: [] }));
  await render();
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.startsWith('partial-history-title'))!;
  const texts = [...button.querySelectorAll('span')];
  const title = texts.find(text => text.textContent === 'Could not read the data for this run.');
  const detail = texts.find(text => text.textContent === error);
  expect(title, 'translated warning title must be separate from the technical error').toBeDefined();
  expect(detail, 'complete technical detail must remain visible').toBeDefined();
  expect(Number.parseFloat(detail!.style.fontSize)).toBeLessThan(Number.parseFloat(title!.style.fontSize));
  expect(detail!.style.color).not.toBe(title!.style.color);
  expect(button.getAttribute('aria-label')).toContain(title!.textContent);
  expect(button.getAttribute('aria-label')).toContain(error);
  expect(button.textContent).toContain('/repo/history');
  expect(button.textContent).toContain(m.orq_history_tasks({ n: 4 }));
});

it('rótulo acessível do histórico inclui metadados visíveis e erro', async () => {
  const data = run('run-1', 'accessible-title'); data.metadata!.error = 'metadata-warning';
  fetcher.mockResolvedValue(reply({ execucoes: [data], fichas: [] }));
  await render();
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.startsWith('accessible-title'))!;
  const label = button.getAttribute('aria-label');
  for (const field of ['/repo/history', m.orq_history_tasks({ n: 4 }), m.orq_elapsed_minutes({ n: 2 }), 'future-result', 'metadata-warning']) expect(label).toContain(field);
  expect(label).toContain(button.querySelectorAll('span')[2].textContent);
});

it('histórico abortado não vira concluído ao abrir o detalhe', async () => {
  const aborted = run('run-1', 'aborted-title'); aborted.resultado = 'abortada';
  const detail = panel(); detail.timing!.finished_at = '2026-10-01T10:02:00Z'; detail.errors = [{ file: 'consumption', error: 'usage-failed' }];
  fetcher.mockImplementation((url: string) => Promise.resolve(reply(url.endsWith('/api/orq') ? { execucoes: [aborted], fichas: [] } : detail)));
  await render(); expect(container.textContent).toContain(m.orq_abortada());
  await click('aborted-title'); expect(container.textContent).toContain('history-detail');
  expect([...container.querySelectorAll('span')].filter(span => span.textContent === m.orq_concluida())).toHaveLength(0);
  expect(container.textContent).toContain(m.orq_time_title());
});

it('histórico hidratação captura servidor só após carregar e fixa a escolha', async () => {
  useServers.setState({ ready: false, activeId: null, servers: [] });
  fetcher.mockResolvedValue(reply({ execucoes: [run('run-1', 'hydrated-title')], fichas: [] }));
  await render(); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => useServers.setState({ ready: true, activeId: 'b', servers: [server] }));
  expect(container.textContent).toContain('hydrated-title'); expect(container.textContent).toContain('machine-b');
  await act(async () => useServers.setState({ activeId: 'a' }));
  await click(m.orq_history_refresh());
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['http://b:8765/api/orq', 'http://b:8765/api/orq']);
});

it('histórico detalhe consulta em cinco segundos até fim e consumo resolvido sem ações vivas', async () => {
  vi.useFakeTimers();
  const pending = deferred<Response>();
  let calls = 0;
  const urls: string[] = [];
  fetcher.mockImplementation((url: string) => {
    urls.push(url);
    if (url.endsWith('/api/orq')) return Promise.resolve(reply({ execucoes: [run('run-1', 'display-title')], fichas: [] }));
    calls++;
    if (calls === 1) return pending.promise;
    const data = panel(); data.timing!.finished_at = '2026-10-01T11:00:00Z';
    if (calls >= 3) data.errors = [{ file: 'consumption', error: 'usage-failed' }];
    return Promise.resolve(reply(data));
  });
  await render(); await click('display-title');
  expect(container.textContent).toContain(m.orq_panel_loading());
  expect(urls).toContain('http://b:8765/api/orq/run-1/panel');
  await act(async () => pending.resolve(reply(panel())));
  expect(container.textContent).toContain('history-detail'); expect(container.textContent).toContain('history-question');
  expect(container.textContent).toContain(m.orq_use_computing());
  expect(container.textContent).not.toContain(m.orq_open_parecer()); expect(container.textContent).not.toContain(m.orq_talk_to_arbiter());
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('old-arbiter'))).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(5_000)); expect(calls).toBe(2);
  expect(container.textContent).toContain(m.orq_use_computing());
  await act(async () => vi.advanceTimersByTimeAsync(5_000)); expect(calls).toBe(3);
  expect(container.textContent).toContain('usage-failed'); expect(container.textContent).not.toContain(m.orq_use_computing());
  await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(calls).toBe(3);
  await click(m.orq_history_back()); expect(container.textContent).toContain('display-title'); expect(container.textContent).not.toContain('history-detail');
  expect(urls.filter(url => url.endsWith('/api/orq'))).toHaveLength(2);
  expect(urls.every(url => url.startsWith('http://b:8765/'))).toBe(true);
});

it('histórico detalhe pausa foco e AppState e descarta retorno de detalhe fechado', async () => {
  vi.useFakeTimers();
  let appState: ((state: string) => void) | undefined;
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { appState = listener as (state: string) => void; return { remove() {} } as never; });
  const old = deferred<Response>(); let calls = 0;
  fetcher.mockImplementation((url: string) => {
    if (url.endsWith('/api/orq')) return Promise.resolve(reply({ execucoes: [run('run-1', 'display-title')], fichas: [] }));
    calls++; return calls === 3 ? old.promise : Promise.resolve(reply(panel()));
  });
  await render(); await click('display-title'); expect(calls).toBe(1);
  navigation.focused = false; await render();
  await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(calls).toBe(1);
  navigation.focused = true; await render(); expect(calls).toBe(2);
  await act(async () => appState!('background'));
  await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(calls).toBe(2);
  await act(async () => appState!('active')); expect(calls).toBe(3);
  await click(m.orq_history_back());
  await act(async () => old.resolve(reply(panel())));
  expect(container.textContent).toContain('display-title'); expect(container.textContent).not.toContain('history-detail');
  await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(calls).toBe(3);
});
