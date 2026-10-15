// Ponte do app com a página do agente no iframe isolado: tema e, na cópia em tela cheia, zoom e Esc.
import { pageZoomKey, themeVariables, type PageZoomAction } from '@hangar/core';

export type Scheme = 'dark' | 'light';

// Nome da variável na página → token do app.
const MAP: Record<string, string> = {
  '--foreground': '--text-primary', '--muted-foreground': '--text-muted', '--surface': '--bg-surface',
  '--border': '--border-default', '--accent': '--accent', '--accent-foreground': '--text-inverse',
  '--danger': '--error', '--warning': '--warning', '--success': '--success', '--code-background': '--bg-base',
  '--chart-1': '--chart-1', '--chart-2': '--chart-2', '--chart-3': '--chart-3', '--chart-4': '--chart-4',
  '--font-sans': '--font-ui', '--font-mono': '--font-mono',
};

export function readScheme(): Scheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function pageVariables(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  return themeVariables((name) => cs.getPropertyValue(MAP[name] ?? name));
}


export function postTheme(frame: HTMLIFrameElement | undefined, scheme: Scheme, vars: Record<string, string>): void {
  frame?.contentWindow?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { theme: scheme, styles: { variables: vars } } }, '*');
}

// O iframe em origem opaca segura roda e teclado: sem isto Ctrl+roda dentro da página faria o zoom do navegador no
// app inteiro, e Esc não fecharia o diálogo. Vai só na cópia da tela cheia.
const ZOOM_BRIDGE = '<script id="hangar-zoom">(()=>{const s=m=>parent.postMessage(m,"*");'
  + 'addEventListener("wheel",e=>{if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();'
  + 's({method:"hangar/zoom-wheel",params:{deltaY:e.deltaY}})},{passive:false});'
  + 'addEventListener("keydown",e=>{if(e.key==="Escape"){s({method:"hangar/escape"});return}'
  + 'if(!(e.ctrlKey||e.metaKey)||e.altKey)return;if(["=","+","-","_","0"].includes(e.key)){e.preventDefault();'
  + 's({method:"hangar/zoom-key",params:{key:e.key}})}},true)})()</script>';

// Antes da ponte do servidor, que está no <head> real: antes do doctype a página cairia em modo quirks.
export function withZoomBridge(html: string): string {
  const at = html.indexOf('<script id="hangar-host">');
  return at < 0 ? html : html.slice(0, at) + ZOOM_BRIDGE + html.slice(at);
}

export type FullscreenMessage = { kind: 'wheel'; deltaY: number } | { kind: 'key'; action: PageZoomAction } | { kind: 'escape' };

export function readFullscreenMessage(d: unknown): FullscreenMessage | null {
  if (!d || typeof d !== 'object') return null;
  const { method, params } = d as { method?: unknown; params?: { deltaY?: unknown; key?: unknown } };
  if (method === 'hangar/escape') return { kind: 'escape' };
  const delta = params?.deltaY;
  if (method === 'hangar/zoom-wheel' && typeof delta === 'number' && Number.isFinite(delta)) return { kind: 'wheel', deltaY: delta };
  if (method === 'hangar/zoom-key' && typeof params?.key === 'string') {
    const action = pageZoomKey({ key: params.key, ctrlKey: true, metaKey: false });
    return action ? { kind: 'key', action } : null;
  }
  return null;
}
