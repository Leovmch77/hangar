import { describe, expect, it } from 'vitest';
import { accountMatchRange, accountMatches, accountInFilter, nextAccountSort, parseAccountSort, sortAccounts } from './accountsList';
import type { Credencial } from './credenciais';

const conta = (nome: string, extra: Partial<Credencial> = {}): Credencial =>
  ({ id: nome, tipo: 'claude', nome, nome_natural: nome, ativa: false, usos: [], ...extra });
const lida = (janelas: { rotulo: string; pct: number; reset_ts?: number }[]) => ({ estado: 'lida' as const, janelas });

describe('lista única de contas', () => {
  const a = conta('Rafael', { cota: lida([{ rotulo: '5h', pct: 13 }, { rotulo: '7d', pct: 6, reset_ts: 900 }]) });
  const b = conta('Felizardo', { ativa: true, cota: lida([{ rotulo: '5h', pct: 0 }, { rotulo: '7d', pct: 100, reset_ts: 300 }]) });
  const c = conta('Jefferson', { cota: lida([{ rotulo: '7d', pct: 39, reset_ts: 200 }]) });
  const sem = conta('GPT 6.1 Sol', { tipo: 'chave' });
  const lista = [a, b, c, sem];
  const nomes = (l: Credencial[]) => l.map((x) => x.nome);

  it('sem ordem escolhida, a conta em uso sobe e o resto mantém a ordem', () => {
    expect(nomes(sortAccounts(lista, null))).toEqual(['Felizardo', 'Rafael', 'Jefferson', 'GPT 6.1 Sol']);
  });

  it('percentual começa por quem gastou mais e sem leitura fica no fim nos dois sentidos', () => {
    const desc = nextAccountSort(null, '7d');
    expect(desc).toEqual({ key: '7d', dir: -1 });
    expect(nomes(sortAccounts(lista, desc))).toEqual(['Felizardo', 'Jefferson', 'Rafael', 'GPT 6.1 Sol']);
    expect(nomes(sortAccounts(lista, { key: '7d', dir: 1 }))).toEqual(['Rafael', 'Jefferson', 'Felizardo', 'GPT 6.1 Sol']);
    expect(nomes(sortAccounts(lista, { key: '5h', dir: 1 }))).toEqual(['Felizardo', 'Rafael', 'Jefferson', 'GPT 6.1 Sol']);
  });

  it('reset ordena pelo instante da janela de 7 dias, o mais próximo primeiro', () => {
    expect(nomes(sortAccounts(lista, nextAccountSort(null, 'reset')))).toEqual(['Jefferson', 'Felizardo', 'Rafael', 'GPT 6.1 Sol']);
  });

  it('terceiro clique na mesma coluna volta ao padrão', () => {
    const s1 = nextAccountSort(null, 'name');
    const s2 = nextAccountSort(s1, 'name');
    expect([s1, s2, nextAccountSort(s2, 'name')]).toEqual([{ key: 'name', dir: 1 }, { key: 'name', dir: -1 }, null]);
  });

  it('busca ignora acento e caixa e olha o email', () => {
    const x = conta('Conta', { login: { estado: 'ok', email: 'jeffer1312@gmail.com' } });
    expect(accountMatches(x, 'JEFFER')).toBe(true);
    expect(accountMatches(conta('João'), 'joao')).toBe(true);
    expect(accountMatches(x, 'rafael')).toBe(false);
  });

  it('trecho achado sai em posições do texto original, com ou sem acento', () => {
    expect(accountMatchRange('Felizardo e Batista', 'BATI')).toEqual([12, 16]);
    expect(accountMatchRange('João Silva', 'joao')).toEqual([0, 4]);
    expect(accountMatchRange('João', 'jo')).toEqual([0, 2]);
    expect(accountMatchRange('João', 'ao')).toEqual([2, 5]);
    expect([accountMatchRange('x', ''), accountMatchRange('x', 'y')]).toEqual([null, null]);
  });

  it('filtro separa Claude, Codex e o resto', () => {
    expect([accountInFilter(conta('x'), 'claude'), accountInFilter(conta('y', { tipo: 'codex' }), 'claude'),
      accountInFilter(sem, 'other'), accountInFilter(sem, 'all')]).toEqual([true, false, true, true]);
  });

  it('ordem salva ilegível vira a ordem padrão', () => {
    expect([parseAccountSort('{"key":"7d","dir":-1}'), parseAccountSort('{"key":"7d","dir":2}'), parseAccountSort('x')])
      .toEqual([{ key: '7d', dir: -1 }, null, null]);
  });
});
