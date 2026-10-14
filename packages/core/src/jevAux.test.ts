import { expect, test } from 'vitest';
import { sameJevAuxUrl } from './api';

test('endereço do modelo auxiliar compara sem barra final e sem /chat/completions', () => {
  expect(sameJevAuxUrl('http://127.0.0.1:8317/v1/', 'http://127.0.0.1:8317/v1')).toBe(true);
  expect(sameJevAuxUrl('https://x/v1/chat/completions', ' https://x/v1 ')).toBe(true);
  expect(sameJevAuxUrl('https://x/v1', 'https://y/v1')).toBe(false);
  // Vazio nunca casa: sem endereço salvo, a chave salva não é pedida.
  expect(sameJevAuxUrl('', '')).toBe(false);
  expect(sameJevAuxUrl('https://x/v1', null)).toBe(false);
});
