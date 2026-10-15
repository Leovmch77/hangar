import { afterEach, describe, expect, it } from 'vitest';
import type { QuoteRef } from '@hangar/core';
import { contextRefsDraft } from './contextRefsDraft.svelte';

const KEY = 'srv::sess';
const quote = (text: string): QuoteRef => ({ kind: 'quote', source: 'ev', before: '', after: '', text, comment: '' });

afterEach(() => {
  for (let i = contextRefsDraft.get(KEY).length - 1; i >= 0; i--) contextRefsDraft.remove(KEY, i);
});

describe('contextRefsDraft', () => {
  it('comentário editado durante o envio não deixa a citação enviada na bandeja', () => {
    contextRefsDraft.add(KEY, quote('a'));
    contextRefsDraft.add(KEY, quote('b'));
    const sent = [...contextRefsDraft.get(KEY)];
    // Durante o envio: a pessoa edita o comentário (troca o objeto) e cita outro trecho.
    contextRefsDraft.setComment(KEY, 0, 'novo');
    contextRefsDraft.add(KEY, quote('c'));
    contextRefsDraft.removeSent(KEY, sent);
    expect(contextRefsDraft.get(KEY).map((r) => r.kind === 'quote' && r.text)).toEqual(['c']);
  });

  it('cada item ganha uma identidade própria, mesmo com o mesmo conteúdo', () => {
    contextRefsDraft.add(KEY, quote('a'));
    contextRefsDraft.add(KEY, quote('a'));
    const [first, second] = contextRefsDraft.get(KEY);
    expect(first.draftId).not.toBe(second.draftId);
    contextRefsDraft.removeSent(KEY, [first]);
    expect(contextRefsDraft.get(KEY).map((r) => r.draftId)).toEqual([second.draftId]);
  });

  it('o comentário guarda o que foi digitado, inclusive o espaço do fim', () => {
    contextRefsDraft.add(KEY, quote('a'));
    contextRefsDraft.setComment(KEY, 0, 'deixe ');
    expect(contextRefsDraft.get(KEY)[0].comment).toBe('deixe ');
  });
});
