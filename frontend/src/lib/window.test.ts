import { describe, it, expect } from 'vitest';
import { precisaPreencher, mostrarIrPraoFim, nextAtBottom } from './window';

describe('nextAtBottom', () => {
  it('subir 20px durante o streaming solta do fim, mesmo dentro da folga de 64px', () => {
    // O bug: gap=20 < 64 mantinha a lista colada e o próximo pedaço da prévia puxava de volta.
    expect(nextAtBottom(true, 980, 1000, 20)).toBe(false);
  });

  it('o primeiro passo de uma rolagem suave, 2px pra cima colada no fim, já solta', () => {
    expect(nextAtBottom(true, 998, 1000, 2)).toBe(false);
  });

  it('conteúdo encolheu com a lista colada: scrollTop cai mas a folga segue ~0, continua colada', () => {
    expect(nextAtBottom(true, 700, 1000, 0.5)).toBe(true);   // meio pixel do arredondamento
    expect(nextAtBottom(true, 700, 1000, 0)).toBe(true);
  });

  it('solta e parada perto do fim: a prévia cresce sem evento de scroll e ninguém reencosta sozinho', () => {
    expect(nextAtBottom(false, 980, 980, 300)).toBe(false);
  });

  it('descer até 64px do fim reencosta', () => {
    expect(nextAtBottom(false, 990, 900, 40)).toBe(true);
  });

  it('descer e ainda estar longe do fim não muda nada', () => {
    expect(nextAtBottom(false, 500, 400, 600)).toBe(false);
  });
});

describe('mostrarIrPraoFim', () => {
  it('a faixa morta: janela congelada com evento novo e ainda sem uma tela rolada', () => {
    // O caso relatado em 25/08/2026. Rolou pouco (scrolledUp falso, porque nao passou de uma tela)
    // mas o suficiente pra sair dos 64px do atBottom -> a janela congelou em 40 com 45 eventos.
    // Antes disto o botao ficava escondido e o chat parava calado.
    expect(mostrarIrPraoFim(false, 40, 45)).toBe(true);
  });

  it('rolou mais de uma tela: continua aparecendo mesmo sem evento novo', () => {
    expect(mostrarIrPraoFim(true, 45, 45)).toBe(true);
  });

  it('colado no fim e em dia: nao aparece', () => {
    expect(mostrarIrPraoFim(false, 45, 45)).toBe(false);
    expect(mostrarIrPraoFim(false, 0, 0)).toBe(false);
  });
});

describe('precisaPreencher', () => {
  it('lista que nao rola e tem historico acima: precisa revelar', () => {
    // O caso real: 120 eventos crus viraram ~20 linhas (rajada de tool calls colapsada em grupo),
    // scrollHeight == clientHeight -> nenhum `onscroll` nunca -> paginacao pra cima nunca dispara.
    expect(precisaPreencher(800, 800, true)).toBe(true);
  });

  it('rolagem menor que a folga de 64px conta como "nao rola"', () => {
    expect(precisaPreencher(840, 800, true)).toBe(true);
    expect(precisaPreencher(880, 800, true)).toBe(false);
  });

  it('sem historico acima nao revela nada (nao ha o que paginar)', () => {
    expect(precisaPreencher(800, 800, false)).toBe(false);
  });
});
