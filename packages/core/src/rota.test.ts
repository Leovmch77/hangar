import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { configureApi, _resetApiEnvForTests } from './apiEnv';
import { hmacSha256Hex } from './hmac';
import { baseOf, decidirRota, esquecerRota, _resetRotasForTests } from './rota';
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
