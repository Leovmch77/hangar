// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { comTeto, novaChaveIdempotente } from './credenciais';
import { listarCredenciais, credentialAuth } from './credenciais';
import { listarCredenciais as coreListar, credentialAuth as coreAuth } from '@hangar/core';

it('reexporta o cliente e a classificação do core', () => {
  expect(listarCredenciais).toBe(coreListar);
  expect(credentialAuth).toBe(coreAuth);
});

const originalAny = AbortSignal.any;

afterEach(() => {
  AbortSignal.any = originalAny;
  vi.useRealTimers();
});

describe('comTeto', () => {
  it('sem AbortSignal.any (Safari < 17.4) ainda aborta pelo teto de tempo', async () => {
    // @ts-expect-error simula navegador antigo
    AbortSignal.any = undefined;
    const sinal = comTeto(new AbortController().signal, 30);
    expect(sinal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 80));  // AbortSignal.timeout do happy-dom não obedece fake timers
    expect(sinal.aborted).toBe(true);
  });

  it('sem AbortSignal.any ainda aborta pelo sinal do chamador', () => {
    // @ts-expect-error simula navegador antigo
    AbortSignal.any = undefined;
    const controle = new AbortController();
    const sinal = comTeto(controle.signal, 8000);
    controle.abort('trocou de servidor');
    expect(sinal.aborted).toBe(true);
    expect(sinal.reason).toBe('trocou de servidor');
  });

  it('sem sinal do chamador devolve só o teto', () => {
    expect(comTeto(undefined, 8000)).toBeInstanceOf(AbortSignal);
  });
});

describe('novaChaveIdempotente', () => {
  it('continua gerando UUID v4 quando randomUUID não existe no HTTP da LAN', () => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return bytes;
      },
    });
    try {
      expect(novaChaveIdempotente()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    } finally {
      vi.stubGlobal('crypto', original);
    }
  });
});
