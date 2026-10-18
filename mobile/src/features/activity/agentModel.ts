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
  const full = normalize(agent.prompt ?? '');
  if (!full) return undefined;
  // Agentes paralelos costumam partir do mesmo roteiro: mais de um candidato não diz qual é qual.
  const only = (test: (prompt: string) => boolean) => {
    const found = subs.filter(sub => sub.prompt && test(normalize(sub.prompt)));
    return found.length === 1 ? found[0] : undefined;
  };
  return only(prompt => prompt === full) ?? only(prompt => prompt.startsWith(full.slice(0, 400)));
}

export function agentModel(agent: AgentRun, sub: SubagentRun | undefined): string | undefined {
  // Registro sem modelo não comprova que o apelido pedido chegou a rodar.
  return sub ? sub.model : agent.model;
}
