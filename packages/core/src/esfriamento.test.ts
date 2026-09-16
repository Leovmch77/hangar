import { describe, it, expect, beforeEach } from 'vitest';
import {
  esperaDe, esquecerServidor, estaEsfriando, registrarFalha, registrarSucesso, retentarAgora,
  _limparEsfriamentoParaTestes,
} from './esfriamento';

beforeEach(() => _limparEsfriamentoParaTestes());

describe('esfriamento por servidor', () => {
  it('só esfria na terceira falha seguida, e a espera cresce a cada rodada', () => {
    const t = 1_000_000;
    registrarFalha('pc', t);
    registrarFalha('pc', t);
    expect(estaEsfriando('pc', t)).toBe(false);   // tropeço de rede não pode sumir com a máquina

    registrarFalha('pc', t);
    expect(esperaDe('pc', t)).toBe(60_000);
    expect(estaEsfriando('pc', t + 59_000)).toBe(true);
    expect(estaEsfriando('pc', t + 61_000)).toBe(false);   // vence sozinha, ninguém precisa mexer

    registrarFalha('pc', t + 61_000);
    expect(esperaDe('pc', t + 61_000)).toBe(120_000);
  });

  it('a espera tem teto e nunca vira desistir', () => {
    let t = 0;
    let ultima = 0;
    for (let i = 0; i < 20; i++) {
      registrarFalha('pc', t);
      ultima = esperaDe('pc', t);   // a espera vale a partir de AGORA; medir depois de avançar dá 0
      t += ultima + 1;
    }
    expect(ultima).toBe(900_000);   // no teto, e ainda tentando
  });

  it('uma resposta boa apaga o histórico inteiro, não só a espera', () => {
    const t = 500;
    registrarFalha('pc', t); registrarFalha('pc', t); registrarFalha('pc', t);
    registrarSucesso('pc');
    expect(estaEsfriando('pc', t)).toBe(false);
    registrarFalha('pc', t); registrarFalha('pc', t);
    expect(estaEsfriando('pc', t)).toBe(false);   // recomeça do zero, não da terceira
  });

  it('buscar agora não recomeça a escala nem sobe de degrau', () => {
    const t = 0;
    registrarFalha('pc', t); registrarFalha('pc', t); registrarFalha('pc', t);
    expect(esperaDe('pc', t)).toBe(60_000);

    retentarAgora('pc');
    expect(estaEsfriando('pc', t)).toBe(false);
    registrarFalha('pc', t);
    expect(esperaDe('pc', t)).toBe(60_000);   // continuou morta: a MESMA espera, não a seguinte

    retentarAgora('pc'); registrarFalha('pc', t);
    retentarAgora('pc'); registrarFalha('pc', t);
    expect(esperaDe('pc', t)).toBe(60_000);   // tocar três vezes não vira castigo de 15 min

    registrarFalha('pc', t);                  // falha que NÃO veio de toque: aí sim sobe
    expect(esperaDe('pc', t)).toBe(120_000);
  });

  it('servidor que sai da lista some do mapa', () => {
    const t = 0;
    registrarFalha('pc', t); registrarFalha('pc', t); registrarFalha('pc', t);
    expect(estaEsfriando('pc', t)).toBe(true);
    esquecerServidor('pc');
    expect(estaEsfriando('pc', t)).toBe(false);
  });

  it('cada servidor tem o seu relógio', () => {
    const t = 0;
    registrarFalha('a', t); registrarFalha('a', t); registrarFalha('a', t);
    expect(estaEsfriando('a', t)).toBe(true);
    expect(estaEsfriando('b', t)).toBe(false);
    retentarAgora();
    expect(estaEsfriando('a', t)).toBe(false);
  });
});
