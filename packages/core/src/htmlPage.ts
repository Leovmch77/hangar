// Página publicada pelo agente (tool html_render do MCP hangar), desenhada no lugar da chamada.
// `ownTheme`: a página leva as próprias cores e o app não lhe passa o tema.
// `url`: site de verdade (modo URL); não há HTML para buscar, o app abre o endereço.
export type HtmlPageRef = { id: string; title: string; height: number | null; heights: Record<string, number>; ownTheme: boolean; url?: string };
export type PageFetchState = 'loading' | 'ready' | 'error' | 'expired';

const MIN = 80;
const MAX = 2000;
const FALLBACK = 240;
// Claude e o modo código do Codex gravam `mcp__hangar__html_render`; outros clientes MCP separam o
// servidor da tool por `.` ou `/`. Mesma regra do `is_page_call` do nativo.
const NAME = /^(?:mcp__)?hangar(?:__|\.|\/)html_render$/;

export function isHtmlRenderTool(name: string | null | undefined): boolean {
  return !!name && NAME.test(name);
}

type Block = { type?: unknown; text?: unknown } | null;
const joinText = (blocks: Block[]) => blocks.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');

// O resultado vem do agente: só objeto simples e só alturas finitas positivas chegam ao cálculo.
function cleanHeights(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  return out;
}

export function htmlPageFromResult(toolName: string | null | undefined, result: string | null | undefined): HtmlPageRef | null {
  if (!isHtmlRenderTool(toolName) || !result) return null;
  try {
    let data = JSON.parse(result);
    // O resultado de MCP também chega como lista de blocos de conteúdo: junta o texto e lê de novo.
    if (Array.isArray(data)) data = JSON.parse(joinText(data as Block[]));
    // O Codex grava o CallToolResult inteiro: o estruturado vence, senão o texto dos blocos.
    else if (data && Array.isArray(data.content) && !data.hangar_page) {
      data = data.structuredContent?.hangar_page ? data.structuredContent : JSON.parse(joinText(data.content as Block[]));
    }
    const page = data?.hangar_page;
    if (!page || typeof page.id !== 'string' || typeof page.title !== 'string') return null;
    const ref: HtmlPageRef = { id: page.id, title: page.title, height: typeof page.height === 'number' ? page.height : null,
      heights: cleanHeights(page.heights), ownTheme: page.own_theme === true };
    // Só http(s): o app abre esse endereço direto.
    if (typeof page.url === 'string' && /^https?:\/\//i.test(page.url)) ref.url = page.url;
    return ref;
  } catch {
    return null;
  }
}

const clamp = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n)));

export function reservedHeight(ref: HtmlPageRef, width: number): number {
  const ws = Object.keys(ref.heights).map(Number).filter((w) => ref.heights[String(w)] > 0);
  if (!ws.length) return FALLBACK;
  const near = ws.reduce((a, b) => (Math.abs(b - width) < Math.abs(a - width) ? b : a));
  return clamp(ref.heights[String(near)]);
}

export function frameHeight(ref: HtmlPageRef, width: number, reported: number | null): number {
  const natural = reported ?? reservedHeight(ref, width);
  return clamp(ref.height != null ? Math.min(ref.height, natural) : natural);
}

// `code` é o `detail.code` do corpo JSON da resposta: só o servidor de páginas diz `erro_pagina_expirou`;
// um 404 genérico (convidado, rota ausente no Python) é erro, não página vencida.
export function pageFetchState(status: number | 'network', code?: string | null): PageFetchState {
  if (status === 404 && code === 'erro_pagina_expirou') return 'expired';
  if (typeof status === 'number' && status >= 200 && status < 300) return 'ready';
  return 'error';
}

export function pageUrls(base: string, session: string, id: string) {
  const root = `${base}/api/sessions/${encodeURIComponent(session)}/pages/${encodeURIComponent(id)}`;
  return {
    raw: `${root}?raw=1`,
    isolated: root,
    shot: (theme: 'dark' | 'light', width: number) => `${root}/shot?theme=${theme}&width=${Math.round(width)}`,
  };
}

const VARS = ['--foreground', '--muted-foreground', '--surface', '--border', '--accent', '--accent-foreground',
  '--danger', '--warning', '--success', '--code-background', '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--font-sans', '--font-mono'];

// Lê do app (por nome da variável da página) o valor real do tema; vazio fica com o padrão injetado.
export function themeVariables(get: (name: string) => string): Record<string, string> {
  const out: Record<string, string> = { '--background': 'transparent' };
  for (const v of VARS) { const x = get(v).trim(); if (x) out[v] = x; }
  return out;
}

const THEME_BLOCK = /(<style id="hangar-theme" data-base="([^"]*)">)[\s\S]*?(<\/style>)/;

// Troca só o conteúdo do bloco de tema que o servidor injeta; o data-base fica para as trocas seguintes. Uma regra
// para a PWA e o app.
export function themedPageDocument(html: string, scheme: 'dark' | 'light', vars: Record<string, string>): string {
  const css = `:root{color-scheme:${scheme};${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  return html.replace(THEME_BLOCK,
    (_all, open: string, base: string, close: string) => `${open}${css}${base.replaceAll('&quot;', '"')}${close}`);
}

// Tela cheia da página (como o HtmlRenderDialog do T3): zoom de 50% a 200% em degraus de 25%.
export const PAGE_ZOOM_MIN = 0.5;
export const PAGE_ZOOM_MAX = 2;
export const PAGE_ZOOM_STEP = 0.25;
// Roda (px) que vale um degrau: touchpad manda muitos eventos pequenos.
export const PAGE_ZOOM_WHEEL_STEP = 50;
export type PageZoomAction = 'in' | 'out' | 'reset';

export function stepPageZoom(zoom: number, action: PageZoomAction): number {
  if (action === 'reset') return 1;
  const next = zoom + (action === 'in' ? PAGE_ZOOM_STEP : -PAGE_ZOOM_STEP);
  // Arredonda ao degrau: somar 0,25 seguidas vezes não acumula erro de ponto flutuante.
  return Math.min(PAGE_ZOOM_MAX, Math.max(PAGE_ZOOM_MIN, Math.round(next / PAGE_ZOOM_STEP) * PAGE_ZOOM_STEP));
}

export function pageZoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export function pageZoomKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }): PageZoomAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === '=' || e.key === '+') return 'in';
  if (e.key === '-' || e.key === '_') return 'out';
  if (e.key === '0') return 'reset';
  return null;
}

// Convenção do DOM: delta negativo é roda para cima, que amplia, como no navegador.
export function wheelZoom(pending: number, deltaY: number): { action: PageZoomAction | null; pending: number } {
  const total = pending + deltaY;
  if (Math.abs(total) < PAGE_ZOOM_WHEEL_STEP) return { action: null, pending: total };
  return { action: total < 0 ? 'in' : 'out', pending: 0 };
}

// Site (modo URL) só vive no nativo; fora dele o cartão abre o endereço e não há o que ampliar.
export function pageExpandable(ref: HtmlPageRef, state: PageFetchState): boolean {
  return !ref.url && state === 'ready';
}

export type HostMessage = { kind: 'height'; height: number } | { kind: 'link'; url: string };

// Mensagem da página do agente, não confiável: só altura finita positiva e link http(s). Chega como texto
// do WebView do app ou como objeto do postMessage do PWA.
export function parseHostMessage(data: unknown): HostMessage | null {
  let d: unknown = data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return null; }
  }
  if (!d || typeof d !== 'object') return null;
  const { method, params } = d as { method?: unknown; params?: { height?: unknown; url?: unknown } };
  const h = params?.height;
  if (method === 'ui/notifications/size-changed' && typeof h === 'number' && Number.isFinite(h) && h > 0) {
    return { kind: 'height', height: h };
  }
  const url = params?.url;
  if (method === 'ui/open-link' && typeof url === 'string' && /^https?:\/\//i.test(url)) return { kind: 'link', url };
  return null;
}
