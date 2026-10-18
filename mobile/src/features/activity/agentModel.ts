import type { AgentRun, ChatEvent, SubagentRun } from '@hangar/core';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

export function agentIdentities(events: ChatEvent[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'tool_result' || !event.tool_use_id) continue;
    const launched = event.bg_agent_id;
    const id = launched?.startsWith('teammate:')
      ? event.result?.match(/agent_id:\s*([A-Za-z0-9_-]+)/)?.[1]
      : launched ?? event.result?.match(/agentId:\s*([A-Za-z0-9_-]+)/)?.[1];
    if (id) ids.set(event.tool_use_id, id);
  }
  return ids;
}

export function matchAgentSubagent(subs: SubagentRun[], agent: Pick<AgentRun, 'id' | 'prompt'>, ids: Map<string, string>): SubagentRun | undefined {
  const id = ids.get(agent.id);
  if (id) return subs.find(sub => sub.agentId === id);
  if (!agent.prompt) return undefined;
  const full = normalize(agent.prompt);
  return subs.find(sub => sub.prompt && normalize(sub.prompt) === full)
    ?? subs.find(sub => sub.prompt && normalize(sub.prompt).startsWith(full.slice(0, 400)));
}

export function agentModel(agent: AgentRun, sub: SubagentRun | undefined): string | undefined {
  // Registro sem modelo não comprova que o apelido pedido chegou a rodar.
  return sub ? sub.model : agent.model;
}
