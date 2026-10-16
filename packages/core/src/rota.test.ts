import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { configureApi, _resetApiEnvForTests } from './apiEnv';
import { hmacSha256Hex } from './hmac';
import { baseOf, decidirRota, esquecerRota, verifyServerIdentity, _resetRotasForTests } from './rota';
import type { LanInfo, Server } from './servers';

const TS = 'https://maq.tail.ts.net';
const LAN = 'http://192.168.77.142:8765';

function env(origin: string | null, lembrados: Record<string, LanInfo> = {}) {
  configureApi({
    getBaseUrl: () => '', getToken: () => null, onUnauthorized: () => {}, origin,
    createEventSource: () => { throw new Error('sem SSE'); },
    rememberLan: (id, lan) => { lembrados[id] = lan; },
  });
  return lembrados;
}

// Cada endereço é uma máquina com nome, token e atraso em ms (ou nada no ar, com `null`).
type Maquina = { identificador: string; token: string; lan_url?: string; atraso?: number } | null;
function rede(maquinas: Record<string, Maquina>) {
  const chamadas: { url: string; auth: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    chamadas.push({ url, auth });
    const u = new URL(url);
    const m = maquinas[u.origin];
    if (!m) throw new TypeError('rede');
    await new Promise((r) => setTimeout(r, m.atraso ?? 0));
    if (u.pathname === '/api/peers/prova') {
      const d = u.searchParams.get('desafio')!;
      const prova = createHmac('sha256', m.token).update(`${d}|${m.identificador}`).digest('hex');
      return new Response(JSON.stringify({ identificador: m.identificador, prova }));
    }
    if (auth !== `Bearer ${m.token}`) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ identificador: m.identificador, lan_url: m.lan_url ?? '' }));
  }));
  return chamadas;
}

const srv = (lan?: LanInfo): Server => ({ id: 's1', label: 'maq', baseUrl: TS, token: 't', lan });
// O Tailscale leva 100 ms; a rede local de verdade responde na hora.
const maq = { identificador: 'maq', token: 't', lan_url: LAN, atraso: 100 };
const maqLocal = { ...maq, atraso: 0 };

beforeEach(() => { _resetRotasForTests(); _resetApiEnvForTests(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('verifyServerIdentity', () => {
  it('aceita a prova HMAC do destino exato sem transmitir o token', async () => {
    env(null);
    const chamadas = rede({ [LAN]: maqLocal });
    const signal = new AbortController().signal;

    expect(await verifyServerIdentity(srv({ url: 'http://cached.test', id: 'cached' }), { url: LAN, id: 'maq' }, signal)).toBe(true);

    expect(chamadas).toHaveLength(1);
    const url = new URL(chamadas[0].url);
    expect(url.origin).toBe(LAN);
    expect(url.pathname).toBe('/api/peers/prova');
    expect([...url.searchParams.keys()]).toEqual(['desafio']);
    expect(url.searchParams.get('desafio')).toMatch(/^[a-f0-9]{32}$/);
    expect(chamadas[0].auth).toBeNull();
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.signal).toBe(signal);
    expect(init?.credentials).toBe('omit');
    expect(init?.body).toBeUndefined();
  });

  it.each([
    { name: 'identificador-diferente', identificador: 'other', token: 't' },
    { name: 'mesmo-identificador-hmac-falso', identificador: 'maq', token: 'wrong' },
  ])('recusa $name sem tentar autenticação', async ({ identificador, token }) => {
    env(null);
    const chamadas = rede({ [LAN]: { identificador, token } });

    expect(await verifyServerIdentity(srv(), { url: LAN, id: 'maq' })).toBe(false);
    expect(chamadas).toHaveLength(1);
    expect(chamadas.every((call) => call.auth === null)).toBe(true);
  });

  it.each(['rede', 'http', 'json'])('recusa falha de %s sem alternativa autenticada', async (failure) => {
    env(null);
    const fetch = vi.fn(async () => {
      if (failure === 'rede') throw new TypeError('offline');
      return failure === 'http' ? new Response('{}', { status: 503 }) : new Response('invalid-json');
    });
    vi.stubGlobal('fetch', fetch);

    expect(await verifyServerIdentity(srv(), { url: LAN, id: 'maq' })).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });

  it('mantém o prazo LAN padrão quando não recebe sinal', async () => {
    env(null);
    rede({ [LAN]: maqLocal });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(await verifyServerIdentity(srv(), { url: LAN, id: 'maq' })).toBe(true);
      expect(timeout).toHaveBeenCalledWith(800);
    } finally { timeout.mockRestore(); }
  });
});

describe('rota até o servidor', () => {
  it('primeira vez: aprende o endereço local pelo principal e já nasce nele', async () => {
    const lembrados = env(null);
    rede({ [TS]: maq, [LAN]: maqLocal });
    await decidirRota(srv());
    expect(baseOf(srv())).toBe(LAN);
    expect(lembrados.s1).toEqual({ url: LAN, id: 'maq' });
  });

  it('o token nunca vai pro endereço local antes da prova', async () => {
    env(null);
    const chamadas = rede({ [TS]: maq, [LAN]: maqLocal });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(chamadas.filter((c) => c.url.startsWith(LAN)).every((c) => c.auth === null)).toBe(true);
  });

  it('outra máquina no mesmo IP, mesmo dizendo o nome certo, não prova o token: fica no principal', async () => {
    env(null);
    rede({ [TS]: maq, [LAN]: { identificador: 'maq', token: 'outro' } });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(TS);
  });

  it('fora da rede local cai no principal; depois da falha decide de novo', async () => {
    env(null);
    rede({ [TS]: maq });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(TS);
    rede({ [TS]: maq, [LAN]: maqLocal });
    esquecerRota('s1');
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(LAN);
  });

  it('mesmo IP alcançado por VPN, mais lento que o Tailscale: fica no principal', async () => {
    env(null);
    rede({ [TS]: maq, [LAN]: { ...maq, atraso: 250 } });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(TS);
    esquecerRota('s1');
    _resetRotasForTests();
    await decidirRota(srv());
    expect(baseOf(srv())).toBe(TS);
  });

  it('página HTTPS nem tenta o http:// local (o navegador bloquearia)', async () => {
    env('https://pocket.exemplo');
    const chamadas = rede({ [TS]: maq, [LAN]: maqLocal });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(TS);
    expect(chamadas.some((c) => c.url.startsWith(LAN))).toBe(false);
  });

  it('HMAC confere com o do Node', () => {
    expect(hmacSha256Hex('k'.repeat(70), 'x|maq')).toBe(createHmac('sha256', 'k'.repeat(70)).update('x|maq').digest('hex'));
  });
});
