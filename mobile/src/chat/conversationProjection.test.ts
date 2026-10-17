import { describe, expect, it } from 'vitest';
import { agruparConversa, entraNoPensamento, htmlPageFromResult, type ChatEvent } from '@hangar/core';
import { foldConversation, summaryTitle, foldTitle } from './tools/fold';
import { projectConversation, type ConversationProjection, type ProjectionInput } from './conversationProjection';

const tool = (id: string, name = 'Bash', input = {}): ChatEvent => ({ id, kind: 'tool_use', tool_use_id: id, tool_name: name, tool_input: input });
const result = (id: string, text = 'ok', error = false): ChatEvent => ({ id: `r-${id}`, kind: 'tool_result', tool_use_id: id, result: text, is_error: error });
const message = (id: string): ChatEvent => ({ id, kind: 'assistant_msg', text: id });
const input = (events: ChatEvent[], patch: Partial<ProjectionInput> = {}): ProjectionInput => ({
  events, eventsRevision: 0, pref: 'busca', merge: true, tasksEnabled: false, pagesEnabled: true, running: new Set(), ...patch,
});

const pageResult = (id: string) => result(id, JSON.stringify({ hangar_page: { id: 'page', title: 'report' } }));
const plainRows = (rows: ConversationProjection['data']) => rows.map((row) => {
  const { resultOf: _resultOf, summary: _summary, ...plain } = row;
  return plain;
});

describe.each([true, false])('contrato do agrupamento, árvore=%s', (merge) => {
  it.each(['nada', 'busca', 'tudo'] as const)('preserva cada prefixo com preferência %s', (pref) => {
    const events: ChatEvent[] = [
      message('a'), { id: 'thought', kind: 'thinking', text: 'reason' }, tool('load', 'ToolSearch'),
      tool('search', 'WebSearch'), tool('t1'), tool('t2'), tool('t3'),
      tool('agent', 'Agent'), tool('html', 'mcp__hangar__html_render'), tool('read', 'Read'),
      pageResult('html'), message('b'), tool('after'), result('t2', 'failed', true),
    ];
    let state: ConversationProjection | null = null;
    for (let n = 1; n <= events.length; n++) {
      const prefix = events.slice(0, n);
      state = projectConversation(state, input(prefix, { merge, pref }));
      const results = new Map(prefix.filter((ev) => ev.kind === 'tool_result').map((ev) => [ev.tool_use_id, ev]));
      const expected = foldConversation(agruparConversa(prefix, { entraNoPensamento: (name) => entraNoPensamento(pref, name) }), merge,
        (ev) => { const r = results.get(ev.tool_use_id); return r && !r.is_error ? htmlPageFromResult(ev.tool_name, r.result) : null; });
      expect(plainRows(state.data), `prefix=${n}`).toEqual(expected);
      for (const row of state.data) if (row.type === 'fold') expect(summaryTitle(row.summary!)).toBe(foldTitle(row.parts));
    }
  });
});

it('chaves duplicadas continuam únicas inclusive quando um sufixo existe no transcript', () => {
  const events = [message('same'), message('same'), message('same#2')];
  const state = projectConversation(null, input(events));
  expect(state.data.map((row) => row.id)).toEqual(['same', 'same#3', 'same#2']);
  const appended = projectConversation(state, input([...events, message('tail')]));
  expect(appended.data.map((row) => row.id)).toEqual(['same', 'same#3', 'same#2', 'tail']);
});

it('reativar tarefas recompõe a lista e oculta as chamadas sem novos eventos', () => {
  const events = [tool('create', 'TaskCreate', { subject: 'Fix chat' }), result('create', 'Task #1 created successfully: Fix chat')];
  const before = projectConversation(null, input(events, { tasksEnabled: false }));
  expect(before.tasks).toEqual([]);
  expect(before.data.map((row) => row.type)).toEqual(['fold']);

  const after = projectConversation(before, input(events, { tasksEnabled: true }));
  expect(after.data.map((row) => row.type)).toEqual(['tasks']);
  expect(after.data[0]).toMatchObject({ type: 'tasks', tasks: [{ id: '1', subject: 'Fix chat', status: 'pending' }] });
  expect(before.tasks).toEqual([]);
});

it('resultado tardio atualiza todas as ocorrências da mesma chamada sem tocar vizinhas', () => {
  const first = { ...tool('first'), tool_use_id: 'shared' };
  const second = { ...tool('second'), tool_use_id: 'shared' };
  const events = [first, message('separator'), second, message('end')];
  const before = projectConversation(null, input(events));
  const after = projectConversation(before, input([...events, result('shared', 'failed', true)]));
  expect(after.data.filter((r) => r.type === 'fold').map((r) => r.summary?.failures)).toEqual([1, 1]);
  expect(after.data[1]).toBe(before.data[1]);
  expect(after.data[3]).toBe(before.data[3]);
  expect(before.data.filter((r) => r.type === 'fold').map((r) => r.summary?.failures)).toEqual([0, 0]);
});

it.each([false, true])('promoção em lote conta o erro da segunda uma vez, resultado da terceira=%s', (thirdResolved) => {
  const events = [tool('first'), tool('second')];
  const before = projectConversation(null, input(events, { merge: false }));
  const third = tool('third');
  const after = projectConversation(before, input([
    ...events, third, result('second', 'failed', true), ...(thirdResolved ? [result('third')] : []),
  ], { merge: false }));

  expect(after.data).toHaveLength(1);
  expect(after.data[0]).toMatchObject({ type: 'fold', source: 'group', summary: {
    lines: [...events, third], counts: [0, 0, 0, 0, 3, 0], calls: 3, thoughts: 0, failures: 1,
  } });
  expect(after.data[0].summary?.live).toEqual(new Set(thirdResolved ? [events[0]] : [events[0], third]));
  expect(before.data.map((row) => row.summary?.failures)).toEqual([0, 0]);
  expect(before.data.map((row) => [...row.summary!.live])).toEqual([[events[0]], [events[1]]]);
});

it('resumo de 5000 ferramentas e 200 resultados tardios não relê o trecho fechado', () => {
  let reads = 0;
  const counted = (ev: ChatEvent) => new Proxy(ev, { get(target, key, receiver) {
    if (typeof key === 'string') reads++;
    return Reflect.get(target, key, receiver);
  } });
  let events = Array.from({ length: 5000 }, (_, i) => counted(tool(`t${i}`)));
  let state = projectConversation(null, input(events));
  const before = state;
  reads = 0;
  for (let i = 0; i < 200; i++) {
    events = [...events, counted(result(`t${i}`, 'failed', true))];
    state = projectConversation(state, input(events));
  }
  const deltaReads = reads;
  const summary = (state.data[0] as { summary?: { calls: number; failures: number; live: Set<ChatEvent>; lines: ChatEvent[] } }).summary;
  expect(summary?.calls).toBe(5000);
  expect(summary?.failures).toBe(200);
  expect(summary?.live.size).toBe(4800);
  expect(summary?.lines).toHaveLength(5000);
  expect((before.data[0] as { summary?: { failures: number } }).summary?.failures).toBe(0);
  expect(before.results.size).toBe(0);
  expect(deltaReads).toBeLessThan(200 * 100);
});
