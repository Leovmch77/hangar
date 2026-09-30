import { describe, expect, it } from 'vitest';
import type { LiveShortcutTerminal } from '@hangar/core';
import { forgetServer, hangarForShortcut, hangarOf, liveTerminals, requestHangarTab, runningFor, sessionTerminalFor,
  setLiveTerminals, takeHangarTab, tileStateOf } from './hangarTerminals.svelte';

const hangar: LiveShortcutTerminal = { id: 'abc123', label: 'RDP', alive: true, exit_code: null, created: 0,
  owner: '', key: 'global:a-1', origin: 'sess-a', ask: true, question: null };
const session: LiveShortcutTerminal = { ...hangar, id: 'def456', owner: 'sess-a', key: 'global:b-2',
  question: { text: 'Porta', default: '3000', screen: ['Porta [3000]:'] } };

describe('hangarTerminals', () => {
  it('separa No Hangar dos terminais de sessão', () => {
    setLiveTerminals('srv', JSON.stringify([hangar, session]));
    expect(hangarOf('srv').map((t) => t.id)).toEqual(['abc123']);
    expect(hangarForShortcut('srv', 'global:a-1')?.id).toBe('abc123');
    expect(sessionTerminalFor('srv', 'sess-a', 'global:b-2')?.id).toBe('def456');
    expect(sessionTerminalFor('srv', 'sess-a', 'global:a-1')).toBeNull();
  });

  it('chave com espaços repetidos casa com a linha (o backend colapsa)', () => {
    setLiveTerminals('srv', JSON.stringify([{ ...hangar, key: 'global:a 1' }, { ...session, key: 'global:b 2' }]));
    expect(hangarForShortcut('srv', 'global:a   1')?.id).toBe('abc123');
    expect(sessionTerminalFor('srv', 'sess-a', ' global:b \t 2 ')?.id).toBe('def456');
  });

  it('elemento inválido do quadro é descartado sem perder os válidos', () => {
    setLiveTerminals('srv', JSON.stringify([null, 3, { label: 'sem id' }, hangar]));
    expect(hangarOf('srv').map((t) => t.id)).toEqual(['abc123']);
  });

  it('servidor que caiu some do chip', () => {
    setLiveTerminals('srv', JSON.stringify([hangar]));
    forgetServer('srv');
    expect(hangarOf('srv')).toEqual([]);
  });

  it('estado do tile', () => {
    expect(tileStateOf(null)).toBe('idle');
    expect(tileStateOf(hangar)).toBe('running');
    expect(tileStateOf(session)).toBe('asking');
    expect(tileStateOf({ ...hangar, alive: false, exit_code: 131 })).toBe('exited');
  });

  it('frame torto mantém a lista anterior', () => {
    setLiveTerminals('srv', JSON.stringify([hangar]));
    setLiveTerminals('srv', '{quebrado');
    expect(liveTerminals.byServer.srv).toHaveLength(1);
  });

  it('pedido de aba é consumido uma vez', () => {
    requestHangarTab('srv', 'abc123');
    expect(takeHangarTab('srv')).toBe('abc123');
    expect(takeHangarTab('srv')).toBeNull();
  });

  it('tempo rodando', () => {
    expect(runningFor(1000, 1000_000 + 30_000)).toEqual({ minutes: 1 });
    expect(runningFor(1000, 1000_000 + 42 * 60_000)).toEqual({ minutes: 42 });
    expect(runningFor(1000, 1000_000 + 125 * 60_000)).toEqual({ hours: 2 });
  });
});
