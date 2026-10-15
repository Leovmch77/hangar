import { beforeEach, describe, expect, it } from 'vitest';
import type { ContextRef, QuoteRef } from '@hangar/core';
import {
  addContextRef, contextRefsKey, contextRefsSnapshot, removeContextRef, removeSentContextRefs, setContextRefComment,
  useContextRefs,
} from './contextRefs';

const q = (text: string): QuoteRef => ({ kind: 'quote', source: 'ev', before: '', after: '', text, comment: '' });
const key = contextRefsKey('srv', 'sess');
const refs = () => useContextRefs.getState().drafts[key] ?? [];
const textOf = (r: ContextRef) => (r.kind === 'quote' ? r.text : '');

beforeEach(() => useContextRefs.setState({ drafts: {} }));

describe('contextRefs (app)', () => {
  it('acrescenta, comenta e remove por conversa', () => {
    addContextRef(key, q('a'));
    addContextRef(key, q('b'));
    addContextRef(contextRefsKey('srv', 'outra'), q('c'));
    setContextRefComment(key, 1, 'muda isto');
    expect(refs().map((r) => [textOf(r), r.comment])).toEqual([['a', ''], ['b', 'muda isto']]);
    removeContextRef(key, 0);
    expect(refs().map(textOf)).toEqual(['b']);
    removeContextRef(key, 0);
    expect(key in useContextRefs.getState().drafts).toBe(false);
    expect(useContextRefs.getState().drafts[contextRefsKey('srv', 'outra')]).toHaveLength(1);
  });

  it('o envio tira só as citações enviadas', () => {
    addContextRef(key, q('a'));
    const sent = [...refs()];
    addContextRef(key, q('nova durante o envio'));
    removeSentContextRefs(key, sent);
    expect(refs().map(textOf)).toEqual(['nova durante o envio']);
  });

  it('comentário editado durante o envio não deixa a citação enviada na bandeja', () => {
    addContextRef(key, q('a'));
    const sent = [...contextRefsSnapshot(key)];
    setContextRefComment(key, 0, 'editado no meio do envio');
    removeSentContextRefs(key, sent);
    expect(contextRefsSnapshot(key)).toEqual([]);
  });

  it('itens iguais têm identidades diferentes; o comentário guarda o espaço do fim', () => {
    addContextRef(key, q('a'));
    addContextRef(key, q('a'));
    const [first, second] = refs();
    expect(first.draftId).not.toBe(second.draftId);
    setContextRefComment(key, 1, 'deixe ');
    removeSentContextRefs(key, [first]);
    expect(refs()).toEqual([{ ...q('a'), comment: 'deixe ', draftId: second.draftId }]);
  });
});
