import { describe, expect, it } from 'vitest';
import {
  firstConversationEffect, transitionFirstConversation,
  type FirstConversationAttempt, type FirstConversationEvent, type FirstConversationPhase,
} from './firstConversation';

const PHASES: FirstConversationPhase[] = ['draft', 'creating', 'create_unknown', 'created', 'sending', 'send_unknown', 'sent'];
const EVENTS: FirstConversationEvent[] = [
  { type: 'begin' }, { type: 'create_ok', sessionName: 'proj-a1' }, { type: 'create_rejected' },
  { type: 'create_unknown' }, { type: 'send_begin' }, { type: 'send_ok' }, { type: 'send_rejected' }, { type: 'send_unknown' },
];

// Tabela do plano; o que não está aqui é ignorado.
const TABLE: Record<string, FirstConversationPhase> = {
  'draft+begin': 'creating',
  'creating+create_ok': 'created',
  'create_unknown+create_ok': 'created',
  'creating+create_rejected': 'draft',
  'creating+create_unknown': 'create_unknown',
  'created+send_begin': 'sending',
  'sending+send_ok': 'sent',
  'sending+send_rejected': 'created',
  'sending+send_unknown': 'send_unknown',
};

function attempt(phase: FirstConversationPhase, sessionName: string | null = null): FirstConversationAttempt {
  return {
    id: 'att-1', serverId: 'srv-1', body: { name: 'proj-a1', cwd: '/home/u/proj', provider: 'claude' },
    text: 'primeira mensagem', phase, sessionName,
  };
}

describe('transitionFirstConversation', () => {
  for (const phase of PHASES) {
    for (const event of EVENTS) {
      const expected = TABLE[`${phase}+${event.type}`];
      it(`${phase} + ${event.type} → ${expected ?? 'ignorado'}`, () => {
        const before = attempt(phase, phase === 'draft' || phase === 'creating' || phase === 'create_unknown' ? null : 'proj-a1');
        const after = transitionFirstConversation(before, event);
        if (expected === undefined) {
          expect(after).toBe(before);
        } else {
          expect(after.phase).toBe(expected);
          expect(after.text).toBe('primeira mensagem');
          expect(after.body).toBe(before.body);
          expect(after.id).toBe('att-1');
          expect(after.serverId).toBe('srv-1');
        }
      });
    }
  }

  it('create_ok grava o nome devolvido pelo servidor', () => {
    const after = transitionFirstConversation(attempt('create_unknown'), { type: 'create_ok', sessionName: 'proj-a1-2' });
    expect(after.sessionName).toBe('proj-a1-2');
  });

  it('send_rejected volta a created conservando sessão e texto', () => {
    const after = transitionFirstConversation(attempt('sending', 'proj-a1'), { type: 'send_rejected' });
    expect(after).toMatchObject({ phase: 'created', sessionName: 'proj-a1', text: 'primeira mensagem' });
  });

  it('send_ok conserva o snapshot até o handoff', () => {
    const after = transitionFirstConversation(attempt('sending', 'proj-a1'), { type: 'send_ok' });
    expect(after).toMatchObject({ phase: 'sent', sessionName: 'proj-a1', text: 'primeira mensagem' });
  });

  it('não altera a tentativa recebida', () => {
    const before = attempt('draft');
    transitionFirstConversation(before, { type: 'begin' });
    expect(before.phase).toBe('draft');
  });
});

describe('firstConversationEffect', () => {
  it('somente draft cria e somente created envia; incertas só recuperam', () => {
    expect(PHASES.map((p) => [p, firstConversationEffect(p)])).toEqual([
      ['draft', 'create'], ['creating', 'none'], ['create_unknown', 'recover'],
      ['created', 'send'], ['sending', 'none'], ['send_unknown', 'recover'], ['sent', 'none'],
    ]);
  });

  it('fase incerta não volta a criar nem a enviar por evento algum de início', () => {
    for (const phase of ['create_unknown', 'send_unknown'] as const) {
      const before = attempt(phase, phase === 'send_unknown' ? 'proj-a1' : null);
      expect(transitionFirstConversation(before, { type: 'begin' })).toBe(before);
      expect(transitionFirstConversation(before, { type: 'send_begin' })).toBe(before);
    }
  });
});
