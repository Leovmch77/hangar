// Cliente do desenho de Mermaid do servidor (`POST /api/mermaid`), compartilhado pela PWA e pelo app.
// Um pedido por vez: o Chromium do servidor atende dois ao mesmo tempo e é dividido com o
// `html_render`, então uma conversa com dez diagramas não pode ocupá-lo inteiro.
import { isTimeoutError, requestMermaid } from './api';
import { codePointLength } from './contextRefs';
import type { Server } from './servers';
import * as m from './paraglide/messages';

export type MermaidTheme = 'dark' | 'light';

export interface MermaidImage {
  kind: 'image';
  png: Uint8Array;
  /** Tamanho de exibição em px CSS (o PNG tem o dobro). */
  width: number;
  height: number;
}

/**
 * Só `unavailable` (503, rede, prazo) vale tentar de novo. `invalid` é o erro do parser (422);
 * `too_long` nem vai ao servidor; `rejected` é uma recusa definitiva (400, 401, 410, outro erro
 * HTTP); `not_offered` é a rota que não existe para quem pede (404, convidado): fica só o código.
 */
export type MermaidFailureKind = 'invalid' | 'unavailable' | 'too_long' | 'rejected' | 'not_offered';

export interface MermaidFailure {
  kind: MermaidFailureKind;
  message: string;
  /** Código estável: o do servidor, `http_<status>`, `rede` ou `timeout`. Nunca vai cru à tela. */
  code: string;
}

export type MermaidResult = MermaidImage | MermaidFailure;

/** O servidor desenha sempre na largura máxima e a tela reduz: é a largura que todo pedido leva. */
export const MERMAID_MAX_WIDTH = 1600;
export const MERMAID_MAX_SOURCE = 50000;
const CACHE_MAX = 64;
const TIMEOUT_MS = 30_000;

/**
 * Fonte acima do teto: a tela avisa sem pedir ao servidor. O teto conta caracteres (o servidor em
 * Rust conta `char`); até o teto em unidades UTF-16 nem precisa contar.
 */
export function mermaidSourceTooLong(source: string): boolean {
  return source.length > MERMAID_MAX_SOURCE && codePointLength(source) > MERMAID_MAX_SOURCE;
}

// Promessa por chave: dois blocos iguais na tela esperam o mesmo pedido. Só fica o que é
// definitivo; indisponível sai para a próxima tentativa ir ao servidor.
const cache = new Map<string, Promise<MermaidResult>>();
let tail: Promise<unknown> = Promise.resolve();

// O servidor entra na chave: uma recusa (401, 410) é de um servidor, não do diagrama.
function cacheKey(source: string, theme: MermaidTheme, server?: Server | null): string {
  return `${server?.id ?? ''}\0${theme}\0${source}`;
}

/** Largura e altura do PNG (cabeçalho IHDR), para quando os cabeçalhos de tamanho não chegam. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return null;
  const at = (i: number) => ((png[i] << 24) | (png[i + 1] << 16) | (png[i + 2] << 8) | png[i + 3]) >>> 0;
  return { width: at(16), height: at(20) };
}

async function failureFrom(res: Response): Promise<MermaidFailure> {
  let code = '';
  let message = '';
  try {
    const j = await res.json() as { code?: unknown; message?: unknown; detail?: unknown };
    const env = (j && typeof j.detail === 'object' && j.detail) ? j.detail as typeof j : j;
    if (typeof env?.code === 'string') code = env.code;
    if (typeof env?.message === 'string') message = env.message;
    else if (typeof j?.detail === 'string') message = j.detail;
  } catch { /* corpo não-JSON: fica o status */ }
  const status = res.status;
  if (status === 422) return { kind: 'invalid', code: code || 'mermaid_invalido', message };
  if (status === 503) return { kind: 'unavailable', code: code || 'mermaid_indisponivel', message };
  if (status === 404 || status === 403) return { kind: 'not_offered', code: code || `http_${status}`, message: '' };
  return { kind: 'rejected', code: `http_${status}`, message: '' };
}

async function fetchOnce(source: string, theme: MermaidTheme, server?: Server | null): Promise<MermaidResult> {
  let res: Response;
  try {
    res = await requestMermaid({ source, theme, width: MERMAID_MAX_WIDTH }, server, AbortSignal.timeout(TIMEOUT_MS));
  } catch (e) {
    // Recusa local do `apiFetchRes`: convite fora da rota e servidor removido. O resto é rede ou prazo.
    const local = (e as { status?: unknown } | null)?.status;
    if (local === 403) return { kind: 'not_offered', code: 'erro_fora_do_convite', message: '' };
    if (local === 410) return { kind: 'rejected', code: 'http_410', message: '' };
    return { kind: 'unavailable', code: isTimeoutError(e) ? 'timeout' : 'rede', message: '' };
  }
  if (!res.ok) return failureFrom(res);
  const png = new Uint8Array(await res.arrayBuffer());
  const w = Number(res.headers.get('x-hangar-css-width'));
  const h = Number(res.headers.get('x-hangar-css-height'));
  if (w > 0 && h > 0) return { kind: 'image', png, width: w, height: h };
  // Cabeçalho ausente (CORS sem expor, proxy no meio): o PNG sai em escala 2.
  const size = pngSize(png);
  return size
    ? { kind: 'image', png, width: Math.round(size.width / 2), height: Math.round(size.height / 2) }
    : { kind: 'rejected', code: 'png_invalido', message: '' };
}

/**
 * Linha que a tela mostra no lugar do diagrama, ou `null` quando fica só o código (rota que não
 * existe para quem pede). Nunca o código cru.
 */
export function mermaidFailureText(f: MermaidFailure): string | null {
  switch (f.kind) {
    case 'not_offered':
      return null;
    case 'too_long':
      return m.mermaid_too_long();
    case 'invalid':
      return f.message ? m.mermaid_error({ message: f.message }) : m.mermaid_failed();
    case 'unavailable':
      if (f.code === 'timeout') return m.mermaid_timeout();
      if (f.code === 'rede') return m.mermaid_offline();
      return f.message ? m.mermaid_error({ message: f.message }) : m.mermaid_unavailable();
    case 'rejected':
      if (f.code === 'http_400') return m.mermaid_bad_request();
      if (f.code === 'http_401') return m.mermaid_unauthorized();
      if (f.code === 'http_410') return m.mermaid_gone();
      return m.mermaid_failed();
  }
}

/**
 * Desenha `source` no tema pedido, sempre na largura máxima (a tela reduz). Nunca rejeita: falha
 * vira `MermaidFailure`. `retry` descarta um resultado guardado (o botão "Tentar de novo" de um
 * indisponível).
 */
export function renderMermaid(
  source: string,
  theme: MermaidTheme,
  server?: Server | null,
  retry = false,
): Promise<MermaidResult> {
  const key = cacheKey(source, theme, server);
  if (!source.trim()) return Promise.resolve({ kind: 'not_offered', code: 'fonte_vazia', message: '' });
  if (mermaidSourceTooLong(source)) return Promise.resolve({ kind: 'too_long', code: 'fonte_longa', message: '' });
  const hit = cache.get(key);
  if (hit && !retry) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const run = tail.then(() => fetchOnce(source, theme, server));
  tail = run.catch(() => undefined);
  const p = run.then((r) => {
    if (r.kind === 'unavailable' && cache.get(key) === p) cache.delete(key);
    return r;
  }, (e: unknown): MermaidResult => {
    if (cache.get(key) === p) cache.delete(key);
    return { kind: 'unavailable', code: isTimeoutError(e) ? 'timeout' : 'rede', message: '' };
  });
  cache.set(key, p);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

/** Só para testes. */
export function _resetMermaidForTests(): void {
  cache.clear();
  tail = Promise.resolve();
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `data:image/png;base64,…` sem depender de `btoa` (o app nativo não garante). */
export function pngDataUri(png: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < png.length; i += 3) {
    const n = (png[i] << 16) | (png[i + 1] << 8) | png[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < png.length) {
    const n = (png[i] << 16) | ((png[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < png.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return `data:image/png;base64,${out}`;
}

export type MarkdownPart = { markdown: string } | { mermaid: string };

/**
 * Parte o markdown nos blocos ```mermaid, para quem desenha markdown sem poder interceptar um bloco
 * pela linguagem (o app). Cercas de outra linguagem são puladas inteiras: um ```mermaid escrito
 * dentro de um exemplo em ```md continua texto.
 */
export function splitMermaidBlocks(markdown: string): MarkdownPart[] {
  if (!/mermaid/i.test(markdown)) return [{ markdown }];
  const lines = markdown.split('\n');
  const parts: MarkdownPart[] = [];
  let buf: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
    if (!open) { buf.push(lines[i]); i++; continue; }
    const fence = open[1];
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    if (open[2].toLowerCase() === 'mermaid' && j < lines.length) {
      if (buf.length) parts.push({ markdown: buf.join('\n') });
      buf = [];
      parts.push({ mermaid: lines.slice(i + 1, j).join('\n') });
    } else {
      buf.push(...lines.slice(i, Math.min(j + 1, lines.length)));
    }
    i = j + 1;
  }
  if (buf.length) parts.push({ markdown: buf.join('\n') });
  return parts.filter((p) => !('markdown' in p) || p.markdown.trim() !== '');
}
