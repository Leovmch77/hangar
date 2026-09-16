import { describe, it, expect, beforeEach } from 'vitest';
import {
  definirArmazem, definirProtegido, estaDesligado, esquecerServidor, registrarFalha, registrarSucesso, retentarAgora,
  _limparEsfriamentoParaTestes,
} from './esfriamento';

beforeEach(() => { _limparEsfriamentoParaTestes(); definirProtegido(() => false); });

describe('servidor desligado', () => {
  it('servidor protegido (o ativo) nunca é marcado, venha a falha de onde vier', () => {
    definirProtegido((id) => id === 'ativo');
    registrarFalha('ativo');
    registrarFalha('outro');
    expect(estaDesligado('ativo')).toBe(false);
    expect(estaDesligado('outro')).toBe(true);
  });

  it('uma falha de rede já marca; ninguém mais procura por ele', () => {
    expect(estaDesligado('pc')).toBe(false);
    registrarFalha('pc');
    expect(estaDesligado('pc')).toBe(true);
  });

  it('só volta por ação da pessoa, nunca por tempo', () => {
    registrarFalha('pc');
    retentarAgora('pc');
    expect(estaDesligado('pc')).toBe(false);
    // Continuou morta: uma falha e já desliga de novo.
    registrarFalha('pc');
    expect(estaDesligado('pc')).toBe(true);
    retentarAgora();                 // "buscar agora" sem id libera todos
    expect(estaDesligado('pc')).toBe(false);
  });

  it('respondeu: sai da lista', () => {
    registrarFalha('pc');
    registrarSucesso('pc');
    expect(estaDesligado('pc')).toBe(false);
  });

  it('cada servidor é independente e sair da lista apaga o estado', () => {
    registrarFalha('a');
    expect(estaDesligado('a')).toBe(true);
    expect(estaDesligado('b')).toBe(false);
    esquecerServidor('a');
    expect(estaDesligado('a')).toBe(false);
  });

  it('a marca sobrevive ao recarregamento do app', () => {
    // O iOS descarrega e recarrega o PWA sozinho; com o estado só em memória, cada retomada
    // recomeçava a varredura — foi o que impediu as tentativas de chegarem a zero.
    const guardado = new Map<string, string>();
    // O core não toca `localStorage`: quem o tem (o web) entrega por `definirArmazem`.
    const falso = {
      getItem: (k: string) => guardado.get(k) ?? null,
      setItem: (k: string, v: string) => void guardado.set(k, v),
      removeItem: (k: string) => void guardado.delete(k),
    };
    definirArmazem(falso);
    try {
      registrarFalha('pc');
      expect(guardado.get('hangar_servidores_desligados')).toContain('pc');
      _limparEsfriamentoParaTestes();          // simula o app subindo de novo…
      guardado.set('hangar_servidores_desligados', JSON.stringify(['pc']));
      expect(estaDesligado('pc')).toBe(true);  // …e a marca continua lá
    } finally {
      definirArmazem(null);
    }
  });
});
