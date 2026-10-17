// @vitest-environment happy-dom
import { act, createElement, useEffect, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, Server, StateEvent, SubagentRun, WorkflowAgentDetail, WorkflowDetail, WorkflowSummary } from '@hangar/core';
import type { PressableProps, ScrollViewProps, TextInputProps, ViewProps } from 'react-native';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getWorkflows: vi.fn(), getWorkflow: vi.fn(), getWorkflowAgent: vi.fn(), getSubagents: vi.fn(), getSubagent: vi.fn() }));
const route = vi.hoisted(() => ({ params: { server: 'a', name: 'sess' }, back: vi.fn(), focused: true }));
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const nativeBack = vi.hoisted(() => ({ listeners: new Set<() => boolean>() }));
const stores = vi.hoisted(() => ({ servers: [
  { id: 'a', label: 'A', baseUrl: 'https://a.test', token: 'token-a' },
  { id: 'b', label: 'B', baseUrl: 'https://b.test', token: 'token-b' },
] as Server[], activeId: 'b', chat: { events: [] as ChatEvent[], eventsRevision: 0, stateEvent: null as Pick<StateEvent, 'shells'> | null } }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...api }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => route.params,
  useRouter: () => ({ back: route.back }),
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => route.focused ? effect() : undefined, [effect, route.focused]),
  Stack: { Screen: ({ options }: { options: { headerShown?: boolean; title?: string; headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) =>
    platform.OS === 'android' || options.headerShown === false ? null : createElement('header', { 'data-shown': String(options.headerShown) },
      options.headerLeft?.(), createElement('h1', null, options.title), options.headerRight?.()) },
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 64 }));
vi.mock('../../stores/servers', () => ({ useServers: Object.assign(
  (select: (state: typeof stores) => unknown) => select(stores), { getState: () => stores },
) }));
vi.mock('../../stores/chat', () => ({ chatStore: () => ({ use: (select: (state: typeof stores.chat) => unknown) => select(stores.chat) }) }));
vi.mock('../../stores/aparencia', () => ({ useAparencia: (select: (state: unknown) => unknown) => select({ pensamentoTools: 'busca' }) }));
vi.mock('react-native', async (original) => {
  const native = await original<typeof import('react-native')>();
  const Pressable = native.Pressable as ComponentType<Record<string, unknown>>;
  const View = native.View as ComponentType<Record<string, unknown>>;
  return { ...native, Platform: { get OS() { return platform.OS; }, select: (values: { ios?: unknown; android?: unknown; default?: unknown }) => values[platform.OS] ?? values.default },
    View: ({ style, accessibilityLiveRegion, accessible, ...props }: ViewProps) => {
      const flat = Object.assign({}, ...(Array.isArray(style) ? (style as unknown[]).flat(Infinity) : [style]).filter(Boolean));
      return createElement(View, { ...props, style, 'data-padding-horizontal': flat.paddingHorizontal, 'data-accessible': accessible, 'aria-live': accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion });
    },
    TextInput: ({ onChangeText, editable, multiline: _, placeholderTextColor: __, ...props }: TextInputProps) =>
      createElement(native.TextInput as ComponentType<Record<string, unknown>>, { ...props, readOnly: editable === false,
        onChange: (event: { currentTarget: { value: string } }) => onChangeText?.(event.currentTarget.value) }),
    BackHandler: { addEventListener: (event: string, listener: () => boolean) => {
      if (event === 'hardwareBackPress') nativeBack.listeners.add(listener);
      return { remove: () => { nativeBack.listeners.delete(listener); } };
    } },
    Pressable: ({ hitSlop, accessibilityState, ...props }: PressableProps) => createElement(Pressable, { ...props, 'data-hit-slop': hitSlop, 'aria-expanded': accessibilityState?.expanded }),
    ScrollView: ({ contentInsetAdjustmentBehavior, contentContainerStyle, showsVerticalScrollIndicator: _, ...props }: ScrollViewProps) =>
      createElement(View, { ...props, 'data-scroll': true, 'data-inset': contentInsetAdjustmentBehavior },
        createElement(View, { style: contentContainerStyle }, props.children as ReactNode)),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const native = await import('react-native');
  const View = native.View as ComponentType<Record<string, unknown>>;
  return { useSafeAreaInsets: () => ({ top: 20, bottom: 34, left: 0, right: 0 }),
    SafeAreaView: ({ edges, ...props }: { edges: string[]; children?: ReactNode }) => createElement(View, { ...props, 'data-edges': edges.join(',') }) };
});
vi.mock('react-native-keyboard-controller', async () => {
  const { View } = await import('react-native');
  return { KeyboardAvoidingView: ({ behavior, automaticOffset, ...props }: ViewProps & { behavior?: string; automaticOffset?: boolean }) =>
    createElement(View, { ...props, 'data-keyboard-behavior': behavior, 'data-keyboard-offset': String(automaticOffset) } as ViewProps) };
});
vi.mock('expo-blur', () => ({ BlurView: () => null }));
vi.mock('expo-glass-effect', () => ({ GlassView: () => null, isLiquidGlassAvailable: () => false }));
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('article', null, markdown) }));
vi.mock('expo-audio', () => ({ createAudioPlayer: vi.fn(), useAudioPlayer: vi.fn(), useAudioPlayerStatus: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: 'cache' } }));
vi.mock('expo-intent-launcher', () => ({ startActivityAsync: vi.fn() }));
vi.mock('react-native-mmkv', () => ({ createMMKV: () => ({ getString: () => undefined, set: () => {}, remove: () => {} }) }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));
vi.mock('react-native-gifted-charts', () => ({ BarChart: () => null }));
vi.mock('@lodev09/react-native-true-sheet', () => ({ TrueSheet: () => null }));
vi.mock('@legendapp/list/react-native', () => ({ LegendList: ({ data, renderItem }: { data: { id: string }[]; renderItem: (row: { item: unknown }) => ReactNode }) =>
  createElement('div', { 'data-virtual-list': true }, data.map((item) => createElement('div', { key: item.id }, renderItem({ item })))) }));

import { configureLocale } from '@hangar/core';
import { overwriteGetLocale } from '../../paraglide/runtime';
import * as m from '../../paraglide/messages';
import ActivitySheet from '../../../app/s/[server]/[name]/activity';

const workflow: WorkflowSummary = { runId: 'run-1', name: 'Revisão mobile', status: 'running', agentCount: 1, phaseCount: 0, totalTokens: 100, durationMs: 1000, startTime: 1, running: true };
const detail: WorkflowDetail = { runId: 'run-1', name: 'Revisão mobile', status: 'running', totalTokens: 100, durationMs: 1000, summary: null, phases: [], agents: [
  { agentId: 'reviewer', label: 'Revisor mobile', phaseTitle: null, state: 'progress', model: null, tokens: 100, durationMs: 1000, toolCalls: 0, lastToolName: null, lastToolSummary: null, resultPreview: null },
] };
const agent: WorkflowAgentDetail = { agentId: 'reviewer', label: 'Revisor mobile', phaseTitle: null, state: 'progress', model: null, tokens: 100, durationMs: 1000, toolCalls: 0, prompt: 'Conferir a tela', result: null, tools: [], lastToolName: null, lastToolTarget: null };
const sub: SubagentRun = { agentId: 'sub-1', agentType: 'Explore', prompt: 'Conferir atividade', startedAt: '', updatedAt: '', mtime: 1, toolCalls: 0, tools: [], recent: [], lastText: '', events: [] };
const events: ChatEvent[] = [
  { id: 'todos', kind: 'tool_use', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Conferir cabeçalho', status: 'completed' }, { content: 'Conferir retorno', status: 'pending' }] } },
  { id: 'launch', kind: 'tool_use', tool_use_id: 'launch', tool_name: 'Agent', tool_input: { description: 'Conferir atividade', prompt: 'Conferir atividade', subagent_type: 'Explore' } },
];
const roots = new Set<Root>();
async function mount() {
  const el = document.createElement('div');
  const root = createRoot(el);
  roots.add(root);
  const render = () => act(async () => root.render(createElement(ActivitySheet)));
  await render();
  return { el, render, unmount: async () => { await act(async () => root.unmount()); roots.delete(root); } };
}
async function hardwareBackPress() {
  let handled = false;
  await act(async () => {
    handled = [...nativeBack.listeners].reverse().some((listener) => listener());
    // Fronteira nativa do router: sem consumo, o BackHandler fecha a rota.
    if (!handled) route.back();
  });
  return handled;
}
function button(el: HTMLElement, label: string) {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.getAttribute('aria-label') === label || node.textContent?.includes(label));
  expect(found, `botão ${label}`).toBeDefined();
  return found!;
}
const click = async (el: HTMLElement, label: string) => act(async () => button(el, label).click());
function section(el: HTMLElement, label: string) {
  const heading = [...el.querySelectorAll('span')].find((node) => node.textContent === label);
  expect(heading, `seção ${label}`).toBeDefined();
  return heading!.parentElement!;
}
function expectHeader(el: HTMLElement, title: string) {
  expect(el.querySelector('header')?.getAttribute('data-shown')).toBe('true');
  expect(el.querySelector('header h1')?.textContent).toBe(title);
  expect(el.querySelector('[data-edges] [role="header"]')).toBeNull();
}
function expectAndroidHeader(el: HTMLElement, title: string) {
  expect(el.querySelector('header')).toBeNull();
  const heading = el.querySelector('[role="header"]');
  expect(heading?.textContent).toBe(title);
  const bar = heading!.parentElement!;
  expect(bar.parentElement).toBe(el.querySelector('[data-edges]'));
  expect(bar.closest('[data-scroll]')).toBeNull();
  expect((el.querySelector('[data-edges]') as HTMLElement).style.paddingTop).toBe('0px');
  return bar;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0));
  overwriteGetLocale(() => 'pt');
  configureLocale({ getLocale: () => 'pt' });
  route.params = { server: 'a', name: 'sess' };
  platform.OS = 'ios';
  route.focused = true;
  nativeBack.listeners.clear();
  stores.chat.events = events;
  stores.chat.eventsRevision = 0;
  stores.chat.stateEvent = null;
  api.getWorkflows.mockResolvedValue([workflow]);
  api.getSubagents.mockResolvedValue([sub]);
  api.getWorkflow.mockResolvedValue(detail);
  api.getWorkflowAgent.mockResolvedValue(agent);
  api.getSubagent.mockResolvedValue(sub);
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  vi.useRealTimers();
});

describe('ActivitySheet real', () => {
  it.each(['pai encerrou', 'backend encerrou com pai rodando'])('mantém concluído em Terminados sem duplicar: %s', async (source) => {
    stores.chat.events = source === 'pai encerrou'
      ? [...events, { id: 'end', kind: 'tool_result', tool_use_id: 'launch', result: 'fim' }]
      : events;
    api.getSubagents.mockResolvedValue([
      { ...sub, updatedAt: new Date(2026, 9, 17, 11, 0, 0).toISOString(), ...(source === 'pai encerrou' ? {} : { state: 'finished' }) },
      { ...sub, agentId: 'live', prompt: 'Ainda trabalhando', state: 'running' },
    ]);
    const { el } = await mount();
    expect(el.textContent).toContain(m.atividade_grupo_terminados({ n: 1 }));
    expect(el.textContent).toContain(m.atividade_grupo_rodando({ n: 1 }));
    const completed = button(el, 'Conferir atividade');
    expect(completed.textContent).toContain(m.atividade_terminou({ h: '11:00' }));
    expect([...el.querySelectorAll('button')].filter(node => node.textContent?.includes('Conferir atividade'))).toHaveLength(1);
    expect(button(el, 'Ainda trabalhando').textContent).not.toContain(m.atividade_sub_concluido());
  });

  it('separa Mais antigos pela meia-noite local e permite expandir e recolher', async () => {
    stores.chat.events = [];
    api.getWorkflows.mockResolvedValue([]);
    api.getSubagents.mockResolvedValue([
      { ...sub, agentId: 'today', prompt: 'Concluiu hoje', state: 'finished', endedAt: new Date(2026, 9, 17, 11, 45, 0).toISOString() },
      { ...sub, agentId: 'failed', prompt: 'Falhou hoje', state: 'failed', endedAt: new Date(2026, 9, 17, 11, 30, 0).toISOString() },
      { ...sub, agentId: 'midnight', prompt: 'Concluiu à meia-noite', state: 'finished', endedAt: new Date(2026, 9, 17, 0, 0, 0).toISOString() },
      { ...sub, agentId: 'old', prompt: 'Concluiu ontem', state: 'finished', endedAt: new Date(2026, 9, 16, 23, 59, 59).toISOString() },
    ]);
    const { el } = await mount();
    expect(el.textContent).toContain(m.atividade_grupo_terminados({ n: 4 }));
    expect(button(el, 'Concluiu hoje').textContent).toContain(m.atividade_terminou({ h: '11:45' }));
    expect(button(el, 'Falhou hoje').textContent).toContain(m.atividade_parou({ h: '11:30' }));
    expect(button(el, 'Concluiu à meia-noite').textContent).toContain(m.atividade_terminou({ h: '00:00' }));
    const olderLabel = m.atividade_grupo_antigos({ n: 1 });
    expect(button(el, olderLabel).getAttribute('aria-expanded')).toBe('false');
    expect(el.textContent).not.toContain('Concluiu ontem');
    await click(el, olderLabel);
    expect(button(el, olderLabel).getAttribute('aria-expanded')).toBe('true');
    expect(button(el, 'Concluiu ontem').textContent).toContain(m.atividade_terminou({ h: '23:59' }));
    await click(el, olderLabel);
    expect(el.textContent).not.toContain('Concluiu ontem');
  });

  it.each(['sem estado', 'rodando explícito'])('mostra sem notícia e problemas sem inventar conclusão ou chamadas: %s', async (source) => {
    api.getWorkflows.mockResolvedValue([]);
    api.getSubagents.mockResolvedValue([
      { ...sub, ilegivel: true, problema: 'Arquivo não pôde ser lido', ...(source === 'rodando explícito' ? { state: 'running' } : {}) },
      { ...sub, agentId: 'silent', prompt: 'Sem atualização', updatedAt: new Date(2026, 9, 17, 11, 49, 59).toISOString() },
      { ...sub, agentId: 'problem', prompt: 'Erro de leitura', problema: 'Acesso recusado' },
      { ...sub, agentId: 'live', prompt: 'Estado explícito vence', state: 'running', finished: true },
    ]);
    const { el } = await mount();
    expect(button(el, 'Sem atualização').textContent).toContain(m.atividade_sem_noticia({ t: '10 min' }));
    expect(button(el, 'Sem atualização').textContent).not.toContain(m.atividade_sub_concluido());
    expect(el.textContent).toContain(m.atividade_grupo_rodando({ n: source === 'rodando explícito' ? 2 : 1 }));
    expect(el.textContent).not.toContain(m.atividade_grupo_terminados({ n: 1 }));
    const unreadable = button(el, 'Conferir atividade');
    expect(unreadable.textContent).toContain(m.atividade_sub_ilegivel());
    expect(unreadable.textContent).toContain('Arquivo não pôde ser lido');
    expect(unreadable.textContent).not.toContain(m.atividade_chamadas({ n: 0 }));
    const problem = button(el, 'Erro de leitura');
    expect(problem.textContent).toContain('Acesso recusado');
    expect(problem.textContent).not.toContain(m.atividade_chamadas({ n: 0 }));
    expect(button(el, 'Estado explícito vence').textContent).not.toContain(m.atividade_sub_concluido());
    expect([...el.querySelectorAll('button')].filter(node => node.textContent?.includes('Conferir atividade'))).toHaveLength(1);
  });

  it.each(['sem estado', 'rodando explícito'])('traduz problema real do backend preservando aviso: %s', async (source) => {
    api.getSubagents.mockResolvedValue([{ ...sub, problema: 'erro_subagente_estado_indisponivel', ...(source === 'rodando explícito' ? { state: 'running' } : {}) }]);
    const { el } = await mount();
    const row = button(el, 'Conferir atividade');
    expect(row.textContent).toContain(m.erro_subagente_estado_indisponivel());
    expect(row.textContent).not.toContain('erro_subagente_estado_indisponivel');
    expect(row.textContent).not.toContain(m.atividade_chamadas({ n: 0 }));
  });

  it.each(['android', 'ios'] as const)('seções de subagentes não misturam rodando, sem notícia e terminados: %s', async (os) => {
    platform.OS = os;
    stores.chat.events = [...events, { id: 'shell', kind: 'tool_use', tool_use_id: 'shell', tool_name: 'Bash', tool_input: { command: 'npm run watch', description: 'Monitorar app', run_in_background: true } }];
    stores.chat.stateEvent = { shells: [{ pid: 321, cmd: 'node worker.js', desde: Date.now() / 1000 - 60 }] };
    api.getSubagents.mockResolvedValue([
      { ...sub, state: 'running' },
      { ...sub, agentId: 'live', prompt: 'Rodando sem pai', state: 'running' },
      { ...sub, agentId: 'silent', prompt: 'Sem atualização', updatedAt: new Date(2026, 9, 17, 11, 49, 59).toISOString() },
      { ...sub, agentId: 'unknown', prompt: 'Estado indisponível', ilegivel: true, problema: 'erro_subagente_estado_indisponivel' },
      { ...sub, agentId: 'done', prompt: 'Concluiu hoje', state: 'finished', endedAt: new Date(2026, 9, 17, 11, 0, 0).toISOString() },
      { ...sub, agentId: 'failed', prompt: 'Falhou hoje', state: 'failed', endedAt: new Date(2026, 9, 17, 11, 30, 0).toISOString() },
      { ...sub, agentId: 'old', prompt: 'Concluiu ontem', state: 'finished', endedAt: new Date(2026, 9, 16, 23, 59, 59).toISOString() },
    ]);
    const { el } = await mount();
    const running = section(el, m.atividade_grupo_rodando({ n: 2 }));
    expect(running.contains(button(el, 'Sem atualização'))).toBe(false);
    expect(running.contains(button(el, 'Estado indisponível'))).toBe(false);
    expect(running.contains(button(el, 'Conferir atividade'))).toBe(true);
    expect(running.contains(button(el, 'Rodando sem pai'))).toBe(true);
    const uncertain = section(el, m.atividade_subagentes());
    expect(uncertain.contains(button(el, 'Sem atualização'))).toBe(true);
    expect(uncertain.contains(button(el, 'Estado indisponível'))).toBe(true);
    expect(uncertain.contains(button(el, 'Conferir atividade'))).toBe(false);
    expect(uncertain.contains(button(el, 'Concluiu hoje'))).toBe(false);
    expect(button(uncertain, 'Sem atualização').textContent).toContain(m.atividade_sem_noticia({ t: '10 min' }));
    const unknown = button(uncertain, 'Estado indisponível');
    expect(unknown.textContent).toContain(m.atividade_sub_ilegivel());
    expect(unknown.querySelector('[role="alert"]')?.textContent).toBe(m.erro_subagente_estado_indisponivel());
    expect(unknown.textContent).not.toContain(m.atividade_chamadas({ n: 0 }));
    const finished = section(el, m.atividade_grupo_terminados({ n: 3 }));
    expect(finished.contains(button(el, 'Concluiu hoje'))).toBe(true);
    expect(finished.contains(button(el, 'Falhou hoje'))).toBe(true);
    expect(finished.contains(button(el, 'Sem atualização'))).toBe(false);
    expect(finished.contains(unknown)).toBe(false);
    expect(el.textContent).not.toContain('Concluiu ontem');
    await click(el, m.atividade_grupo_antigos({ n: 1 }));
    expect(finished.contains(button(el, 'Concluiu ontem'))).toBe(true);
    for (const label of ['npm run watch', 'node worker.js']) {
      const shell = el.querySelector(`[aria-label="${label}"]`);
      expect(shell).not.toBeNull();
      expect(running.contains(shell)).toBe(false);
      expect(uncertain.contains(shell)).toBe(false);
      expect(finished.contains(shell)).toBe(false);
    }
    expect(el.textContent).toContain(m.atividade_shells());
    expect(el.textContent).toContain(m.atividade_processos());
    expect(api.getSubagents).toHaveBeenCalledWith('sess', stores.servers[0]);
  });

  it.each(['android', 'ios'] as const)('seções de subagentes sem estado ativo não mostram Rodando 0: %s', async (os) => {
    platform.OS = os;
    stores.chat.events = [];
    api.getWorkflows.mockResolvedValue([]);
    api.getSubagents.mockResolvedValue([
      { ...sub, agentId: 'silent', prompt: 'Sem atualização' },
      { ...sub, agentId: 'unknown', prompt: 'Estado indisponível', problema: 'Acesso recusado' },
    ]);
    const { el } = await mount();
    expect(el.textContent).not.toContain(m.atividade_grupo_rodando({ n: 0 }));
    const uncertain = section(el, m.atividade_subagentes());
    expect(uncertain.contains(button(el, 'Sem atualização'))).toBe(true);
    expect(uncertain.contains(button(el, 'Estado indisponível'))).toBe(true);
    expect(el.textContent).not.toContain(m.atividade_grupo_terminados({ n: 2 }));
    expect(el.textContent).not.toContain(m.atividade_sub_concluido());
  });

  it('usa ícone e alvo de toque de 44 nas linhas de subagentes', async () => {
    api.getSubagents.mockResolvedValue([sub, { ...sub, agentId: 'orphan', prompt: 'Sem pai', state: 'running' }]);
    const { el } = await mount();
    for (const title of ['Conferir atividade', 'Sem pai']) {
      const row = button(el, title);
      expect(row.querySelector('[data-symbol="chevron.right"]')).not.toBeNull();
      expect(row.textContent).not.toContain('›');
      expect(Number.parseFloat(row.style.minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  it.each(['workflows', 'subagentes'])('isola carga do destino B de resposta atrasada de A: %s', async (waiting) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    stores.chat.events = [];
    const workflowsA = Promise.withResolvers<WorkflowSummary[]>();
    const subsA = Promise.withResolvers<SubagentRun[]>();
    const workflowsB = Promise.withResolvers<WorkflowSummary[]>();
    const subsB = Promise.withResolvers<SubagentRun[]>();
    const oldWorkflow = { ...workflow, name: 'Fluxo da máquina A' };
    const newWorkflow = { ...workflow, name: 'Fluxo da máquina B' };
    api.getWorkflows.mockImplementation((_: string, server: Server) => server.id === 'a'
      ? waiting === 'workflows' ? workflowsA.promise : Promise.resolve([oldWorkflow])
      : workflowsB.promise);
    api.getSubagents.mockImplementation((_: string, server: Server) => server.id === 'a' ? subsA.promise : subsB.promise);
    const { el, render } = await mount();
    route.params = { server: 'b', name: 'outra' };
    await render();
    expect(el.textContent).not.toContain('Fluxo da máquina A');
    expect(el.textContent).not.toContain('Subagente da máquina A');
    await act(async () => { workflowsB.resolve([newWorkflow]); });
    await act(async () => { subsB.resolve([{ ...sub, prompt: 'Subagente da máquina B', state: 'running' }]); });
    expect(el.textContent).toContain('Fluxo da máquina B');
    expect(el.textContent).toContain('Subagente da máquina B');
    await act(async () => { workflowsA.resolve([oldWorkflow]); });
    await act(async () => { subsA.resolve([{ ...sub, prompt: 'Subagente da máquina A', state: 'running' }]); });
    expect(el.textContent).toContain('Fluxo da máquina B');
    expect(el.textContent).toContain('Subagente da máquina B');
    expect(el.textContent).not.toContain('Fluxo da máquina A');
    expect(el.textContent).not.toContain('Subagente da máquina A');
    const refreshB = Promise.withResolvers<SubagentRun[]>();
    api.getSubagents.mockReturnValueOnce(refreshB.promise).mockResolvedValue([
      { ...sub, prompt: 'Subagente atual da máquina A', state: 'running', toolCalls: 22 },
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.getSubagents).toHaveBeenLastCalledWith('outra', stores.servers[1]);
    api.getWorkflows.mockResolvedValue([oldWorkflow]);
    route.params = { server: 'a', name: 'sess' };
    await render();
    expect(button(el, 'Subagente atual da máquina A').textContent).toContain(m.atividade_chamadas({ n: 22 }));
    await act(async () => { refreshB.resolve([{ ...sub, prompt: 'Resposta antiga da máquina B', state: 'running', toolCalls: 99 }]); });
    expect(button(el, 'Subagente atual da máquina A').textContent).toContain(m.atividade_chamadas({ n: 22 }));
    expect(el.textContent).not.toContain('Resposta antiga da máquina B');
    expect(api.getSubagents).toHaveBeenLastCalledWith('sess', stores.servers[0]);
  });

  it('limpa lista carregada ao trocar destino sem mostrar vazio durante carga', async () => {
    stores.chat.events = [];
    const { el, render } = await mount();
    expect(el.textContent).toContain(workflow.name);
    expect(el.textContent).toContain(sub.prompt);
    const pending = Promise.withResolvers<SubagentRun[]>();
    api.getWorkflows.mockResolvedValue([]);
    api.getSubagents.mockReturnValue(pending.promise);
    route.params = { server: 'b', name: 'outra' };
    await render();
    expect(el.textContent).not.toContain(workflow.name);
    expect(el.textContent).not.toContain(sub.prompt);
    expect(el.textContent).toContain(m.comum_carregando());
    expect(el.textContent).not.toContain(m.atividade_vazio());
    await act(async () => { pending.resolve([]); });
    expect(el.textContent).toContain(m.atividade_vazio());
    expect(el.textContent).not.toContain(m.comum_carregando());
  });

  it('só mostra vazio depois de workflows e subagentes responderem', async () => {
    stores.chat.events = [];
    const workflows = Promise.withResolvers<WorkflowSummary[]>();
    const subs = Promise.withResolvers<SubagentRun[]>();
    api.getWorkflows.mockReturnValue(workflows.promise);
    api.getSubagents.mockReturnValue(subs.promise);
    const { el } = await mount();
    expect(el.textContent).toContain(m.comum_carregando());
    expect(el.textContent).not.toContain(m.atividade_vazio());
    await act(async () => { workflows.resolve([]); });
    expect(el.textContent).toContain(m.comum_carregando());
    expect(el.textContent).not.toContain(m.atividade_vazio());
    await act(async () => { subs.resolve([]); });
    expect(el.textContent).toContain(m.atividade_vazio());
    expect(el.textContent).not.toContain(m.comum_carregando());
  });

  it('mostra falha de workflows e permite tentar novamente sem fingir vazio', async () => {
    stores.chat.events = [];
    api.getWorkflows.mockRejectedValue(Object.assign(new Error('503: runtime_unhealthy'), { status: 503 }));
    api.getSubagents.mockResolvedValue([]);
    const { el } = await mount();
    expect(el.textContent).toContain(m.atividade_erro_run());
    expect(el.textContent).not.toContain(m.atividade_vazio());
    api.getWorkflows.mockResolvedValue([workflow]);
    await click(el, m.sync_retry());
    expect(el.textContent).toContain(workflow.name);
    expect(el.textContent).not.toContain(m.atividade_erro_run());
  });

  it.each(['resposta', 'erro'])('publica workflows enquanto subagentes seguem pendentes: %s', async (outcome) => {
    stores.chat.events = [];
    const workflows = Promise.withResolvers<WorkflowSummary[]>();
    const subs = Promise.withResolvers<SubagentRun[]>();
    api.getWorkflows.mockReturnValue(workflows.promise);
    api.getSubagents.mockReturnValue(subs.promise);
    const { el } = await mount();
    await act(async () => { workflows.resolve([workflow]); });
    expect(el.textContent).toContain(workflow.name);
    expect(el.textContent).toContain(m.comum_carregando());
    expect(el.textContent).not.toContain(m.atividade_vazio());
    await act(async () => {
      if (outcome === 'erro') subs.reject(Object.assign(new Error('503: runtime_unhealthy'), { status: 503 }));
      else subs.resolve([]);
    });
    expect(el.textContent).toContain(workflow.name);
    expect(el.textContent).not.toContain(m.comum_carregando());
    if (outcome === 'erro') expect(el.textContent).toContain(m.atividade_erro_subagentes());
    else expect(el.textContent).not.toContain(m.atividade_erro_subagentes());
  });

  it('renova snapshot em 5s de 22 para 29 chamadas e concluído sem novo evento nem detalhe', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running', toolCalls: 22 }]);
    const { el } = await mount();
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 22 }));
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running', toolCalls: 29 }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 22 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 29 }));
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'finished', toolCalls: 29, endedAt: new Date().toISOString() }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(el.textContent).toContain(m.atividade_grupo_terminados({ n: 1 }));
    expect(el.textContent).not.toContain(m.atividade_grupo_rodando({ n: 1 }));
    expect(api.getSubagent).not.toHaveBeenCalled();
    expect(api.getSubagents).toHaveBeenLastCalledWith('sess', stores.servers[0]);
  });

  it('serializa carga inicial, assinatura e timer respeitando invalidação pendente', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const initial = Promise.withResolvers<SubagentRun[]>();
    const refreshed = Promise.withResolvers<SubagentRun[]>();
    api.getSubagents.mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
    const { el, render } = await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.getSubagents).toHaveBeenCalledTimes(1);
    stores.chat.events = [...events, { id: 'end', kind: 'tool_result', tool_use_id: 'launch', result: 'fim' }];
    await render();
    expect(api.getSubagents).toHaveBeenCalledTimes(1);
    await act(async () => { initial.resolve([{ ...sub, state: 'running', toolCalls: 22 }]); });
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
    expect(el.textContent).not.toContain(m.atividade_chamadas({ n: 22 }));
    await act(async () => { refreshed.resolve([{ ...sub, state: 'finished', toolCalls: 29, endedAt: new Date().toISOString() }]); });
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 29 }));
    expect(el.textContent).toContain(m.atividade_grupo_terminados({ n: 1 }));
  });

  it('preserva snapshot sem spinner na consulta e no erro e recupera no próximo timer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running', toolCalls: 22 }]);
    const { el } = await mount();
    const pending = Promise.withResolvers<SubagentRun[]>();
    api.getSubagents.mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 22 }));
    expect(el.textContent).not.toContain(m.comum_carregando());
    await act(async () => { pending.reject(new Error('503')); });
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 22 }));
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(m.atividade_erro_subagentes());
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running', toolCalls: 29 }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 29 }));
    expect(el.textContent).not.toContain(m.atividade_erro_subagentes());
    expect(el.textContent).toContain(workflow.name);
    expect(api.getWorkflows).toHaveBeenCalledTimes(1);
  });

  it('serializa retry e volta do detalhe com timer pendente sem apagar snapshot', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    api.getWorkflows.mockRejectedValueOnce(new Error('503'));
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running', toolCalls: 22 }]);
    const { el } = await mount();
    const pending = Promise.withResolvers<SubagentRun[]>();
    const workflows = Promise.withResolvers<WorkflowSummary[]>();
    api.getWorkflows.mockReturnValue(workflows.promise);
    api.getSubagents.mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await click(el, m.sync_retry());
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 22 }));
    expect(el.textContent).not.toContain(m.comum_carregando());
    await click(el, m.sync_retry());
    expect(api.getWorkflows).toHaveBeenCalledTimes(2);
    await click(el, 'Conferir atividade');
    await click(el, m.comum_voltar());
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running', toolCalls: 29 }]);
    await act(async () => {
      pending.resolve([{ ...sub, state: 'running', toolCalls: 7 }]);
      workflows.resolve([workflow]);
    });
    expect(api.getSubagents).toHaveBeenCalledTimes(3);
    expect(button(el, 'Conferir atividade').textContent).toContain(m.atividade_chamadas({ n: 29 }));
    expect(el.textContent).toContain(workflow.name);
    expect(el.textContent).not.toContain(m.atividade_erro_run());
  });

  it('acompanha revisão de eventos na mesma lista do store', async () => {
    stores.chat.events = [...events];
    const { el, render } = await mount();
    expect(el.querySelector('header')?.textContent).toContain('1/2');
    stores.chat.events[0] = { ...events[0]!, tool_input: { todos: [
      { content: 'Conferir cabeçalho', status: 'completed' },
      { content: 'Conferir retorno', status: 'completed' },
    ] } };
    stores.chat.eventsRevision += 1;
    await render();
    expect(el.querySelector('header')?.textContent).toContain('2/2');
  });

  it('renova subagentes quando o pai conclui sem apagar a lista durante atualização', async () => {
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running' }]);
    const { el, render } = await mount();
    expect(el.textContent).toContain(m.atividade_grupo_rodando({ n: 1 }));
    const update = Promise.withResolvers<SubagentRun[]>();
    api.getSubagents.mockReturnValue(update.promise);
    stores.chat.events = [...events, { id: 'end', kind: 'tool_result', tool_use_id: 'launch', result: 'fim' }];
    await render();
    expect(button(el, 'Conferir atividade')).toBeDefined();
    expect(el.textContent).toContain(workflow.name);
    expect(el.textContent).toContain(m.atividade_grupo_rodando({ n: 1 }));
    await act(async () => { update.resolve([{ ...sub, state: 'finished', endedAt: new Date(2026, 9, 17, 11, 0, 0).toISOString() }]); });
    expect(el.textContent).toContain(m.atividade_grupo_terminados({ n: 1 }));
    expect(el.textContent).not.toContain(m.atividade_grupo_rodando({ n: 1 }));
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
  });

  it('renova lista ao voltar de detalhe que já concluiu mesmo com pai rodando', async () => {
    const finished: SubagentRun = { ...sub, state: 'finished', endedAt: new Date(2026, 9, 17, 11, 0, 0).toISOString() };
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'running' }]);
    api.getSubagent.mockResolvedValue(finished);
    const { el } = await mount();
    await click(el, 'Conferir atividade');
    expectHeader(el, 'Conferir atividade');
    api.getSubagents.mockResolvedValue([finished]);
    await click(el, m.comum_voltar());
    expectHeader(el, m.ctx_atividade());
    expect(el.textContent).toContain(m.atividade_grupo_terminados({ n: 1 }));
    expect(el.textContent).not.toContain(m.atividade_grupo_rodando({ n: 1 }));
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
  });

  it('Android mantém cabeçalho no conteúdo com títulos, badges e voltar em todos os níveis', async () => {
    platform.OS = 'android';
    const { el } = await mount();
    const listHeader = expectAndroidHeader(el, m.ctx_atividade());
    expect(listHeader.textContent).toContain('1/2');
    expect(listHeader.querySelector('button')).toBeNull();
    expect(el.querySelector('[data-scroll]')?.textContent).toContain(m.atividade_grupo_rodando({ n: 1 }));
    expect(el.querySelector('[data-scroll]')?.textContent).not.toContain(m.ctx_atividade());
    await click(el, workflow.name);
    const workflowHeader = expectAndroidHeader(el, detail.name);
    expect(workflowHeader.textContent).toContain('running');
    const back = button(workflowHeader, m.comum_voltar());
    expect(Number(back.getAttribute('data-hit-slop'))).toBeGreaterThanOrEqual(12);
    expect(back.querySelector('svg')).not.toBeNull();
    await click(el, agent.label);
    expectAndroidHeader(el, agent.label);
    expect(el.textContent).toContain(agent.prompt);
    await click(el, m.comum_voltar());
    expectAndroidHeader(el, detail.name);
    await click(el, m.comum_voltar());
    expectAndroidHeader(el, m.ctx_atividade());
    await click(el, 'Conferir atividade');
    expectAndroidHeader(el, 'Conferir atividade');
    expect(api.getSubagent).toHaveBeenLastCalledWith('sess', 'sub-1', expect.any(Number), stores.servers[0]);
    expect(el.textContent).toContain(m.atividade_pensando());
    await click(el, m.comum_voltar());
    expectAndroidHeader(el, m.ctx_atividade());
    expect(route.back).not.toHaveBeenCalled();
  });

  it.each(['android', 'ios'] as const)('aplica padding horizontal ao detalhe sem rolagem extra nem alterar teclado: %s', async (os) => {
    platform.OS = os;
    api.getSubagent.mockResolvedValue({ ...sub, state: 'running', canMessage: true, events: [
      { id: 'reply', kind: 'assistant_msg', text: 'Resposta do subagente' },
    ] });
    const { el } = await mount();
    await click(el, 'Conferir atividade');
    const keyboard = el.querySelector<HTMLElement>('[data-keyboard-behavior]')!;
    const wrapper = keyboard.parentElement!;
    expect(wrapper.getAttribute('data-padding-horizontal')).toBe('16');
    expect(wrapper.style.flexGrow).toBe('1');
    expect(Number.parseFloat(wrapper.style.minHeight)).toBe(0);
    expect(wrapper.parentElement).toBe(el.querySelector('[data-edges]'));
    expect(keyboard.style.flexGrow).toBe('1');
    expect(Number.parseFloat(keyboard.style.minHeight)).toBe(0);
    expect(keyboard.getAttribute('data-keyboard-behavior')).toBe('padding');
    expect(keyboard.getAttribute('data-keyboard-offset')).toBe('true');
    const list = el.querySelector('[data-virtual-list]')!;
    expect(list.textContent).toContain('Resposta do subagente');
    expect(list.closest('[data-scroll]')).toBeNull();
    expect(wrapper.closest('[data-scroll]')).toBeNull();
    expect(keyboard.querySelector('textarea')?.getAttribute('aria-label')).toBe(m.native_subagent_composer({ agent: 'sub-1' }));
    expect(button(keyboard, m.native_send())).toBeDefined();
  });

  it('Android consome hardwareBackPress nos detalhes e só deixa fechar a folha na lista', async () => {
    platform.OS = 'android';
    const { el } = await mount();
    await click(el, workflow.name);
    await click(el, agent.label);
    expect(await hardwareBackPress()).toBe(true);
    expectAndroidHeader(el, detail.name);
    expect(route.back).not.toHaveBeenCalled();
    expect(await hardwareBackPress()).toBe(true);
    expectAndroidHeader(el, m.ctx_atividade());
    expect(route.back).not.toHaveBeenCalled();
    await click(el, 'Conferir atividade');
    api.getSubagents.mockResolvedValue([{ ...sub, state: 'finished' }]);
    expect(await hardwareBackPress()).toBe(true);
    expectAndroidHeader(el, m.ctx_atividade());
    expect(el.textContent).toContain(m.atividade_grupo_terminados({ n: 1 }));
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
    expect(route.back).not.toHaveBeenCalled();
    expect(await hardwareBackPress()).toBe(false);
    expect(route.back).toHaveBeenCalledTimes(1);
  });

  it('Android remove hardwareBackPress ao perder foco e desmontar, retomando o nível atual', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    platform.OS = 'android';
    const { el, render, unmount } = await mount();
    route.focused = false;
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.getSubagents).toHaveBeenCalledTimes(1);
    route.focused = true;
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
    await click(el, workflow.name);
    expect(nativeBack.listeners.size).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
    route.focused = false;
    await render();
    expect(nativeBack.listeners.size).toBe(0);
    expect(await hardwareBackPress()).toBe(false);
    expectAndroidHeader(el, detail.name);
    route.back.mockClear();
    route.focused = true;
    await render();
    expect(nativeBack.listeners.size).toBe(1);
    expect(await hardwareBackPress()).toBe(true);
    expectAndroidHeader(el, m.ctx_atividade());
    expect(route.back).not.toHaveBeenCalled();
    await click(el, 'Conferir atividade');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.getSubagents).toHaveBeenCalledTimes(2);
    await click(el, m.comum_voltar());
    expect(api.getSubagents).toHaveBeenCalledTimes(3);
    const pending = Promise.withResolvers<SubagentRun[]>();
    api.getSubagents.mockReturnValue(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.getSubagents).toHaveBeenCalledTimes(4);
    stores.chat.events = [...events, { id: 'end', kind: 'tool_result', tool_use_id: 'launch', result: 'fim' }];
    await render();
    await unmount();
    await act(async () => {
      pending.resolve([{ ...sub, toolCalls: 99 }]);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.getSubagents).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(nativeBack.listeners.size).toBe(0);
    expect(await hardwareBackPress()).toBe(false);
    expect(route.back).toHaveBeenCalledTimes(1);
  });

  it('iOS não registra hardwareBackPress e preserva a navegação nativa', async () => {
    const { el } = await mount();
    await click(el, workflow.name);
    expectHeader(el, detail.name);
    expect(nativeBack.listeners.size).toBe(0);
    expect(await hardwareBackPress()).toBe(false);
    expect(route.back).toHaveBeenCalledTimes(1);
  });

  it('Android conserva cabeçalho sem recuo superior quando servidor está ausente', async () => {
    platform.OS = 'android';
    route.params = { server: 'missing', name: 'sess' };
    const { el } = await mount();
    expectAndroidHeader(el, m.ctx_atividade());
    expect(el.textContent).toContain(m.compare_servidor_nao_encontrado());
    expect(api.getWorkflows).not.toHaveBeenCalled();
    expect(api.getSubagents).not.toHaveBeenCalled();
  });

  it('usa cabeçalho nativo sem disputar espaço com a lista e preserva recuos', async () => {
    const { el, render } = await mount();
    expectHeader(el, m.ctx_atividade());
    expect(el.querySelector('header')?.textContent).toContain('1/2');
    expect(el.querySelector('[data-scroll]')?.getAttribute('data-inset')).toBe('automatic');
    expect(el.querySelector('[data-scroll]')?.textContent).toContain(m.atividade_grupo_rodando({ n: 1 }));
    expect([...el.querySelectorAll('button')].filter(node => node.textContent?.includes('Conferir atividade'))).toHaveLength(1);
    expect(el.querySelector('[data-scroll]')?.textContent).not.toContain(m.ctx_atividade());
    expect(el.querySelector('[data-edges]')?.getAttribute('data-edges')).toBe('bottom,left,right');
    route.params = { server: 'missing', name: 'sess' };
    await render();
    expectHeader(el, m.ctx_atividade());
    const error = [...el.querySelectorAll('span')].find((node) => node.textContent === m.compare_servidor_nao_encontrado());
    expect(error?.closest('[style*="padding-top"]')?.getAttribute('style')).toContain('padding-top: 64px');
  });

  it('volta pelo cabeçalho nativo de agente para workflow e lista', async () => {
    const { el } = await mount();
    await click(el, workflow.name);
    expectHeader(el, detail.name);
    expect(el.querySelector('header')?.textContent).toContain('running');
    expect(el.querySelector('[data-scroll]')?.closest('[style*="padding-top"]')?.getAttribute('style')).toContain('padding-top: 64px');
    const back = button(el, m.comum_voltar());
    expect(Number(back.getAttribute('data-hit-slop'))).toBeGreaterThanOrEqual(12);
    expect(back.querySelector('svg, [data-symbol]')).not.toBeNull();
    await click(el, agent.label);
    expectHeader(el, agent.label);
    expect(el.textContent).toContain(agent.prompt);
    await click(el, m.comum_voltar());
    expectHeader(el, detail.name);
    await click(el, m.comum_voltar());
    expectHeader(el, m.ctx_atividade());
    expect(el.querySelector('header')?.textContent).toContain('1/2');
    expect(el.querySelector('header button')).toBeNull();
    expect(route.back).not.toHaveBeenCalled();
  });

  it('abre subagente no servidor da rota mesmo com outro ativo', async () => {
    const { el, render } = await mount();
    await click(el, 'Conferir atividade');
    expect(api.getSubagent).toHaveBeenLastCalledWith('sess', 'sub-1', expect.any(Number), stores.servers[0]);
    expectHeader(el, 'Conferir atividade');
    expect(el.textContent).toContain(m.atividade_pensando());
    await click(el, m.comum_voltar());
    expectHeader(el, m.ctx_atividade());
    route.params = { server: 'b', name: 'outra' };
    await render();
    await click(el, 'Conferir atividade');
    expect(api.getSubagent).toHaveBeenLastCalledWith('outra', 'sub-1', expect.any(Number), stores.servers[1]);
    expect(stores.activeId).toBe('b');
  });
});
