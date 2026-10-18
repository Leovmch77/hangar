import { expect, it } from 'vitest';
import { mergeUso, zeroUso } from '@hangar/core';
import { contextCategory, measure, toolsOf } from './stats-model';
it('medidas usam presença estimada de skills e plugins, tokens reais de agente e contexto dos demais', () => {
  const item = { ...zeroUso('fixture'), input: 100, output: 20, cache_read: 900, ctx_tokens_est: 30, ocupados_eq_tokens_est: 600, chamadas: 3, sessions: 2 };
  expect(measure(item, 'by_skill')).toEqual({ value: 600, approximate: true, perCall: 10 });
  expect(measure(item, 'by_plugin').value).toBe(600);
  expect(measure(item, 'by_agente')).toEqual({ value: 120, approximate: false, perCall: 40 });
  expect(measure(item, 'by_contexto')).toEqual({ value: 30, approximate: true, perCall: 15 });
  expect(measure(item, 'by_tool')).toEqual({ value: 30, approximate: true, perCall: 10 });
});
it('ranking de ferramentas não duplica Skill e Agent e categorias preservam contexto', () => {
  const report = mergeUso([{ report: { applied: { period: '30d' }, by_tool: ['Read', 'Skill', 'Agent', 'Bash'].map((key, i) => ({ ...zeroUso(key), chamadas: i + 1 })) } }], '30d').report;
  expect(toolsOf(report).map((item) => item.key)).toEqual(['Bash', 'Read']);
  expect(['instructions', 'skill_listing', 'hook:begin', 'reminder', 'unknown'].map(contextCategory)).toEqual([0, 1, 2, 3, 4]);
});
