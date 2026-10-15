import { describe, expect, it, vi } from 'vitest';
import { postTheme, readFullscreenMessage, withZoomBridge } from './pageHost';

const DOC = '<!doctype html><html><head><style id="hangar-theme" data-base=":root{--radius:10px}">velho</style>'
  + '<script id="hangar-host">/*ponte*/</script></head><body>x</body></html>';

describe('pageHost', () => {
  it('a ponte de zoom entra antes da ponte do servidor, e só se ela existir', () => {
    const out = withZoomBridge(DOC);
    expect(out.indexOf('id="hangar-zoom"')).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf('id="hangar-zoom"')).toBeLessThan(out.indexOf('id="hangar-host"'));
    expect(withZoomBridge('<p>sem ponte</p>')).toBe('<p>sem ponte</p>');
  });

  it('mensagens da cópia em tela cheia: só as três, com dados válidos', () => {
    expect(readFullscreenMessage({ method: 'hangar/escape' })).toEqual({ kind: 'escape' });
    expect(readFullscreenMessage({ method: 'hangar/zoom-wheel', params: { deltaY: -60 } })).toEqual({ kind: 'wheel', deltaY: -60 });
    expect(readFullscreenMessage({ method: 'hangar/zoom-wheel', params: { deltaY: 'x' } })).toBeNull();
    expect(readFullscreenMessage({ method: 'hangar/zoom-key', params: { key: '=' } })).toEqual({ kind: 'key', action: 'in' });
    expect(readFullscreenMessage({ method: 'hangar/zoom-key', params: { key: 'a' } })).toBeNull();
    expect(readFullscreenMessage({ method: 'ui/open-link', params: { url: 'https://a.dev' } })).toBeNull();
    expect(readFullscreenMessage('texto')).toBeNull();
  });

  it('tema ao vivo vai como host-context-changed', () => {
    const postMessage = vi.fn();
    postTheme({ contentWindow: { postMessage } } as unknown as HTMLIFrameElement, 'dark', { '--accent': '#f00' });
    expect(postMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark', styles: { variables: { '--accent': '#f00' } } } }, '*');
    expect(() => postTheme(undefined, 'dark', {})).not.toThrow();
  });
});
