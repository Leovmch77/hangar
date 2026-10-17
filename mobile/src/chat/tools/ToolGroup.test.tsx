// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatEvent } from '@hangar/core';
import { projectConversation, type ProjectionInput } from '../conversationProjection';
import { ToolGroup } from './ToolGroup';

vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: () => null }));
vi.mock('expo-file-system', () => ({}));
vi.mock('expo-clipboard', () => ({}));
vi.mock('expo-sharing', () => ({}));
vi.mock('expo-intent-launcher', () => ({}));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('expo-audio', () => ({}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
vi.mock('sonner-native', () => ({ toast: { error: () => {}, success: () => {} } }));
vi.mock('react-native-gifted-charts', () => ({}));
vi.mock('expo-linear-gradient', () => ({}));
vi.mock('expo-blur', () => ({}));
vi.mock('@lodev09/react-native-true-sheet', () => ({ TrueSheet: () => null }));
vi.mock('react-native-mmkv', () => ({ createMMKV: () => ({ getString: () => undefined, getNumber: () => undefined, getBoolean: () => undefined, set: () => {}, remove: () => {} }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('trecho recolhido com 5000 chamadas e 200 appends não reconta o histórico', () => {
  let reads = 0;
  const counted = (ev: ChatEvent) => new Proxy(ev, { get(target, key, receiver) {
    if (typeof key === 'string') reads++;
    return Reflect.get(target, key, receiver);
  } });
  const pair = (n: number): ChatEvent[] => [
    counted({ id: `t${n}`, kind: 'tool_use', tool_use_id: `t${n}`, tool_name: 'Bash', tool_input: { command: 'pwd' } }),
    counted({ id: `r${n}`, kind: 'tool_result', tool_use_id: `t${n}`, result: 'ok' }),
  ];
  let events = Array.from({ length: 5000 }, (_, i) => pair(i)).flat();
  const options = (events: ChatEvent[]): ProjectionInput => ({ events, eventsRevision: 0, merge: true, pref: 'busca', tasksEnabled: false, pagesEnabled: true, running: new Set() });
  let projection = projectConversation(null, options(events));
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = () => {
    const row = projection.data[0];
    if (row.type !== 'fold') throw new Error('expected fold');
    act(() => root.render(createElement(ToolGroup, { parts: row.parts, resultOf: row.resultOf!, summary: row.summary, onAbrir: () => {} } as ComponentProps<typeof ToolGroup>)));
  };
  try {
    render();
    reads = 0;
    for (let i = 0; i < 200; i++) {
      events = [...events, ...pair(5000 + i)];
      projection = projectConversation(projection, options(events));
      render();
    }
    const deltaReads = reads;
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.textContent).toContain('5200');
    expect(deltaReads).toBeLessThan(200 * 100);
  } finally {
    act(() => root.unmount());
  }
});
