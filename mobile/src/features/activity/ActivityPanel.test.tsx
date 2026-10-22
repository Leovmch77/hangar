// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Activity, ChatEvent, Server, WorkflowSummary } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const data = vi.hoisted(() => ({
  activity: { tasks: [], agents: [], shells: [], total: 0, done: 0, inProgress: 0, runningAgents: 0, runningShells: 0 } as Activity,
  server: { id: 'a', label: 'A', baseUrl: 'https://a.test', token: 'token-a' } as Server,
  events: [] as ChatEvent[],
  workflows: [] as WorkflowSummary[],
}));
vi.mock('./useActivity', () => ({ useActivity: () => data.activity }));
vi.mock('../../stores/chat', () => ({ chatStore: () => ({
  use: (select: (state: { events: ChatEvent[]; eventsRevision: number; stateEvent: null }) => unknown) =>
    select({ events: data.events, eventsRevision: 0, stateEvent: null }),
}) }));
vi.mock('../../stores/servers', () => ({ useServers: (select: (state: { servers: Server[] }) => unknown) => select({ servers: [data.server] }) }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getWorkflows: vi.fn(async () => data.workflows),
  getWorkflow: vi.fn().mockResolvedValue(null),
  getSubagents: vi.fn().mockResolvedValue([]),
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
}));
vi.mock('expo-blur', () => ({ BlurView: () => null }));
vi.mock('expo-glass-effect', () => ({ GlassView: () => null, isLiquidGlassAvailable: () => false }));
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: () => null }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: () => null }));
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({}) }));
vi.mock('../../chat/MessageList', () => ({ MessageList: () => null }));
vi.mock('../../chat/LiveWork', () => ({ WorkingLine: () => null }));

import * as m from '../../paraglide/messages';
import { ActivityPanel } from './ActivityPanel';

let root: Root | undefined;
async function mount(onBackRequest?: (handler: () => boolean) => void) {
  const el = document.createElement('div');
  root = createRoot(el);
  await act(async () => root!.render(createElement(ActivityPanel, { serverId: 'a', name: 'sess', focused: true, onBackRequest })));
  return el;
}

beforeEach(() => {
  data.activity = { tasks: [], agents: [], shells: [], total: 0, done: 0, inProgress: 0, runningAgents: 0, runningShells: 0 };
  data.workflows = [];
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});

it('pausa o polling ao perder foco explícito e retoma sem recarregar os workflows', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const { getSubagents, getWorkflows } = await import('@hangar/core');
  vi.mocked(getSubagents).mockClear();
  vi.mocked(getWorkflows).mockClear();
  await mount();
  expect(getSubagents).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(getSubagents).toHaveBeenCalledTimes(2);
  await act(async () => root!.render(createElement(ActivityPanel, { serverId: 'a', name: 'sess', focused: false })));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(getSubagents).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => root!.render(createElement(ActivityPanel, { serverId: 'a', name: 'sess', focused: true })));
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(getSubagents).toHaveBeenCalledTimes(3);
  expect(getWorkflows).toHaveBeenCalledTimes(1);
});

it('mostra os dois shells em execução sem oferecer navegação de folha', async () => {
  data.activity = { ...data.activity, runningShells: 2, shells: [
    { id: 'build', command: 'npm run build', rotulo: 'npm run build', running: true },
    { id: 'dev', command: 'npm run dev', rotulo: 'npm run dev', running: true },
  ] };
  const el = await mount();
  expect(el.textContent).toContain('npm run build');
  expect(el.textContent).toContain('npm run dev');
  expect(el.textContent).toContain(m.atividade_shells_rodando({ n: 2 }));
  expect(el.textContent).not.toContain(m.atividade_vazio());
  expect(el.querySelector(`[aria-label="${m.native_close()}"]`)).toBeNull();
});

it('mostra o vazio existente quando não há atividade', async () => {
  const el = await mount();
  expect(el.textContent).toContain(m.atividade_vazio());
});

it('consome o voltar só no detalhe e libera o handler ao desmontar', async () => {
  data.workflows = [{ runId: 'run-1', name: 'run-1', status: 'running', agentCount: 1, phaseCount: 0, totalTokens: 100, durationMs: 1000, startTime: 1, running: true }];
  let back = () => false;
  const el = await mount((handler) => { back = handler; });
  expect(back()).toBe(false);
  const workflow = el.querySelector<HTMLButtonElement>('[aria-label="run-1"]');
  expect(workflow).not.toBeNull();
  await act(async () => workflow!.click());
  expect(el.textContent).toContain(m.atividade_run_nao_encontrado());
  await act(async () => { expect(back()).toBe(true); });
  expect(el.querySelector('[aria-label="run-1"]')).not.toBeNull();
  expect(back()).toBe(false);
  await act(async () => root!.unmount());
  root = undefined;
  expect(back()).toBe(false);
});
