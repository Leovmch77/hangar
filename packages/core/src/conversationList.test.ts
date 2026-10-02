import { describe, expect, it } from 'vitest';
import { mergeConversations, rememberEntry, takeEntry } from './conversationList';

const entry = (sid: string, mtime: number, live = false) => ({
  project: 'p', cwd: '/p', session_id: sid, mtime, preview: `msg ${sid}`, ultima: '', live,
  config_dir: null, conta: '', provider: 'claude' as const,
});
const id = (r: ReturnType<typeof mergeConversations>[number]) => (r.kind === 'live' ? r.name : r.entry.session_id);

describe('mergeConversations', () => {
  it('junta vivas e fechadas por recência e esconde a fechada que está viva', () => {
    const rows = mergeConversations(
      [{ serverId: 's1', name: 'hangar', last_activity: 200, state: 'idle' }],
      new Map([['s1', [entry('a', 300), entry('b', 100), entry('viva', 250, true)]]]),
    );
    expect(rows.map(id)).toEqual(['a', 'hangar', 'b']);
  });
  it('fechada sem preview usa a última mensagem como título', () => {
    const e = { ...entry('k', 1), preview: '', ultima: 'fim' };
    expect(mergeConversations([], new Map([['s1', [e]]]))[0].title).toBe('fim');
  });
  it('esconde a fechada cujo transcript é o de uma sessão viva, mesmo com live=false', () => {
    const rows = mergeConversations(
      [{ serverId: 's1', name: 'hangar', last_activity: 200, state: 'idle', jsonl: '/home/x/.claude/projects/p/abc.jsonl' }],
      new Map([['s1', [entry('abc', 300), entry('b', 100)]]]),
    );
    expect(rows.map(id)).toEqual(['hangar', 'b']);
  });
  it('o transcript vivo de outro servidor não esconde a fechada homônima', () => {
    const rows = mergeConversations(
      [{ serverId: 's1', name: 'hangar', last_activity: 200, state: 'idle', jsonl: 'C:\\x\\abc.jsonl' }],
      new Map([['s2', [entry('abc', 300)]]]),
    );
    expect(rows.map(id)).toEqual(['abc', 'hangar']);
  });
});

describe('rememberEntry / takeEntry', () => {
  it('entrega a entrada uma vez só', () => {
    const e = entry('x', 1);
    rememberEntry('s1', e);
    expect(takeEntry('s1', 'p', 'x')).toBe(e);
    expect(takeEntry('s1', 'p', 'x')).toBeUndefined();
  });
});
