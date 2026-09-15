// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bordaDoPonto } from './shellLayout.svelte';

// O arranjo é singleton $state lido no import do módulo — testar a carga exige módulo fresco,
// como o App faz ao recarregar a página.
async function importarFresco() {
  vi.resetModules();
  return await import('./shellLayout.svelte');
}

beforeEach(() => localStorage.clear());

describe('shellLayout — arranjo dos blocos do desktop', () => {
  it('sem nada salvo nasce no arranjo de sempre, um bloco por coluna', async () => {
    const { shellLayout } = await importarFresco();
    expect(shellLayout.colunas).toEqual([['git'], ['chat'], ['ctx']]);
    expect(shellLayout.linhas).toBe(1);
    // A barra lateral ocupa a coluna 1 do grid, então os blocos começam na 2.
    expect(shellLayout.coluna('git')).toBe(2);
    expect(shellLayout.coluna('ctx')).toBe(4);
    expect(shellLayout.linha('git')).toBe('1 / -1');
  });

  it('arranjo salvo incompleto, repetido ou com lixo cai no padrão', async () => {
    const ruins = [
      '[["git"],["chat"]]',              // falta um bloco: ele ficaria sem célula
      '[["git","git"],["chat"],["ctx"]]', // repetido: duas células pro mesmo componente
      '[["git"],[],["chat"],["ctx"]]',    // coluna vazia
      '[["git"],["chat"],["ctx"],["x"]]',
      '[]',
      'não é json',
    ];
    for (const ruim of ruins) {
      localStorage.setItem('cp_shell_arranjo', ruim);
      const { shellLayout } = await importarFresco();
      expect(shellLayout.colunas).toEqual([['git'], ['chat'], ['ctx']]);
    }
  });

  it('soltar na borda lateral vira coluna nova antes ou depois do alvo', async () => {
    const { shellLayout } = await importarFresco();
    shellLayout.soltar('ctx', 'git', 'esquerda');
    expect(shellLayout.colunas).toEqual([['ctx'], ['git'], ['chat']]);
    shellLayout.soltar('ctx', 'chat', 'direita');
    expect(shellLayout.colunas).toEqual([['git'], ['chat'], ['ctx']]);
  });

  it('soltar na borda de cima/baixo empilha na MESMA coluna do alvo', async () => {
    const { shellLayout } = await importarFresco();
    shellLayout.soltar('ctx', 'git', 'baixo');
    expect(shellLayout.colunas).toEqual([['git', 'ctx'], ['chat']]);
    expect(shellLayout.linhas).toBe(2);
    expect(shellLayout.empilhado('git')).toBe(true);
    expect(shellLayout.empilhado('chat')).toBe(false);
    // Empilhados dividem a coluna; sozinho, o bloco pega a coluna inteira.
    expect(shellLayout.linha('git')).toBe('1 / 2');
    expect(shellLayout.linha('ctx')).toBe('2 / 3');
    expect(shellLayout.linha('chat')).toBe('1 / -1');
    expect(shellLayout.coluna('chat')).toBe(3);
  });

  it('a coluna que esvazia some, e o alvo não escorrega junto', async () => {
    const { shellLayout } = await importarFresco();
    // git sai da coluna 1, que fica vazia: o alvo `ctx` era a 3ª e vira a 2ª no meio da conta.
    shellLayout.soltar('git', 'ctx', 'cima');
    expect(shellLayout.colunas).toEqual([['chat'], ['git', 'ctx']]);
  });

  it('soltar em si mesmo não mexe em nada', async () => {
    const { shellLayout } = await importarFresco();
    shellLayout.soltar('git', 'git', 'direita');
    expect(shellLayout.colunas).toEqual([['git'], ['chat'], ['ctx']]);
  });

  it('tirar um bloco da pilha devolve a coluna dele ao vizinho', async () => {
    const { shellLayout } = await importarFresco();
    shellLayout.soltar('ctx', 'git', 'baixo');
    expect(shellLayout.colunas).toEqual([['git', 'ctx'], ['chat']]);
    // Sair da pilha pra uma coluna própria: a de cima fica sozinha de novo.
    shellLayout.soltar('ctx', 'chat', 'direita');
    expect(shellLayout.colunas).toEqual([['git'], ['chat'], ['ctx']]);
    expect(shellLayout.empilhado('git')).toBe(false);
  });

  it('restaurar volta pro padrão, e `mexido` só é verdade fora dele', async () => {
    const { shellLayout } = await importarFresco();
    expect(shellLayout.mexido).toBe(false);
    shellLayout.soltar('ctx', 'git', 'baixo');
    expect(shellLayout.mexido).toBe(true);
    shellLayout.restaurar();
    expect(shellLayout.colunas).toEqual([['git'], ['chat'], ['ctx']]);
    expect(shellLayout.mexido).toBe(false);
  });

  it('vizinho da barra lateral é quem está na primeira coluna', async () => {
    const { shellLayout } = await importarFresco();
    expect(shellLayout.ehVizinhoDaSidebar('git')).toBe(true);
    expect(shellLayout.ehVizinhoDaSidebar('ctx')).toBe(false);
    shellLayout.soltar('ctx', 'git', 'baixo');   // os dois na coluna 1 agora
    expect(shellLayout.ehVizinhoDaSidebar('ctx')).toBe(true);
    expect(shellLayout.ehVizinhoDaSidebar('chat')).toBe(false);
  });

  it('o arranjo persiste e volta no módulo fresco', async () => {
    const { shellLayout } = await importarFresco();
    shellLayout.soltar('ctx', 'git', 'baixo');
    const fresco = await importarFresco();
    expect(fresco.shellLayout.colunas).toEqual([['git', 'ctx'], ['chat']]);
  });
});

describe('bordaDoPonto — qual borda o ponteiro está mirando', () => {
  const r = { left: 100, top: 100, width: 200, height: 200 } as DOMRect;

  it('escolhe o eixo de maior desvio do centro', () => {
    expect(bordaDoPonto(110, 200, r)).toBe('esquerda');
    expect(bordaDoPonto(290, 200, r)).toBe('direita');
    expect(bordaDoPonto(200, 110, r)).toBe('cima');
    expect(bordaDoPonto(200, 290, r)).toBe('baixo');
  });

  it('no centro exato cai na vertical, sem quebrar', () => {
    expect(bordaDoPonto(200, 200, r)).toBe('baixo');
  });

  it('retângulo sem tamanho não divide por zero', () => {
    const zero = { left: 0, top: 0, width: 0, height: 0 } as DOMRect;
    expect(bordaDoPonto(0, 0, zero)).toBe('baixo');
  });
});
