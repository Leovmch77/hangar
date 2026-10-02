import { Directory, File, Paths } from 'expo-file-system';
import { effectUsesLight, type BackgroundEffect } from '@hangar/core';
import { useAparencia } from '../../stores/aparencia';
import { toast } from '../../ui/Toast';
import * as m from '../../paraglide/messages';
import { effectSourceOk } from './effectWorkerHtml';

// O trabalho pesado roda na WebView do EffectWorker (decodificação nativa, JS com JIT, PNG nativo);
// aqui só se lê o arquivo, se fala com ela e se grava o resultado. Um pedido por vez: o novo
// substitui o anterior, que é descartado dos dois lados.

const TIMEOUT_MS = 60_000;
type Reply = { id: number; png?: string; error?: string; ms?: Record<string, number>; colorSpace?: string; source?: string };
let post: ((msg: string) => void) | null = null;
let job: { id: number; msg: string; resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
let seq = 0;

function settle(fail?: Error, reply?: Reply) {
  const j = job;
  if (!j) return;
  job = null;
  clearTimeout(j.timer);
  if (fail) j.reject(fail);
  else j.resolve(reply!);
}

export function attachWorker(p: (msg: string) => void) {
  post = p;
  if (job) p(job.msg);
}
export function detachWorker() { post = null; }
export function workerFailed(why: string) { settle(new Error(`worker:${why}`)); }
export function workerMessage(data: string) {
  let r: Reply;
  try { r = JSON.parse(data); } catch { return; }
  if (!job || r.id !== job.id) return;
  if (r.error || !r.png) settle(new Error(`decode:${r.error ?? 'empty'}`));
  else settle(undefined, r);
}

function requestRender(data: string, mime: string, effect: BackgroundEffect, light: boolean): Promise<Reply> {
  settle(new Error('superseded'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const msg = JSON.stringify({ type: 'render', id, mime, data, effect, light });
    const timer = setTimeout(() => { if (job?.id === id) settle(new Error('worker:timeout')); }, TIMEOUT_MS);
    job = { id, msg, resolve, reject, timer };
    post?.(msg);
  });
}

// O data URL precisa do tipo certo; o resto (HEIC, WebP…) fica a cargo do que o WebKit souber abrir.
function mimeOf(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/heic';
}

const cacheDir = () => new Directory(Paths.cache, 'wallpaper-effects');
// Muda quando a saída muda (v2: foto P3 processada em P3): as variantes antigas saem pela poda.
const CACHE_VERSION = 'v2';

/** Variante com efeito no cache (as da foto atual, como o CACHE de effects.rs); a de outras fotos sai. */
async function render(source: string, effect: BackgroundEffect, light: boolean): Promise<string> {
  if (!effectSourceOk) throw new Error('worker-no-source');
  const base = `${(source.split('/').pop() ?? 'wallpaper').replace(/\.[^.]*$/, '')}-${CACHE_VERSION}-`;
  const dir = cacheDir();
  dir.create({ idempotent: true, intermediates: true });
  const target = new File(dir, `${base}${effect}-${light ? 'light' : 'dark'}.png`);
  if (target.exists) return target.uri;
  for (const old of dir.list()) if (!old.name.startsWith(base)) old.delete();
  const input = new File(source);
  if (!input.exists) throw new Error('missing');
  const data = await input.base64();
  const reply = await requestRender(data, mimeOf(data), effect, light);
  // Foto P3 que saiu em sRGB (canvas P3 indisponível ou PNG sem perfil) perde o gamut: fica no log.
  if (reply.source !== reply.colorSpace) console.warn('background-effect-colorspace', { space: reply.colorSpace, source: reply.source });
  if (__DEV__) console.log('background-effect-ready', { effect, space: reply.colorSpace, ms: reply.ms });
  target.write(reply.png!, { encoding: 'base64' });
  return target.uri;
}

let ticket = 0;
let pending: string | null = null;

/**
 * Deixa pronta a variante pedida. Cada Screen tem um Background e todos chamam: o mesmo pedido em
 * andamento não recomeça; trocar de efeito (ou ir para `none`) cancela o anterior. Falha volta o
 * efeito para `none` e avisa.
 */
export async function syncBackgroundEffect(source: string | null, effect: BackgroundEffect, dark: boolean) {
  const set = useAparencia.setState;
  if (!source || effect === 'none') {
    ticket++; pending = null;
    settle(new Error('superseded'));
    if (useAparencia.getState().efeitoProcessando) set({ efeitoProcessando: false });
    return;
  }
  const claro = effectUsesLight(effect, !dark);
  const key = `${source}|${effect}|${claro}`;
  const ready = useAparencia.getState().efeitoImagem;
  if (key === pending || (ready && ready.fonte === source && ready.efeito === effect && ready.claro === claro)) return;
  const id = ++ticket;
  pending = key;
  set({ efeitoProcessando: true });
  try {
    const uri = await render(source, effect, claro);
    if (id === ticket) set({ efeitoImagem: { fonte: source, efeito: effect, claro, uri }, efeitoProcessando: false });
  } catch (e) {
    if (id !== ticket) return;
    console.warn('background-effect-failed', { effect, source }, e);
    set({ efeitoProcessando: false });
    useAparencia.getState().setEfeito('none');
    const code = e instanceof Error ? e.message : '';
    const reason = code === 'missing' ? m.native_backdrop_missing()
      : code.startsWith('worker:') ? m.aparencia_efeito_webview() : m.aparencia_efeito_ilegivel();
    toast.erro(m.aparencia_efeito_erro({ reason }));
  } finally {
    if (pending === key) pending = null;
  }
}

/** A variante pronta não abriu: apaga, volta para sem efeito e avisa (escolher de novo refaz). */
export function failBackgroundEffect(uri: string, error: unknown) {
  console.warn('background-effect-variant-unreadable', uri, error);
  const file = new File(uri);
  if (file.exists) file.delete();
  useAparencia.setState({ efeitoImagem: null });
  useAparencia.getState().setEfeito('none');
  toast.erro(m.aparencia_efeito_erro({ reason: m.aparencia_efeito_ilegivel() }));
}
