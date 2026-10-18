import { expect, it } from 'vitest';
import type { SubagentRun } from '@hangar/core';
import { matchAgentSubagent } from './agentModel';

const sub = (agentId: string, prompt: string | null, model: string) =>
  ({ agentId, prompt, model }) as unknown as SubagentRun;
const template = 'Revise o módulo abaixo seguindo o roteiro. '.repeat(12);

it('prefixo comum a dois subagentes é ambíguo e não escolhe nenhum', () => {
  const subs = [sub('a', `${template}módulo A`, 'model-a'), sub('b', `${template}módulo B`, 'model-b')];
  expect(matchAgentSubagent(subs, { id: 'tool-b', prompt: `${template}módulo B (versão do pai)` }, new Map())).toBeUndefined();
});

it('prefixo de um só subagente casa com ele', () => {
  const subs = [sub('a', `${template}módulo A`, 'model-a'), sub('x', 'outro trabalho', 'model-x')];
  expect(matchAgentSubagent(subs, { id: 'tool-a', prompt: `${template}módulo A (versão do pai)` }, new Map())?.agentId).toBe('a');
});

it('prompt só com espaços não casa nenhum subagente', () => {
  const subs = [sub('a', 'trabalho A', 'model-a')];
  expect(matchAgentSubagent(subs, { id: 'tool-a', prompt: '   \n ' }, new Map())).toBeUndefined();
});
