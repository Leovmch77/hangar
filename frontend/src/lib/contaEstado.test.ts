// @vitest-environment happy-dom
// formatarIntervalo importa lib/auth no module scope (getBaseUrl) — precisa de localStorage.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatarIntervalo, listarCotas, listarEstadosDeConta } from './contaEstado';

describe('servidor de convite', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('cotas e contas nunca saem para um convite, ativo ou explícito', async () => {
    const convite = { id: 'dono', label: 'Convite · J', baseUrl: 'https://d:8443', token: 'g', invite: true };
    localStorage.setItem('cp_servers', JSON.stringify([convite]));
    localStorage.setItem('cp_active', 'dono');
    const fetchSpy = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(listarCotas(null)).rejects.toMatchObject({ code: 'erro_fora_do_convite' });
    await expect(listarCotas(convite)).rejects.toMatchObject({ code: 'erro_fora_do_convite' });
    await expect(listarEstadosDeConta(null)).rejects.toMatchObject({ code: 'erro_fora_do_convite' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('formatarIntervalo', () => {
  it('formata minutos, horas e dias como dado curto (mock: "última leitura há 2 h")', () => {
    expect(formatarIntervalo(30)).toBe('1 min');
    expect(formatarIntervalo(150)).toBe('2 min');
    expect(formatarIntervalo(3600 * 2 + 60)).toBe('2 h');
    expect(formatarIntervalo(86400 * 3)).toBe('3 d');
  });

  it('não estoura em leitura inexistente', () => {
    expect(formatarIntervalo(null)).toBe('—');
    expect(formatarIntervalo(Number.NaN)).toBe('—');
  });
});