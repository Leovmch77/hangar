// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentRun, ChatEvent, SubagentRun } from '@hangar/core';
import { AgentesRodando } from './LiveWork';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getSubagents: vi.fn() }));
const route = vi.hoisted(() => ({ focused: true }));
const server = vi.hoisted(() => ({ id: 'a', label: 'A', baseUrl: 'https://a.test', token: 'token-a' }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...api }));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => route.focused ? effect() : undefined, [effect, route.focused]) }));
vi.mock('../stores/servers', () => ({ useServers: (select: (state: unknown) => unknown) => select({ servers: [server] }) }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));

const agent: AgentRun = { id: 'launch', kind: 'agent', description: 'Conferir tela', subagentType: 'Explore', model: 'opus', prompt: 'Conferir a tela', running: true };
const sub: SubagentRun = { agentId: 'sub-1', agentType: 'Explore', prompt: agent.prompt ?? null, startedAt: '', updatedAt: '', mtime: 1, toolCalls: 0, tools: [], recent: [], lastText: '', events: [], model: 'gpt-6.1-sol' };
const roots: Root[] = [];
const start = () => 1;
const open = () => {};
async function mount(agents = [agent], events: ChatEvent[] = []) {
  const el = document.createElement('div');
  const root = createRoot(el);
  roots.push(root);
  const render = () => act(async () => root.render(createElement(AgentesRodando, {
    agentes: agents, inicio: start, onAbrir: open, serverId: 'a', sessionName: 'sess', events: [...events],
  })));
  await render();
  return { el, render };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  route.focused = true;
  api.getSubagents.mockResolvedValue([]);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.useRealTimers();
});

it('mostra o apelido pedido antes da descoberta, inclusive no leitor de tela', async () => {
  const { el } = await mount();
  expect(el.textContent).toContain('opus');
  expect(el.querySelector('button')?.getAttribute('aria-label')).toContain('opus');
});

it('troca o apelido pelo modelo real e conserva a linha quando a consulta não muda', async () => {
  api.getSubagents.mockResolvedValue([{ ...sub, prompt: '  CONFERIR\n A TELA  ' }]);
  const { el } = await mount();
  expect(el.textContent).toContain('gpt-6.1-sol');
  expect(el.textContent).not.toContain('opus');
  expect(el.querySelector('button')?.getAttribute('aria-label')).toContain('gpt-6.1-sol');
  const row = el.querySelector('button');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(el.querySelector('button')).toBe(row);
  expect(api.getSubagents).toHaveBeenLastCalledWith('sess', server);
});

it.each(['structured', 'text', 'teammate'])('a identidade do resultado vence um prompt repetido: %s', async (source) => {
  api.getSubagents.mockResolvedValue([
    { ...sub, agentId: 'other', model: 'modelo-errado' },
    { ...sub, prompt: 'Outro prompt', model: 'gpt-6-astra' },
  ]);
  const result: ChatEvent = { id: 'result', kind: 'tool_result', tool_use_id: 'launch',
    ...(source === 'structured' ? { bg_agent_id: 'sub-1' } : source === 'teammate'
      ? { bg_agent_id: 'teammate:reviewer', result: 'agent_id: sub-1' }
      : { result: 'Async agent launched. agentId: sub-1' }) };
  const { el } = await mount([agent], [result]);
  expect(el.textContent).toContain('gpt-6-astra');
  expect(el.textContent).not.toContain('modelo-errado');
});

it('não afirma o apelido quando o subagente listado não tem modelo', async () => {
  api.getSubagents.mockResolvedValue([{ ...sub, model: undefined, ilegivel: true }]);
  const { el } = await mount();
  expect(el.textContent).not.toContain('opus');
  expect(el.textContent).not.toContain('gpt-6.1-sol');
});

it('atualiza modelo, mostra erro sem apagar o conhecido e pausa fora de foco', async () => {
  const { el, render } = await mount();
  api.getSubagents.mockResolvedValue([sub]);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(el.textContent).toContain('gpt-6.1-sol');
  api.getSubagents.mockRejectedValue(new Error('503'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(el.querySelector('[role="alert"]')).not.toBeNull();
  expect(el.textContent).toContain('gpt-6.1-sol');
  const count = api.getSubagents.mock.calls.length;
  route.focused = false;
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(api.getSubagents).toHaveBeenCalledTimes(count);
  api.getSubagents.mockResolvedValue([{ ...sub, model: 'gpt-6-astra' }]);
  route.focused = true;
  await render();
  expect(el.textContent).toContain('gpt-6-astra');
  expect(el.querySelector('[role="alert"]')).toBeNull();
});

it('permite tentar de novo após timeout e ignora a resposta atrasada anterior', async () => {
  const pending = Promise.withResolvers<SubagentRun[]>();
  api.getSubagents.mockReturnValue(pending.promise);
  const { el } = await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(el.querySelector('[role="alert"]')).not.toBeNull();
  const retry = [...el.querySelectorAll('button')].find(node => !node.textContent?.includes('Conferir tela'));
  expect(retry).toBeDefined();
  api.getSubagents.mockResolvedValue([{ ...sub, model: 'gpt-6-astra' }]);
  await act(async () => retry!.click());
  expect(el.textContent).toContain('gpt-6-astra');
  await act(async () => pending.resolve([sub]));
  expect(el.textContent).not.toContain('gpt-6.1-sol');
  expect(el.querySelector('[role="alert"]')).toBeNull();
});
