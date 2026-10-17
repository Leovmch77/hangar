// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
import { createActivityFolder } from '@hangar/core';
import type { ChatEvent } from '@hangar/core';
import { feedFolder, useActivity } from './useActivity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// teste do Step 1 da Task 9: 3 tool_use → agents.length === 3; reset([]) zera
function agentEvent(toolUseId: string, seq: number): ChatEvent {
  return {
    kind: 'tool_use',
    id: `e${seq}`,
    tool_name: 'Agent',
    tool_use_id: toolUseId,
    tool_input: { description: `Agent ${seq}`, prompt: `prompt-${seq}` },
  } as ChatEvent;
}

describe('useActivity — createActivityFolder incremental', () => {
  it('3 tool_use Agent → agents.length === 3; reset([]) zera', () => {
    const folder = createActivityFolder();
    folder.push(agentEvent('tu1', 1));
    folder.push(agentEvent('tu2', 2));
    folder.push(agentEvent('tu3', 3));
    expect(folder.snapshot().agents.length).toBe(3);
    folder.reset([]);
    const after = folder.snapshot();
    expect(after.agents.length).toBe(0);
    expect(after.total).toBe(0);
    expect(after.tasks.length).toBe(0);
  });

  it('histórico antigo entrando na frente refaz a pasta, sem repetir a cauda', () => {
    const folder = createActivityFolder();
    let cursor = feedFolder(folder, { count: 0, firstId: undefined, eventsRevision: 0 }, [agentEvent('n1', 3)], 0);
    cursor = feedFolder(folder, cursor, [agentEvent('o1', 1), agentEvent('o2', 2), agentEvent('n1', 3)], 0);
    expect(folder.snapshot().agents.map((a) => a.description).sort()).toEqual(['Agent 1', 'Agent 2', 'Agent 3']);
    cursor = feedFolder(folder, cursor, [agentEvent('o1', 1), agentEvent('o2', 2), agentEvent('n1', 3), agentEvent('n2', 4)], 0);
    expect(folder.snapshot().agents.length).toBe(4);
  });

  it('revisão refaz substituição interna e mantém append incremental sem duplicar agentes', () => {
    const folder = createActivityFolder();
    const events: ChatEvent[] = [agentEvent('a1', 1), {
      kind: 'tool_result', id: 'e2', tool_use_id: 'a1', bg_agent_id: 'bg-1', result: 'launched',
    }];
    let cursor = feedFolder(folder, { count: 0, firstId: undefined, eventsRevision: 0 }, events, 0);
    expect(folder.snapshot().runningAgents).toBe(1);

    events[1] = { kind: 'tool_result', id: 'e2', tool_use_id: 'a1', result: 'done' };
    cursor = feedFolder(folder, cursor, events, 1);
    expect(folder.snapshot().agents[0].running).toBe(false);
    expect(cursor.eventsRevision).toBe(1);

    events[1] = { kind: 'tool_result', id: 'e2', tool_use_id: 'a1', bg_agent_id: 'bg-1', result: 'launched' };
    cursor = feedFolder(folder, cursor, events, 2);
    expect(folder.snapshot().runningAgents).toBe(1);

    const appended = [...events, agentEvent('a2', 3)];
    const reset = vi.spyOn(folder, 'reset');
    const push = vi.spyOn(folder, 'push');
    cursor = feedFolder(folder, cursor, appended, 2);
    cursor = feedFolder(folder, cursor, appended, 2);
    expect(reset).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledExactlyOnceWith(appended[2]);
    expect(folder.snapshot().agents.map((agent) => agent.id)).toEqual(['a1', 'a2']);
    expect(folder.snapshot().runningAgents).toBe(2);
    expect(cursor).toEqual({ count: 3, firstId: 'e1', eventsRevision: 2 });
  });

  it('hook invalida snapshot pela revisão mesmo com o mesmo array de eventos', async () => {
    const events: ChatEvent[] = [agentEvent('a1', 1), {
      kind: 'tool_result', id: 'e2', tool_use_id: 'a1', bg_agent_id: 'bg-1', result: 'launched',
    }, {
      kind: 'tool_use', id: 'e3', tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'Conferir atividade', status: 'pending' }] },
    }];
    let latest!: ReturnType<typeof useActivity>;
    function Probe({ revision }: { revision: number }) {
      latest = useActivity(events, revision);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    const render = (revision: number) => act(async () => root.render(createElement(Probe, { revision })));
    try {
      await render(0);
      const before = latest;
      expect(before.runningAgents).toBe(1);
      expect(before.tasks[0].status).toBe('pending');

      events[1] = { kind: 'tool_result', id: 'e2', tool_use_id: 'a1', result: 'done' };
      events[2] = { ...events[2], tool_input: { todos: [{ content: 'Conferir atividade', status: 'completed' }] } };
      await render(1);
      expect(latest.runningAgents).toBe(0);
      expect(latest.tasks[0].status).toBe('completed');
      expect(latest.done).toBe(1);
      expect(before.runningAgents).toBe(1);
      expect(before.tasks[0].status).toBe('pending');

      const revised = latest;
      await render(1);
      expect(latest).toBe(revised);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('reset com 3 eventos e depois reset vazio zera incremental', () => {
    const folder = createActivityFolder();
    const events: ChatEvent[] = [agentEvent('a1', 1), agentEvent('a2', 2), agentEvent('a3', 3)];
    folder.reset(events);
    expect(folder.snapshot().agents.length).toBe(3);
    folder.reset([]);
    expect(folder.snapshot().agents.length).toBe(0);
  });
});
