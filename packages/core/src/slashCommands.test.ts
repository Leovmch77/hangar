import { expect, it } from 'vitest';
import { sideQuestionOf, slashMatches } from './slashCommands';
import type { CommandInfo } from './types';

const cmd = (name: string): CommandInfo => ({ name, display: `/${name}`, source: 'builtin' });

it('prefixo antes de substring, com teto', () => {
  const all = [cmd('recompact'), cmd('compact'), cmd('clear'), cmd('help')];
  expect(slashMatches(all, 'comp').map((c) => c.name)).toEqual(['compact', 'recompact']);
  expect(slashMatches(all, '', 2)).toHaveLength(2);
  expect(slashMatches(all, null)).toEqual([]);
});

it('reconhece /btw com e sem pergunta', () => {
  expect(sideQuestionOf('/btw o que falta?')).toBe('o que falta?');
  expect(sideQuestionOf('/BTW')).toBe('');
  expect(sideQuestionOf('/btwx')).toBeNull();
  expect(sideQuestionOf('oi')).toBeNull();
});
