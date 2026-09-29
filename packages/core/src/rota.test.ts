import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureApi, _resetApiEnvForTests } from './apiEnv';
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

// Cada endereço responde um identificador (ou falha, com `null`).
function rede(respostas: Record<string, { identificador: string; lan_url?: string } | null>) {
  const chamadas: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const base = url.replace('/api/peers/identificador', '');
    chamadas.push(base);
    const r = respostas[base];
    if (!r) throw new TypeError('rede');
    return new Response(JSON.stringify(r), { status: 200 });
  }));
  return chamadas;
}

const srv = (lan?: LanInfo): Server => ({ id: 's1', label: 'maq', baseUrl: TS, token: 't', lan });

beforeEach(() => { _resetRotasForTests(); _resetApiEnvForTests(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('rota até o servidor', () => {
  it('primeira vez: aprende o endereço local pelo principal e já nasce nele', async () => {
    const lembrados = env(null);
    rede({ [TS]: { identificador: 'maq', lan_url: LAN }, [LAN]: { identificador: 'maq' } });
    await decidirRota(srv());
    expect(baseOf(srv())).toBe(LAN);
    expect(lembrados.s1).toEqual({ url: LAN, id: 'maq' });
  });

  it('mesmo IP respondendo outro nome é outra máquina: fica no principal', async () => {
    env(null);
    rede({ [TS]: { identificador: 'maq', lan_url: LAN }, [LAN]: { identificador: 'outra' } });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(TS);
  });

  it('fora da rede local cai no principal; depois da falha decide de novo', async () => {
    env(null);
    rede({ [TS]: { identificador: 'maq', lan_url: LAN } });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(TS);
    rede({ [TS]: { identificador: 'maq', lan_url: LAN }, [LAN]: { identificador: 'maq' } });
    esquecerRota('s1');
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(LAN);
  });

  it('página HTTPS nem tenta o http:// local (o navegador bloquearia)', async () => {
    env('https://pocket.exemplo');
    const chamadas = rede({ [TS]: { identificador: 'maq', lan_url: LAN }, [LAN]: { identificador: 'maq' } });
    await decidirRota(srv({ url: LAN, id: 'maq' }));
    expect(baseOf(srv())).toBe(TS);
    expect(chamadas).not.toContain(LAN);
  });
});
