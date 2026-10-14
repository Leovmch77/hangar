import { describe, it, expect } from 'vitest';
import { proposedPlan, planDisplayText, planTitle, planHeading, pendingExitPlanMode, pendingProposedPlan, pendingReplyPlan, planChoiceKey } from './proposedPlan';
import type { ChatEvent } from './types';

describe('plano à espera de decisão', () => {
  const ev = (id: string, kind: ChatEvent['kind'], text: string) => ({ id, kind, text }) as ChatEvent;
  it('vale até a próxima mensagem real; a da fila não conta', () => {
    const plan = ev('a1', 'assistant_msg', '<proposed_plan>\n# P\n</proposed_plan>');
    expect(pendingProposedPlan([plan, ev('queued-1', 'user_msg', 'x')])).toEqual({ id: 'a1', plan: '# P' });
    expect(pendingProposedPlan([plan, ev('u1', 'user_msg', 'x')])).toBeNull();
    expect(pendingReplyPlan([ev('a0', 'assistant_msg', 'velho'), ev('a2', 'assistant_msg', 'novo')])).toEqual({ id: 'a2', plan: 'novo' });
    expect(pendingReplyPlan([ev('a0', 'assistant_msg', 'velho'), ev('a2', 'assistant_msg', 'novo')], 'a0')).toEqual({ id: 'a0', plan: 'velho' });
  });
});

it('usa o primeiro título real, ignorando cercas e código indentado', () => {
  expect(planTitle('```md\n# Exemplo\n```\n    # Código\n## Título real ###\n# Outro')).toBe('Título real');
  expect(planTitle('~~~~md\n# Exemplo\n~~~\n# Ainda exemplo\n~~~~\nTítulo setext\n=====')).toBe('Título setext');
  expect(planTitle('Sem título\n\n- Etapa')).toBeNull();
  expect(planTitle('# ' + 'Longo '.repeat(80))).toBe('Longo '.repeat(80).trim());
});

describe('plano proposto pelo Codex', () => {
  it('extrai o plano completo preservando o Markdown', () => {
    const text = 'Segue o plano.\n<proposed_plan>\n# Plano\n\n- **Primeiro**\n</proposed_plan>';
    expect(proposedPlan(text)).toBe('# Plano\n\n- **Primeiro**');
    expect(planDisplayText(text)).toBe('Segue o plano.\n\n# Plano\n\n- **Primeiro**\n');
  });
  it('não oferece aprovação durante a escrita', () => {
    expect(proposedPlan('<proposed_plan>\n# Incompleto')).toBeNull();
    expect(planDisplayText('<proposed_plan>\n# Incompleto')).toBe('\n# Incompleto');
  });
  it('preserva exemplos de tags dentro de blocos de código', () => {
    const example = '```xml\n<proposed_plan>\ntexto\n</proposed_plan>\n```';
    expect(proposedPlan(example)).toBeNull();
    expect(planDisplayText(example)).toBe(example);
  });
  it('tira o bloco de citação da memória inteiro, fora de cercas', () => {
    const cite = '<oai-mem-citation>\n<citation_entries>\nMEMORY.md:32-36|note=[x]\n</citation_entries>\n</oai-mem-citation>';
    expect(planDisplayText(`Resposta.\n\n${cite}`)).toBe('Resposta.\n\n');
    const example = '```\n' + cite + '\n```';
    expect(planDisplayText(example)).toBe(example);
    expect(planDisplayText('Resposta.\n<oai-mem-citation>\nincompleto')).toBe('Resposta.\n');
  });
  it('oculta a citação em uma linha preservando o texto após o fechamento', () => {
    const cite = '<oai-mem-citation><citation_entries>MEMORY.md:32-36|note=[x]</citation_entries></oai-mem-citation>';
    expect(planDisplayText(`Resposta.\n${cite}\nOutra frase.`)).toBe('Resposta.\n\nOutra frase.');
    expect(planDisplayText(`${cite} Outra frase.`)).toBe(' Outra frase.');
    expect(planDisplayText(`~~~xml\n${cite}\n~~~`)).toBe(`~~~xml\n${cite}\n~~~`);
    expect(planDisplayText('`<oai-mem-citation>` é uma tag.')).toBe('`<oai-mem-citation>` é uma tag.');
  });
  it('reconhece a tag final sem abertura no trecho recebido', () => {
    expect(proposedPlan('# Plano\n\nEtapas.\n</proposed_plan>')).toBe('# Plano\n\nEtapas.');
  });
});

describe('planChoiceKey', () => {
  it('abrevia só as escolhas conhecidas do diálogo de plano da TUI', () => {
    expect(planChoiceKey('Yes, manually approve edits')).toBe('manual');
    expect(planChoiceKey('Yes, and bypass permissions')).toBe('bypass');
    expect(planChoiceKey('Yes, and auto-accept edits')).toBe('auto');
    expect(planChoiceKey('Tell Claude what to change')).toBe('changes');
    expect(planChoiceKey('No, keep planning')).toBe('keep');
    expect(planChoiceKey('Yes, and use auto mode')).toBe('auto_mode');
    expect(planChoiceKey('Outra coisa')).toBeNull();
  });
});

describe('planHeading', () => {
  it('tira do corpo o mesmo título que o planTitle acha, em qualquer forma', () => {
    expect(planHeading('# Migrar\n\nTexto')).toEqual({ title: 'Migrar', body: '\nTexto' });
    expect(planHeading('\n## Passo a passo ##\nTexto')).toEqual({ title: 'Passo a passo', body: '\nTexto' });
    expect(planHeading('Plano setext\n====\nTexto')).toEqual({ title: 'Plano setext', body: 'Texto' });
    expect(planHeading('```md\n# exemplo\n```\n# Real\nTexto')).toEqual({ title: 'Real', body: '```md\n# exemplo\n```\nTexto' });
    expect(planHeading('só texto')).toEqual({ title: null, body: 'só texto' });
    expect(planTitle('Plano setext\n====\nTexto')).toBe('Plano setext');
  });
});

describe('pendingExitPlanMode', () => {
  const tool = (id: string, toolUseId: string, name = 'ExitPlanMode') => ({ id, kind: 'tool_use', tool_name: name, tool_use_id: toolUseId } as ChatEvent);
  const result = (id: string, toolUseId: string) => ({ id, kind: 'tool_result', tool_use_id: toolUseId } as ChatEvent);
  const user = (id: string) => ({ id, kind: 'user_msg', text: 'oi' } as ChatEvent);

  it('é a chamada do turno ainda sem resultado, mesmo com o Write do plano respondendo depois', () => {
    expect(pendingExitPlanMode([tool('w', 'tw', 'Write'), tool('e', 'te'), result('rw', 'tw')])).toBe(true);
    expect(pendingExitPlanMode([tool('e', 'te'), result('re', 'te')])).toBe(false);
    expect(pendingExitPlanMode([tool('e', 'te'), user('u')])).toBe(false);
    expect(pendingExitPlanMode([tool('e', 'te'), user('queued-1')])).toBe(true);
    expect(pendingExitPlanMode([])).toBe(false);
  });
});
