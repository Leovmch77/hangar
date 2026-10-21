import { describe, expect, it } from 'vitest';
import { conversationInset } from './conversationColumn';

describe('conversationInset', () => {
  it('mantém a largura inteira no celular', () => {
    expect(conversationInset(390, 1, 16)).toBe(0);
  });

  it('estreita pela largura da área da conversa', () => {
    expect(conversationInset(600, 0.8, 16)).toBeCloseTo(56.8);
  });

  it('limita a leitura quando a área é larga', () => {
    expect(conversationInset(1000, 1, 16, 760)).toBe(104);
  });

  it('não alarga a conversa quando a área já cabe no limite', () => {
    expect(conversationInset(700, 1, 16, 760)).toBe(0);
  });
});
