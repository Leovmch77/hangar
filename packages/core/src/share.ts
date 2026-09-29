// Compartilhar sessão: o link do convite, o resgate e a lista de rotas que um servidor de convite
// atende fora das rotas da sessão. O backend do dono tem a MESMA lista — as duas mudam juntas.
import * as m from './paraglide/messages';

export interface ShareInfo {
  id: string;
  device: string | null;
  created_at: number;
  redeemed_at: number | null;
  expires_at: number;
  pending: boolean;
}
export interface ShareCreated { id: string; link: string; expires_at: number }
export interface InviteRedeemResult { token: string; session: string; owner: string; address: string }
// `unavailable`: a máquina do dono respondeu 503 (túnel fora do ar) e o código NÃO foi gasto —
// tentar de novo é válido, ao contrário de used/expired/revoked.
export type InviteFailure = 'used' | 'expired' | 'revoked' | 'unknown' | 'network' | 'unavailable';

function failureMessage(reason: InviteFailure): string {
  switch (reason) {
    case 'used': return m.erro_convite_usado();
    case 'expired': return m.erro_convite_vencido();
    case 'revoked': return m.erro_convite_revogado();
    case 'network': return m.convite_erro_rede();
    case 'unavailable': return m.erro_sessao_indisponivel();
    default: return m.erro_convite_inexistente();
  }
}

export class InviteRedeemError extends Error {
  readonly reason: InviteFailure;
  constructor(reason: InviteFailure) {
    super(failureMessage(reason));
    this.reason = reason;
  }
}

// O que falta para o dono compartilhar (`GET /api/share/prereqs`); `enable_url` só vem com `funnel` faltando.
export interface SharePrereqs { missing: string[]; fix: string; enable_url: string | null }

// O link vem do servidor e vira `href`: um `javascript:` de um peer comprometido rodaria na origem
// que guarda o token de todos os servidores. Só a página do Tailscale passa.
export function tailscaleEnableUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://login.tailscale.com/') ? value : null;
}

export class SharePrerequisiteError extends Error {
  readonly missing: string[];
  readonly fix: string;
  readonly enableUrl: string | null;
  constructor(missing: string[], fix: string, message: string, enableUrl: string | null = null) {
    super(message);
    this.missing = missing;
    this.fix = fix;
    this.enableUrl = enableUrl;
  }
}

// Espelho de `_GLOBAL_ROUTES`/`_GLOBAL_PREFIXES` em backend/app/share_gate.py. `/api/config`
// fica de fora de propósito: o `getConfig()` do Chat já tem `.catch(() => {})` e cai no padrão.
export const INVITE_GLOBAL_PATHS: readonly string[] = [
  '/api/model-options', '/api/engines', '/api/harness/codex/opcoes',
  '/api/ditado/relimpar', '/api/pensamento/pt', '/api/tts', '/api/tts/narrar',
];
export const INVITE_GLOBAL_PREFIXES: readonly string[] = ['/api/tts/audio/'];

export function inviteAllows(path: string): boolean {
  const p = path.split('?')[0];
  return p === '/api/sessions' || p.startsWith('/api/sessions/') || p.startsWith('/api/guest/')
    || INVITE_GLOBAL_PATHS.includes(p) || INVITE_GLOBAL_PREFIXES.some((x) => p.startsWith(x));
}

const HTTP_LINK = /^(https?):\/\/([^/\s?#]+)\/convite\/([A-Za-z0-9_-]+)\/?$/;
const APP_LINK = /^hangar:\/\/convite\/([^/\s?#]+)\/([A-Za-z0-9_-]+)\/?$/;

// Convite pela rede local vem em http://IP-privado:8766; http para qualquer outro host não passa.
function ipPrivado(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseInviteLink(text: string): { address: string; code: string } | null {
  const t = text.trim();
  const web = HTTP_LINK.exec(t);
  const app = web ? null : APP_LINK.exec(t);
  const hostPorta = web?.[2] ?? app?.[1];
  const code = web?.[3] ?? app?.[2];
  if (!hostPorta || !code) return null;
  // O endereço vira baseUrl de servidor: `a@b` (credencial embutida) ou host torto não passam.
  let u: URL;
  try {
    u = new URL(`https://${hostPorta}`);
    if (u.username || u.password || u.pathname !== '/') return null;
  } catch {
    return null;
  }
  const local = ipPrivado(u.hostname);
  if (web?.[1] === 'http' && !local) return null;
  const esquema = web ? web[1] : local ? 'http' : 'https';
  return { address: `${esquema}://${hostPorta}`, code };
}

// Forma mínima do corpo de erro do resgate: envelope `{detail:{params:{reason}}}` ou `{reason}` cru.
interface InviteBody { detail?: InviteBody; reason?: string; params?: { reason?: string } }

const REASONS: Record<string, InviteFailure> = { used: 'used', expired: 'expired', revoked: 'revoked' };

export async function redeemInvite(
  link: string,
  device: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<InviteRedeemResult> {
  const alvo = parseInviteLink(link);
  if (!alvo) throw new InviteRedeemError('unknown');
  let res: Response;
  try {
    res = await fetchImpl(`${alvo.address}/api/guest/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: alvo.code, device }),
      // A primeira conexão pelo Funnel passa dos 8 s padrão quando o túnel está em relay.
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new InviteRedeemError('network');
  }
  if (res.status === 410) {
    const corpo = (await res.json().catch(() => null)) as InviteBody | null;
    const d = (corpo?.detail ?? corpo) as InviteBody | null;
    const reason = d?.params?.reason ?? d?.reason;
    throw new InviteRedeemError((reason && REASONS[reason]) || 'unknown');
  }
  if (res.status === 503) throw new InviteRedeemError('unavailable');
  if (!res.ok) throw new InviteRedeemError('unknown');
  const r = (await res.json()) as InviteRedeemResult;
  // O endereço devolvido vira o servidor que recebe o token: só vale se for o mesmo host do convite.
  const mesmoHost = (() => {
    try { return new URL(r.address).host === new URL(alvo.address).host; } catch { return false; }
  })();
  return { ...r, address: mesmoHost ? r.address : alvo.address };
}
