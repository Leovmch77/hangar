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

  // Rodada de correção 1: o hit sobre a PRÓPRIA origem (dedo ainda sobre a alça, dentro da trilha
  // aberta) não pode virar nem grupo nem saída — resolveDrop já cobre isso via canPair (reason
  // 'same'); o filtro de UI (SessionList ignora o hit antes de destacar) é só pra não piscar.
  it('solta sobre a própria origem -> nenhum alvo (canPair recusa "same")', () => {
    const rows = [s('a', 'srv-a', { pair_gid: 'g1' })]; // com grupo: se caísse no "fundo" viraria 'leave'
    expect(resolveDrop('srv-a::a', { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'none' });
  });

  // Cabeçalho de um cluster de pareamento (rodada de correção 1): a tela passa a chave do 1º
  // membro do grupo como "hit" — pro resolveDrop isso é indistinguível de soltar sobre a linha dele.
  it('solta sobre o representante de um grupo (cabeçalho recolhido) -> pede grupo, se canPair permite', () => {
    const rows = [s('a'), s('rep', 'srv-a', { pair_gid: 'g1' }), s('outro', 'srv-a', { pair_gid: 'g1' })];
    expect(resolveDrop('srv-a::rep', { serverId: 'srv-a', name: 'a' }, rows)).toEqual({ kind: 'pair', chave: 'srv-a::rep' });
  });

  it('solta sobre o cabeçalho do PRÓPRIO grupo (origem já é membro) -> não faz nada (same_group)', () => {
    const rows = [s('origem', 'srv-a', { pair_gid: 'g1' }), s('rep', 'srv-a', { pair_gid: 'g1' })];
    expect(resolveDrop('srv-a::rep', { serverId: 'srv-a', name: 'origem' }, rows)).toEqual({ kind: 'none' });
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
