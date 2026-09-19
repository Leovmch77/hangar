import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@hangar/core';
import { autoScrollDir, dragChave, resolveDrop } from './dragToGroup';

type Row = SessionInfo & { serverId: string };
const s = (name: string, serverId = 'srv-a', over: Partial<Row> = {}): Row =>
  ({ name, serverId, state: 'idle', ...over }) as Row;

describe('resolveDrop', () => {
  it('solta sobre linha válida -> pede grupo', () => {
    const rows = [s('a'), s('b')];
    expect(resolveDrop('srv-a::b', { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'pair', chave: 'srv-a::b' });
  });

  it('solta sobre linha recusada pelo canPair (mesmo servidor, sessão morta) -> não faz nada', () => {
    const rows = [s('a'), s('b', 'srv-a', { state: 'dead' })];
    expect(resolveDrop('srv-a::b', { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'none' });
  });

  it('solta sobre linha de outro servidor -> não faz nada (canPair recusa other_server)', () => {
    const rows = [s('a', 'srv-a'), s('b', 'srv-b')];
    expect(resolveDrop('srv-b::b', { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'none' });
  });

  it('solta no fundo (sem linha sob o dedo) com origem já num grupo -> pede saída', () => {
    const rows = [s('a', 'srv-a', { pair_gid: 'g1' })];
    expect(resolveDrop(null, { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'leave' });
  });

  it('solta no fundo sem grupo -> não faz nada', () => {
    const rows = [s('a')];
    expect(resolveDrop(null, { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'none' });
  });

  it('origem sumiu da lista (morreu no meio do arrasto) -> não faz nada', () => {
    const rows = [s('b')];
    expect(resolveDrop('srv-a::b', { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'none' });
    expect(resolveDrop(null, { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'none' });
  });
});

describe('dragChave', () => {
  it('serverId + nome, separados por ::', () => {
    expect(dragChave({ serverId: 'srv-a', name: 'sess-1' })).toBe('srv-a::sess-1');
  });
});

describe('autoScrollDir', () => {
  it('dedo perto do topo -> rola pra cima', () => {
    expect(autoScrollDir(50, 0, 800, 56)).toBe(-1);
  });
  it('dedo perto do rodapé -> rola pra baixo', () => {
    expect(autoScrollDir(770, 0, 800, 56)).toBe(1);
  });
  it('dedo no meio -> não rola', () => {
    expect(autoScrollDir(400, 0, 800, 56)).toBe(0);
  });
  it('bordas são exclusivas (exatamente no limite não dispara)', () => {
    expect(autoScrollDir(56, 0, 800, 56)).toBe(0);
    expect(autoScrollDir(744, 0, 800, 56)).toBe(0);
  });
});
