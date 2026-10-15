import { describe, expect, it } from 'vitest';
import type { ChatEvent } from './types';
import {
  beginQueueEdit, canUpdateQueueEdit, currentQueuePanel, derivedQueuePanel, dropTarget, hiddenByQueuePanel,
  moveTarget, parseQueuePanel, queueEditLeft, queueSteerable, type QueuePanel,
} from './queuePanel';

const q = (id: string, extra: Partial<ChatEvent> = {}): ChatEvent =>
  ({ kind: 'user_msg', id: `queued-${id}`, text: `t ${id}`, queued_delivered: false, queued_ts: 1, ...extra });
const panel = (...ids: string[]): QueuePanel => ({ actions: true, entries: ids.map((id) => ({ id, text: `t ${id}`, ts: 1 })) });

describe('queuePanel', () => {
  it('lê o evento do servidor e recusa forma torta', () => {
    expect(parseQueuePanel({ entries: [{ id: 'a', text: 'x', ts: 2 }], actions: true }))
      .toEqual({ actions: true, entries: [{ id: 'a', text: 'x', ts: 2 }] });
    expect(parseQueuePanel({ entries: 'x' })).toBeNull();
    expect(parseQueuePanel({ entries: [{ id: 1 }], actions: true })).toEqual({ actions: true, entries: [] });
  });
  it('sem o evento, deriva só as que esperam e sem ações', () => {
    const events = [q('a'), q('b', { queued_delivered: true }), q('c', { desistiu: true }), { kind: 'user_msg', id: 'real', text: 'x' } as ChatEvent];
    expect(derivedQueuePanel(events)).toEqual({ actions: false, entries: [{ id: 'a', text: 't a', ts: 1 }] });
    expect(currentQueuePanel(null, events).actions).toBe(false);
    expect(currentQueuePanel(panel('z'), events).entries[0].id).toBe('z');
  });
  it('esconde da conversa só a bolha que está no painel', () => {
    expect(hiddenByQueuePanel(q('a'), panel('a'))).toBe(true);
    expect(hiddenByQueuePanel(q('b'), panel('a'))).toBe(false);
    expect(hiddenByQueuePanel({ kind: 'tool_result', id: 'queued-a' } as ChatEvent, panel('a'))).toBe(false);
  });
  it('editar guarda o rascunho uma vez e trocar de linha não o perde', () => {
    const first = beginQueueEdit({ id: 'a', text: 'texto a', ts: 1 }, 'meu rascunho', null);
    expect(first).toEqual({ edit: { entryId: 'a', original: 'texto a', savedDraft: 'meu rascunho' }, composerText: 'texto a' });
    const second = beginQueueEdit({ id: 'b', text: 'texto b', ts: 1 }, 'texto a editado', first.edit);
    expect(second.edit.savedDraft).toBe('meu rascunho');
  });
  it('texto vazio ou comando não atualiza', () => {
    expect(canUpdateQueueEdit('  ')).toBe(false);
    expect(canUpdateQueueEdit('/clear')).toBe(false);
    expect(canUpdateQueueEdit('ok')).toBe(true);
  });
  it('a entrada que saiu da fila durante a edição vira rascunho só com o rascunho vazio', () => {
    const edit = { entryId: 'a', original: 'x', savedDraft: '' };
    expect(queueEditLeft(edit, panel('a'), 'novo')).toBeNull();
    expect(queueEditLeft(edit, panel(), 'novo')).toEqual({ composerText: 'novo' });
    expect(queueEditLeft({ ...edit, savedDraft: 'antes' }, panel(), 'novo')).toEqual({ composerText: 'antes' });
  });
  it('setas e arrasto dão o before_id certo e nada na mesma posição', () => {
    const e = panel('a', 'b', 'c').entries;
    expect(moveTarget(e, 'b', -1)).toBe('a');
    expect(moveTarget(e, 'b', 1)).toBeNull();
    expect(moveTarget(e, 'a', 1)).toBe('c');
    expect(moveTarget(e, 'a', -1)).toBeUndefined();
    expect(moveTarget(e, 'c', 1)).toBeUndefined();
    expect(dropTarget(e, 'c', 'a', false)).toBe('a');
    expect(dropTarget(e, 'a', 'c', true)).toBeNull();
    expect(dropTarget(e, 'a', 'b', false)).toBeUndefined();
    expect(dropTarget(e, 'a', 'a', true)).toBeUndefined();
  });
  it('Pi e omp não orientam por item', () => {
    expect(queueSteerable('pi')).toBe(false);
    expect(queueSteerable('omp')).toBe(false);
    expect(queueSteerable('claude')).toBe(true);
  });
});
