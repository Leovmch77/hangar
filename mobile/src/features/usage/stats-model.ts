import type { UsoBucket, UsoReport } from '@hangar/core';
export const usageTabs = ['by_skill', 'by_agente', 'by_plugin', 'by_tool', 'by_bash', 'by_mcp', 'by_contexto', 'by_imagem'] as const;
export type UsageTab = typeof usageTabs[number];
export function measure(item: UsoBucket, tab: UsageTab) {
  const held = tab === 'by_skill' || tab === 'by_plugin';
  const value = held ? item.ocupados_eq_tokens_est ?? 0 : tab === 'by_agente' ? item.input + item.output : item.ctx_tokens_est;
  const divisor = tab === 'by_contexto' ? item.sessions : item.chamadas;
  return { value, approximate: tab !== 'by_agente', perCall: divisor > 0 ? (held ? item.ctx_tokens_est : value) / divisor : 0 };
}
export function toolsOf(report: UsoReport) {
  return report.by_tool.filter((item) => !['Skill', 'Agent'].includes(item.key)).sort((a, b) => b.chamadas - a.chamadas || a.key.localeCompare(b.key));
}
export function contextCategory(key: string): number {
  if (key.startsWith('hook')) return 2;
  if (['instructions', 'nested_memory', 'session_context'].includes(key)) return 0;
  if (['skill_listing', 'agent_listing', 'deferred_tools', 'command_permissions'].some((prefix) => key.startsWith(prefix))) return 1;
  if (['reminder', 'output_style', 'queued_command', 'silent_turn'].some((part) => key.includes(part))) return 3;
  return 4;
}
