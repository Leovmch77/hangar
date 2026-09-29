// Rota até cada servidor: o endereço da rede local quando ele responde como a MESMA máquina, senão
// o `baseUrl` (Tailscale). `baseUrl` continua sendo a identidade da entrada; só a rede muda.
import { apiEnv } from './apiEnv';
import { registrar as registrarDiag } from './diag';
import { hmacSha256Hex } from './hmac';
import type { LanInfo, Server } from './servers';

// Rede local responde em poucos ms; fora dela o IP não existe ou é outra máquina.
const PRAZO_LAN_MS = 800;
const PRAZO_PRINCIPAL_MS = 4000;

const rotas = new Map<string, string>();
const emCurso = new Map<string, Promise<void>>();

export function baseOf(s: Server): string {
  return rotas.get(s.id) ?? s.baseUrl;
}

export function rotaDecidida(id: string): boolean {
  return rotas.has(id);
}

/** Falha de conexão: a rede pode ter mudado, a próxima conexão decide de novo. */
export function esquecerRota(id: string): void {
  rotas.delete(id);
}

async function perguntar(base: string, token: string, ms: number): Promise<{ identificador?: string; lan_url?: string } | null> {
  try {
    const r = await fetch(`${base}/api/peers/identificador`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ms),
    });
    return r.ok ? (await r.json()) as { identificador?: string; lan_url?: string } : null;
  } catch {
    return null;
  }
}

// Página HTTPS não pode chamar http:// (o navegador bloqueia): nem tenta.
function lanPermitida(url: string): boolean {
  return !(apiEnv().origin?.startsWith('https:') && url.startsWith('http:'));
}

async function aprender(s: Server): Promise<LanInfo | null> {
  const r = await perguntar(s.baseUrl, s.token, PRAZO_PRINCIPAL_MS);
  if (!r?.identificador) return null;
  const lan = { url: (r.lan_url ?? '').replace(/\/+$/, ''), id: r.identificador };
  if (lan.url !== s.lan?.url || lan.id !== s.lan?.id) apiEnv().rememberLan?.(s.id, lan);
  return lan;
}

function desafio(): string {
  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Mesmo IP em outra rede pode ser outra máquina: o token só vai pro endereço local depois de ele
// provar que conhece o token (HMAC do desafio) e dizer o mesmo nome.
async function testarLan(s: Server, lan: LanInfo | null | undefined): Promise<boolean> {
  if (!lan?.url || !lan.id || !lanPermitida(lan.url)) return false;
  const d = desafio();
  let r: { identificador?: string; prova?: string } | null = null;
  try {
    const res = await fetch(`${lan.url}/api/peers/prova?desafio=${d}`, { signal: AbortSignal.timeout(PRAZO_LAN_MS) });
    r = res.ok ? (await res.json()) as { identificador?: string; prova?: string } : null;
  } catch {
    return false;
  }
  if (r?.identificador !== lan.id || r.prova !== hmacSha256Hex(s.token, `${d}|${lan.id}`)) return false;
  rotas.set(s.id, lan.url);
  return true;
}

async function decidir(s: Server): Promise<void> {
  const anterior = rotas.get(s.id);
  let lan: LanInfo | null | undefined = s.lan;
  // Primeira vez: pergunta pelo principal antes de conectar, pra já nascer na rota local.
  if (lan === undefined) lan = await aprender(s);
  if (!(await testarLan(s, lan))) {
    rotas.set(s.id, s.baseUrl);
    // O IP local pode ter mudado (DHCP) ou o bind ter sido aberto depois: atualiza para a próxima.
    if (s.lan !== undefined) void aprender(s).catch((e: unknown) => registrarDiag({ evento: 'rota.falhou',
      nivel: 'erro', codigo: e instanceof Error ? e.name : 'erro' }, s.baseUrl));
  }
  const agora = rotas.get(s.id)!;
  if (agora !== anterior) {
    registrarDiag({ evento: 'rota.escolhida', detalhe: agora === s.baseUrl ? 'principal' : 'rede_local' }, s.baseUrl);
  }
}

/** Decide a rota de um servidor. Nunca rejeita; chamadas simultâneas dividem a mesma decisão. */
export function decidirRota(s: Server): Promise<void> {
  // Mesma origem ou esta própria máquina já é o caminho mais curto.
  if (s.invite || !s.baseUrl || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(s.baseUrl)) {
    rotas.set(s.id, s.baseUrl);
    return Promise.resolve();
  }
  let p = emCurso.get(s.id);
  if (!p) {
    p = decidir(s).catch((e: unknown) => {
      rotas.set(s.id, s.baseUrl);
      registrarDiag({ evento: 'rota.falhou', nivel: 'erro', codigo: e instanceof Error ? e.name : 'erro' }, s.baseUrl);
    }).finally(() => emCurso.delete(s.id));
    emCurso.set(s.id, p);
  }
  return p;
}

export function _resetRotasForTests(): void {
  rotas.clear();
  emCurso.clear();
}
