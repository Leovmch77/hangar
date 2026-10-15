// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { ChatEvent } from '@hangar/core';
import ToolGroup from './ToolGroup.svelte';
import { toolLook } from '../lib/toolLook.svelte';

const call = (id: string, tool_name: string, tool_input: Record<string, unknown> | null = null): ChatEvent =>
  ({ kind: 'tool_use', id, tool_use_id: id, tool_name, tool_input } as ChatEvent);
const done = (id: string): ChatEvent => ({ kind: 'tool_result', id: `r-${id}`, tool_use_id: id, result: 'ok' } as ChatEvent);

let alvo: HTMLElement | null = null;
let comp: ReturnType<typeof mount> | null = null;
async function montar(tools: ChatEvent[], results: ChatEvent[], pluginServers: string[]) {
  const porId = new Map(results.map((r) => [r.tool_use_id ?? '', r]));
  alvo = document.createElement('div');
  document.body.append(alvo);
  comp = mount(ToolGroup, { target: alvo, props: { tools, toolResults: { get: (id: string) => porId.get(id) }, sessionName: 's', pluginServers } });
  await tick();
  return alvo;
}
beforeEach(() => { toolLook.look = 'terminal'; });
afterEach(async () => {
  if (comp) await unmount(comp);
  comp = null;
  alvo?.remove();
});

describe('ToolGroup na pele terminal', () => {
  it('MCP de plugin fica sozinho, com o nome do Claude Code, entre duas dobras', async () => {
    const tools = [call('a', 'Bash', { command: 'make' }), call('b', 'mcp__pmedico__progresso'), call('c', 'Bash', { command: 'make' })];
    const el = await montar(tools, tools.map((t) => done(t.id)), ['pmedico']);
    expect(el.querySelectorAll('.tg-fold')).toHaveLength(2);
    expect(el.querySelector('.tt')?.textContent).toContain('pmedico - progresso (MCP)');
  });

  it('sem o conjunto, o MCP volta para a dobra', async () => {
    const tools = [call('a', 'Bash', { command: 'make' }), call('b', 'mcp__pmedico__progresso')];
    const el = await montar(tools, tools.map((t) => done(t.id)), []);
    expect(el.querySelectorAll('.tg-fold')).toHaveLength(1);
    expect(el.querySelector('.tt')).toBeNull();
  });

  it('a dobra tem o ponto só enquanto roda', async () => {
    const tools = [call('a', 'Bash', { command: 'make' })];
    expect((await montar(tools, [], [])).querySelector('.tg-fold-dot')).not.toBeNull();
    await unmount(comp!);
    alvo!.remove();
    expect((await montar(tools, [done('a')], [])).querySelector('.tg-fold-dot')).toBeNull();
  });
});
