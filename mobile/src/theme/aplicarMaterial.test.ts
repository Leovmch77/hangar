import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: a fábrica do vi.mock sobe pro topo do arquivo e não enxerga const de módulo.
const { updateTheme } = vi.hoisted(() => ({ updateTheme: vi.fn() }));
vi.mock('react-native-unistyles', async (orig) => ({ ...(await orig<object>()), UnistylesRuntime: { updateTheme } }));

import { aplicarMaterial, CONVERSA_PADRAO } from './aplicarMaterial';

describe('aplicarMaterial', () => {
  beforeEach(() => updateTheme.mockClear());

  it('multiplica o texto escolhido pelo usuário pela escala do tablet sem acumular', () => {
    const conversa = { ...CONVERSA_PADRAO, texto: 1.1 };
    const material = { panelAlpha: 0.86, surfaceAlpha: 1, acento: null, conversa };
    aplicarMaterial(material, { escalaTexto: 19 / 17 });
    aplicarMaterial(material, { escalaTexto: 19 / 17 });
    for (const [, update] of updateTheme.mock.calls) {
      const novo = update({});
      expect(novo.conversa.texto).toBeCloseTo(1.2294117647);
      expect(novo.conversa.linha).toBe(1);
      expect(novo.conversa.codigo).toBe(14);
      expect(novo.conversa.coluna).toBe(1);
    }
    expect(conversa.texto).toBe(1.1);
  });

  it('sem escala mantém o texto escolhido pelo usuário', () => {
    aplicarMaterial({ panelAlpha: 0.86, surfaceAlpha: 1, acento: null, conversa: { ...CONVERSA_PADRAO, texto: 1.1 } });
    expect(updateTheme.mock.calls[0][1]({}).conversa.texto).toBe(1.1);
  });

  it('escreve panelAlpha, surfaceAlpha e acento nos dois temas', () => {
    aplicarMaterial({ panelAlpha: 0.5, surfaceAlpha: 0.7, acento: '#ff0000' });
    expect(updateTheme).toHaveBeenCalledTimes(2);
    expect(updateTheme.mock.calls.map((c) => c[0])).toEqual(['light', 'dark']);
    const novo = updateTheme.mock.calls[0][1]({ tokens: { accent: { base: '#000' } }, panelAlpha: 1, surfaceAlpha: 1 });
    expect(novo.panelAlpha).toBe(0.5);
    expect(novo.surfaceAlpha).toBe(0.7);
    expect(novo.tokens.accent.base).toBe('#ff0000');
  });

  it('reduzir transparência cola os dois alphas em 1', () => {
    aplicarMaterial({ panelAlpha: 0.4, surfaceAlpha: 0.3, acento: null }, { reduzir: true });
    const novo = updateTheme.mock.calls[0][1]({ tokens: null, panelAlpha: 0, surfaceAlpha: 0 });
    expect(novo.panelAlpha).toBe(1);
    expect(novo.surfaceAlpha).toBe(1);
  });

  it('sem acento devolve os tokens de fábrica do tema', () => {
    aplicarMaterial({ panelAlpha: 0.86, surfaceAlpha: 1, acento: null });
    const claro = updateTheme.mock.calls[0][1]({ tokens: null, panelAlpha: 0, surfaceAlpha: 0 });
    const escuro = updateTheme.mock.calls[1][1]({ tokens: null, panelAlpha: 0, surfaceAlpha: 0 });
    // cada tema volta ao SEU accent, não ao do outro
    expect(claro.tokens.accent.base).not.toBe(escuro.tokens.accent.base);
  });
});
