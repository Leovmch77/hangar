// @vitest-environment happy-dom
import { act, createElement, type FormEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureApi, type SearchHit, type Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({ search: vi.fn(), ask: vi.fn(), context: vi.fn(), push: vi.fn(), replace: vi.fn(), focused: true, canGoBack: true,
  options: null as { title?: string; headerShown?: boolean; headerTransparent?: boolean; headerLeft?: () => ReactNode } | null,
  edges: undefined as string[] | undefined, listInset: undefined as string | undefined }));
const state = vi.hoisted(() => ({ activeId: 'b', servers: [] as Server[] }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(),
  searchTranscriptsForServer: h.search, askHistoryForServer: h.ask, getSearchContextForServer: h.context,
}));
vi.mock('../../stores/servers', () => ({ useServers: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push, replace: h.replace, back: () => {}, canGoBack: () => h.canGoBack }), useIsFocused: () => h.focused,
  Stack: { Screen: ({ options }: { options: NonNullable<typeof h.options> }) => { h.options = options; return options.headerLeft?.() ?? null; } } }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 88 }));
vi.mock('expo-blur', async () => ({ BlurView: (await import('react-native')).View }));
vi.mock('expo-glass-effect', async () => ({ GlassView: (await import('react-native')).View, isLiquidGlassAvailable: () => false }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/Screen', () => ({ Screen: ({ children, edges }: { children: ReactNode; edges?: string[] }) => {
  h.edges = edges; return createElement('div', null, children);
} }));
vi.mock('../../chat/AssistantBubble', () => ({ AssistantBubble: ({ text }: { text: string }) => createElement('article', { 'data-markdown': true }, text) }));
vi.mock('react-native', async (original) => ({ ...await original<typeof import('react-native')>(),
  Platform: { OS: 'ios' },
  FlatList: ({ data, renderItem, ListHeaderComponent, contentInsetAdjustmentBehavior }: { data: { server: Server; hit: SearchHit }[]; renderItem: (row: { item: unknown }) => ReactNode; ListHeaderComponent: ReactNode; contentInsetAdjustmentBehavior?: string }) => {
    h.listInset = contentInsetAdjustmentBehavior;
    return createElement('div', null, ListHeaderComponent, ...data.map((item) => createElement('div', { key: `${item.server.id}:${item.hit.event_id}` }, renderItem({ item }))));
  },

  TextInput: ({ value, onChangeText, accessibilityLabel }: { value: string; onChangeText: (s: string) => void; accessibilityLabel: string }) =>
    createElement('input', { value, 'aria-label': accessibilityLabel, onInput: (e: FormEvent<HTMLInputElement>) => onChangeText(e.currentTarget.value) }),
}));
import SearchScreen from '../../../app/search';

const roots: Root[] = [];
const hit = (patch: Partial<SearchHit> = {}): SearchHit => ({ project: 'proj', session_id: 'sid', session_name: 'live-a',
  cwd: '/repo', line: 'agulha azul', mtime: 3, live: true, event_id: 'ev-a', role: 'assistant', ...patch });
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount() { const container = document.createElement('div'); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(createElement(SearchScreen))); return { container, root }; }
async function typeQuery(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('input');
  expect(input, 'campo de busca acessível').not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true })); input!.dispatchEvent(new Event('change', { bubbles: true })); });
}
const buttons = (container: HTMLElement, label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.getAttribute('aria-label') === label || b.textContent === label);
async function tick(ms = 250) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); h.focused = true; h.canGoBack = true; h.options = null; h.edges = undefined; h.listInset = undefined;
  state.activeId = 'b'; state.servers = [
    { id: 'a', label: 'A', baseUrl: 'https://a.test', token: 'a' },
    { id: 'b', label: 'B', baseUrl: 'https://b.test', token: 'b' },
    { id: 'guest', label: 'guest', baseUrl: 'https://guest.test', token: 'g', invite: true },
    { id: 'removed', label: 'removed', baseUrl: 'https://removed.test', token: 'r', removed: true },
    { id: 'disabled', label: 'disabled', baseUrl: 'https://disabled.test', token: 'd', disabled: true },
  ];
  configureApi({ getBaseUrl: () => state.servers[1].baseUrl, getToken: () => 'b', onUnauthorized: () => {}, origin: null,
    createEventSource: () => { throw new Error('unexpected SSE'); } });
  h.search.mockResolvedValue([]); h.context.mockResolvedValue([]);
});
afterEach(() => { act(() => { for (const root of roots.splice(0)) root.unmount(); }); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('busca usa cabeçalho nativo e recuo medido, com voltar próprio só em link direto', async () => {
  const { container, root } = await mount();
  expect(h.options?.headerShown).toBe(true);
  expect(h.options?.headerTransparent).toBe(true);
  expect(h.options?.title).toBe(m.switcher_buscar_conversas());
  expect(h.options?.headerLeft).toBeUndefined();
  expect(container.querySelector('[role="header"]')).toBeNull();
  expect(h.edges).not.toContain('top');
  expect(container.querySelector('input')?.parentElement?.style.marginTop).toBe('88px');
  expect(h.listInset).toBe('automatic');
  h.canGoBack = false; await act(async () => root.render(createElement(SearchScreen)));
  const back = buttons(container, m.comum_voltar())[0]; expect(back).toBeDefined();
  await act(async () => back.click()); expect(h.replace).toHaveBeenCalledExactlyOnceWith('/');
});

it('recuperação contextual e controles têm alvo mínimo de toque', async () => {
  h.search.mockImplementation((server: Server) => Promise.resolve(server.id === 'a' ? [hit()] : []));
  h.context.mockRejectedValueOnce(new Error('503 contexto indisponível'));
  const { container } = await mount(); await typeQuery(container, 'agulha'); await tick();
  const snippet = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('agulha azul'))!;
  await act(async () => snippet.click());
  const retry = buttons(container, m.busca_tentar_de_novo())[0]; expect(retry, 'repetir contexto é botão').toBeDefined();
  for (const control of container.querySelectorAll<HTMLButtonElement>('button')) {
    expect(parseFloat(control.style.minHeight || control.style.height)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(control.style.minWidth || control.style.width)).toBeGreaterThanOrEqual(44);
  }
  h.context.mockResolvedValueOnce([{ id: 'ev-a', kind: 'assistant_msg', text: 'recuperado' }]);
  await act(async () => retry.click()); expect(container.textContent).toContain('recuperado');
});

it('busca progressiva espera debounce, preserva sucessos e repete só a máquina que falhou', async () => {
  const b = deferred<SearchHit[]>();
  h.search.mockImplementation((server: Server) => server.id === 'a' ? Promise.resolve([hit(), hit(), hit({ event_id: 'ev-old', line: 'antiga', ts: 1 })]) : b.promise);
  const { container } = await mount(); await typeQuery(container, 'agulha');
  await tick(249); expect(h.search).not.toHaveBeenCalled(); await tick(1);
  expect(h.search.mock.calls.map(([s]) => s.id)).toEqual(['a', 'b']);
  expect(container.textContent).toContain('agulha azul');
  expect(buttons(container, m.busca_abrir_ponto())).toHaveLength(2);
  await act(async () => b.reject(new Error('503 indisponível')));
  expect(container.textContent).toContain('503 indisponível');
  expect(container.textContent).toContain('agulha azul');
  h.search.mockResolvedValueOnce([hit({ event_id: 'ev-b', line: 'mais recente', ts: 9 })]);
  await act(async () => buttons(container, m.busca_tentar_de_novo())[0].click());
  expect(h.search.mock.calls.map(([s]) => s.id)).toEqual(['a', 'b', 'b']);
  expect(container.textContent!.indexOf('mais recente')).toBeLessThan(container.textContent!.indexOf('agulha azul'));
  expect(container.textContent).not.toContain('503 indisponível');
});

it.each(['todas falham', 'vazio com falha', 'sem máquinas'])('não anuncia ausência de resultados quando %s', async (scenario) => {
  if (scenario === 'sem máquinas') state.servers = [];
  h.search.mockImplementation((server: Server) => scenario === 'vazio com falha' && server.id === 'a'
    ? Promise.resolve([]) : Promise.reject(new Error('503 busca indisponível')));
  const { container } = await mount(); await typeQuery(container, 'agulha'); await tick();
  expect(container.textContent).not.toContain(m.busca_nenhum_resultado());
  expect(container.textContent).toContain(scenario === 'sem máquinas' ? m.busca_sem_servidores() : '503 busca indisponível');
});

it('resposta velha não entra durante debounce novo nem depois de perder foco', async () => {
  const old = deferred<SearchHit[]>(); h.search.mockReturnValue(old.promise);
  const { container, root } = await mount(); await typeQuery(container, 'velha'); await tick();
  await typeQuery(container, 'nova'); await act(async () => old.resolve([hit({ line: 'não mostrar' })]));
  expect(container.textContent).not.toContain('não mostrar');
  h.search.mockResolvedValue([hit({ line: 'nova resposta' })]); await tick(); expect(container.textContent).toContain('nova resposta');
  const hidden = deferred<SearchHit[]>(); h.search.mockReturnValue(hidden.promise);
  await typeQuery(container, 'oculta'); await tick(); h.focused = false;
  await act(async () => root.render(createElement(SearchScreen)));
  await act(async () => hidden.resolve([hit({ line: 'resposta escondida' })]));
  expect(container.textContent).not.toContain('resposta escondida');
  expect(buttons(container, m.busca_abrir_ponto())).toHaveLength(0);
});

it('Perguntar usa só ativo próprio e não publica resposta de pergunta anterior', async () => {
  const old = deferred<{ answer: string; hits: SearchHit[] }>(); h.ask.mockReturnValueOnce(old.promise);
  const { container } = await mount(); await typeQuery(container, 'primeira'); await tick();
  await act(async () => buttons(container, m.switcher_perguntar())[0].click());
  expect(h.ask).toHaveBeenCalledWith(state.servers[1], 'primeira');
  await typeQuery(container, 'segunda'); await act(async () => old.resolve({ answer: '**antiga**', hits: [hit()] }));
  expect(container.textContent).not.toContain('antiga'); await tick();
  h.ask.mockResolvedValueOnce({ answer: '**nova**', hits: [hit({ line: 'fonte da resposta', event_id: 'ask-hit' })] });
  await act(async () => buttons(container, m.switcher_perguntar())[0].click());
  expect(container.querySelector('[data-markdown]')?.textContent).toBe('**nova**');
  expect(container.textContent).toContain('fonte da resposta');
});

it.each(['foco', 'query'])('Perguntar permite nova tentativa ao retornar pela mesma %s', async (change) => {
  const old = deferred<{ answer: string; hits: SearchHit[] }>();
  h.ask.mockReturnValueOnce(old.promise);
  const { container, root } = await mount(); await typeQuery(container, 'agulha'); await tick();
  await act(async () => buttons(container, m.switcher_perguntar())[0].click());
  if (change === 'foco') {
    h.focused = false; await act(async () => root.render(createElement(SearchScreen)));
    h.focused = true; await act(async () => root.render(createElement(SearchScreen)));
  } else {
    await typeQuery(container, 'outra'); await typeQuery(container, 'agulha');
  }
  const retry = buttons(container, m.switcher_perguntar())[0];
  expect(retry, 'Perguntar disponível ao voltar').toBeDefined();
  expect(retry.disabled).toBe(false);
  h.ask.mockResolvedValueOnce({ answer: '**nova tentativa**', hits: [] });
  await act(async () => retry.click());
  expect(h.ask).toHaveBeenCalledTimes(2);
  await act(async () => old.resolve({ answer: 'obsoleta', hits: [] }));
  expect(container.querySelector('[data-markdown]')?.textContent).toBe('**nova tentativa**');
  expect(container.textContent).not.toContain('obsoleta');
});

it('contexto do assistente usa Markdown e abre ponto com identidade explícita', async () => {
  h.search.mockImplementation((server: Server) => Promise.resolve(server.id === 'a' ? [hit()] : []));
  h.context.mockResolvedValue([{ id: 'ev-a', kind: 'assistant_msg', text: '**agulha azul**' }]);
  const { container } = await mount(); await typeQuery(container, 'agulha'); await tick();
  const snippet = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('agulha azul'))!;
  await act(async () => snippet.click());
  expect(container.querySelector('[data-markdown]')?.textContent).toBe('**agulha azul**');
  await act(async () => buttons(container, m.busca_abrir_ponto())[0].click());
  expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/search-point', params: {
    server: 'a', project: 'proj', sid: 'sid', eventId: 'ev-a', name: 'live-a',
  } });
});

it('expande vizinhança de A sem trocar servidor ativo', async () => {
  h.search.mockImplementation((server: Server) => Promise.resolve(server.id === 'a' ? [hit()] : []));
  h.context.mockResolvedValue([{ id: 'before', kind: 'user_msg', text: 'vizinha anterior' }, { id: 'ev-a', kind: 'assistant_msg', text: 'agulha azul' }]);
  const { container } = await mount(); await typeQuery(container, 'agulha'); await tick();
  const snippet = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('agulha azul'))!;
  expect(snippet).toBeDefined(); await act(async () => snippet.click());
  expect(h.context).toHaveBeenCalledExactlyOnceWith(state.servers[0], 'proj', 'sid', 'ev-a');
  expect(container.textContent).toContain('vizinha anterior'); expect(state.activeId).toBe('b');
});
