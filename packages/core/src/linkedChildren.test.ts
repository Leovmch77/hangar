import { describe, expect, it } from 'vitest';
import { linkedChildren, linkedChildrenDone } from './linkedChildren';
import type { AggSession, SessionInfo } from './types';

const session = (serverId: string, name: string, extra: Partial<AggSession> = {}): AggSession => ({
  serverId, name, serverLabel: serverId, serverColor: '#123', state: 'idle', ...extra,
});

describe('linkedChildren', () => {
  const parent = session('srv-a', 'hangar');
  const doc = session('srv-a', 'hangar-doc', { linked_by: 'hangar', state: 'idle' });
  const review = session('srv-a', 'hangar-revisao', { linked_by: 'hangar', state: 'working' });
  const otherServer = session('srv-b', 'hangar-x', { linked_by: 'hangar' });
  const otherParent = session('srv-a', 'outra-filha', { linked_by: 'outro' });
  const unlinked = session('srv-a', 'solta', { linked_by: null });

  it('devolve só as filhas do mesmo servidor, ordenadas por nome', () => {
    const rows = [review, otherServer, parent, unlinked, doc, otherParent];
    expect(linkedChildren(rows, parent)).toEqual([doc, review]);
  });

  it('sem filhas devolve lista vazia', () => {
    expect(linkedChildren([parent, unlinked], parent)).toEqual([]);
  });

  it('lista de um servidor só, sem serverId, filtra só pelo pai', () => {
    const local = (name: string, linked_by?: string): SessionInfo => ({ name, state: 'idle', linked_by });
    const b = local('b', 'hangar');
    const a = local('a', 'hangar');
    expect(linkedChildren([b, local('hangar'), local('c', 'outro'), a], { name: 'hangar' })).toEqual([a, b]);
  });
});

describe('linkedChildrenDone', () => {
  it('conta só as concluídas (idle)', () => {
    const rows = [
      session('s', 'a', { state: 'working' }),
      session('s', 'b', { state: 'awaiting_input' }),
      session('s', 'c', { state: 'idle' }),
      session('s', 'd', { state: 'idle' }),
      session('s', 'e', { state: 'dead' }),
    ];
    expect(linkedChildrenDone(rows)).toBe(2);
  });

  it('lista vazia dá zero', () => {
    expect(linkedChildrenDone([])).toBe(0);
  });
});
