// @vitest-environment happy-dom
// A moeda vale pro app inteiro e a cotação vem do backend. O que não pode acontecer: mostrar um
// valor "em real" convertido por uma taxa que não temos, e perder a escolha que já existia na
// tela de custos.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchCotacao = vi.fn();
vi.mock('@hangar/core', () => ({ fetchCotacao: () => fetchCotacao() }));

async function carregarModulo() {
  vi.resetModules();
  return (await import('./moeda.svelte')).moeda;
}

beforeEach(() => {
  localStorage.clear();
  fetchCotacao.mockReset();
  fetchCotacao.mockResolvedValue(5.14);
});

afterEach(() => localStorage.clear());

describe('moeda do app', () => {
  it('nasce em dólar quando ninguém escolheu', async () => {
    const moeda = await carregarModulo();
    expect(moeda.cur).toBe('USD');
  });

  it('herda a escolha antiga da tela de custos', async () => {
    localStorage.setItem('cp_costs_currency', 'BRL');
    const moeda = await carregarModulo();
    expect(moeda.cur).toBe('BRL');
  });

  it('a chave nova vence a antiga', async () => {
    localStorage.setItem('cp_costs_currency', 'BRL');
    localStorage.setItem('cp_moeda', 'USD');
    const moeda = await carregarModulo();
    expect(moeda.cur).toBe('USD');
  });

  it('escolher persiste', async () => {
    const moeda = await carregarModulo();
    moeda.escolher('BRL');
    expect(moeda.cur).toBe('BRL');
    expect(localStorage.getItem('cp_moeda')).toBe('BRL');
  });

  it('busca a cotação uma vez só, por mais que a tela peça', async () => {
    const moeda = await carregarModulo();
    moeda.garantirCotacao();
    moeda.garantirCotacao();
    await vi.waitFor(() => expect(moeda.rate).toBe(5.14));
    moeda.garantirCotacao();
    expect(fetchCotacao).toHaveBeenCalledTimes(1);
  });

  it('sem cotação não há real: temCotacao fica falso e o rate não vira zero', async () => {
    fetchCotacao.mockResolvedValue(null);
    const moeda = await carregarModulo();
    moeda.garantirCotacao();
    await vi.waitFor(() => expect(fetchCotacao).toHaveBeenCalled());
    expect(moeda.rate).toBeNull();
    expect(moeda.temCotacao).toBe(false);
  });
});
