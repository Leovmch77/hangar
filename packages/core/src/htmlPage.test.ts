import { describe, expect, it } from 'vitest';
import {
  frameHeight, htmlPageFromResult, isHtmlRenderTool, pageExpandable, pageFetchState, pageZoomKey, pageZoomLabel,
  parseHostMessage, reservedHeight, stepPageZoom, themedPageDocument, wheelZoom, PAGE_ZOOM_MAX, PAGE_ZOOM_MIN,
} from './htmlPage';

const ref = { id: 'a1', title: 'T', height: null, heights: { '360': 500, '728': 380, '1000': 360 }, ownTheme: false };

describe('htmlPage', () => {
  it('troca só o bloco de tema e preserva a base', () => {
    const doc = '<html><head><style id="hangar-theme" data-base=":root{--radius:10px}">velho</style></head></html>';
    const out = themedPageDocument(doc, 'light', { '--foreground': '#111' });
    expect(out).toContain(':root{color-scheme:light;--foreground:#111}:root{--radius:10px}');
    expect(out).not.toContain('velho');
  });

  it('reconhece a tool do hangar e só ela', () => {
    expect(isHtmlRenderTool('mcp__hangar__html_render')).toBe(true);
    for (const n of ['hangar__html_render', 'hangar.html_render', 'hangar/html_render', 'mcp__hangar.html_render']) {
      expect(isHtmlRenderTool(n)).toBe(true);
    }
    expect(isHtmlRenderTool('mcp__outro__html_render')).toBe(false);
    expect(isHtmlRenderTool('mcp__xhangar__html_render')).toBe(false);
    expect(isHtmlRenderTool('hangar_html_render')).toBe(false);
    expect(isHtmlRenderTool('Read')).toBe(false);
  });

  it('lê a referência do resultado e ignora rascunho e erro', () => {
    const ok = JSON.stringify({ hangar_page: ref, message: 'x' });
    expect(htmlPageFromResult('mcp__hangar__html_render', ok)?.id).toBe('a1');
    expect(htmlPageFromResult('mcp__hangar__html_render', JSON.stringify({ draft: { id: 'b' } }))).toBeNull();
    expect(htmlPageFromResult('mcp__hangar__html_render', 'erro_pagina_invalida: title')).toBeNull();
    expect(htmlPageFromResult('Read', ok)).toBeNull();
  });

  it('tema próprio só com own_theme true; página antiga segue o tema do app', () => {
    const read = (page: object) => htmlPageFromResult('mcp__hangar__html_render', JSON.stringify({ hangar_page: page }));
    expect(read({ id: 'a', title: 'T' })?.ownTheme).toBe(false);
    expect(read({ id: 'a', title: 'T', own_theme: true })?.ownTheme).toBe(true);
    expect(read({ id: 'a', title: 'T', own_theme: 'sim' })?.ownTheme).toBe(false);
  });

  it('página de site leva a url; endereço que não é http(s) fica de fora', () => {
    const read = (page: object) => htmlPageFromResult('mcp__hangar__html_render', JSON.stringify({ hangar_page: page }));
    expect(read({ id: 'a', title: 'T', height: 640, url: 'http://localhost:3000/cidades' })?.url).toBe('http://localhost:3000/cidades');
    expect(read({ id: 'a', title: 'T' })?.url).toBeUndefined();
    expect(read({ id: 'a', title: 'T', url: 'javascript:alert(1)' })?.url).toBeUndefined();
  });

  it('lê a referência quando o resultado vem como lista de blocos de texto', () => {
    const text = JSON.stringify({ hangar_page: ref, message: 'x' });
    const blocks = JSON.stringify([{ type: 'text', text: text.slice(0, 10) }, { type: 'image' }, { type: 'text', text: text.slice(10) }]);
    expect(htmlPageFromResult('mcp__hangar__html_render', blocks)?.heights['728']).toBe(380);
    expect(htmlPageFromResult('mcp__hangar__html_render', JSON.stringify([{ type: 'text', text: 'erro' }]))).toBeNull();
  });

  it('alturas só de objeto simples e só números finitos positivos', () => {
    const heightsOf = (heights: unknown) =>
      htmlPageFromResult('mcp__hangar__html_render', JSON.stringify({ hangar_page: { id: 'a', title: 'T', heights } }))?.heights;
    expect(heightsOf({ '360': 500, '728': 0, '1000': -3, '1200': '400', '1400': null })).toEqual({ '360': 500 });
    expect(heightsOf([500, 380])).toEqual({});
    expect(heightsOf('500')).toEqual({});
  });

  it('lê o CallToolResult inteiro que o Codex grava, estruturado primeiro', () => {
    const text = JSON.stringify({ hangar_page: ref, message: 'x' });
    const structured = JSON.stringify({ content: [{ type: 'text', text: 'outro' }], structuredContent: { hangar_page: { ...ref, id: 's1' } } });
    expect(htmlPageFromResult('mcp__hangar__html_render', structured)?.id).toBe('s1');
    const onlyText = JSON.stringify({ content: [{ type: 'text', text: text.slice(0, 7) }, { type: 'text', text: text.slice(7) }] });
    expect(htmlPageFromResult('hangar.html_render', onlyText)?.id).toBe('a1');
    expect(htmlPageFromResult('mcp__hangar__html_render', JSON.stringify({ content: [{ type: 'text', text: 'erro' }], isError: true }))).toBeNull();
  });

  it('reserva a altura da largura medida mais próxima', () => {
    expect(reservedHeight(ref, 390)).toBe(500);
    expect(reservedHeight(ref, 700)).toBe(380);
    expect(reservedHeight({ ...ref, heights: {} }, 700)).toBe(240);
  });

  it('altura informada pela página vence, com teto do agente e limites', () => {
    expect(frameHeight(ref, 728, 420)).toBe(420);
    expect(frameHeight({ ...ref, height: 300 }, 728, 420)).toBe(300);
    expect(frameHeight(ref, 728, 5000)).toBe(2000);
    expect(frameHeight(ref, 728, 10)).toBe(80);
    expect(frameHeight(ref, 728, null)).toBe(380);
  });

  it('404 só é expirou com o código do servidor de páginas, rede é erro', () => {
    expect(pageFetchState(200)).toBe('ready');
    expect(pageFetchState(404, 'erro_pagina_expirou')).toBe('expired');
    expect(pageFetchState(404)).toBe('error');
    expect(pageFetchState(404, 'Not Found')).toBe('error');
    expect(pageFetchState(500)).toBe('error');
    expect(pageFetchState('network')).toBe('error');
  });
});

describe('tela cheia da página', () => {
  it('anda em degraus de 25% entre 50% e 200%', () => {
    expect(stepPageZoom(1, 'in')).toBe(1.25);
    expect(stepPageZoom(1, 'out')).toBe(0.75);
    expect(stepPageZoom(PAGE_ZOOM_MAX, 'in')).toBe(PAGE_ZOOM_MAX);
    expect(stepPageZoom(PAGE_ZOOM_MIN, 'out')).toBe(PAGE_ZOOM_MIN);
    expect(stepPageZoom(1.75, 'reset')).toBe(1);
    // Sem erro acumulado: 4 subidas a partir de 1 dão 2 exato.
    let z = 1;
    for (let i = 0; i < 4; i++) z = stepPageZoom(z, 'in');
    expect(z).toBe(2);
  });

  it('rótulo da porcentagem', () => {
    expect(pageZoomLabel(1)).toBe('100%');
    expect(pageZoomLabel(1.25)).toBe('125%');
    expect(pageZoomLabel(0.5)).toBe('50%');
  });

  it('só Ctrl ou Cmd, sem Alt, viram zoom', () => {
    const k = (key: string, ctrlKey = true, metaKey = false, altKey = false) => pageZoomKey({ key, ctrlKey, metaKey, altKey });
    expect(k('=')).toBe('in');
    expect(k('+')).toBe('in');
    expect(k('-')).toBe('out');
    expect(k('0')).toBe('reset');
    expect(k('=', false, true)).toBe('in');
    expect(k('=', false)).toBeNull();
    expect(k('=', true, false, true)).toBeNull();
    expect(k('a')).toBeNull();
  });

  it('roda acumula até um degrau, para cima amplia', () => {
    expect(wheelZoom(0, -10)).toEqual({ action: null, pending: -10 });
    expect(wheelZoom(-45, -10)).toEqual({ action: 'in', pending: 0 });
    expect(wheelZoom(0, 120)).toEqual({ action: 'out', pending: 0 });
    expect(wheelZoom(30, -30)).toEqual({ action: null, pending: 0 });
  });

  it('botão só com a página à vista e nunca para o site', () => {
    expect(pageExpandable(ref, 'ready')).toBe(true);
    for (const s of ['loading', 'error', 'expired'] as const) expect(pageExpandable(ref, s)).toBe(false);
    expect(pageExpandable({ ...ref, url: 'https://a.dev' }, 'ready')).toBe(false);
  });

  it('mensagem da página: só altura finita positiva e link http(s)', () => {
    const size = (h: unknown) => ({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: h } });
    expect(parseHostMessage(size(320))).toEqual({ kind: 'height', height: 320 });
    expect(parseHostMessage(JSON.stringify(size(320)))).toEqual({ kind: 'height', height: 320 });
    expect(parseHostMessage(size(-1))).toBeNull();
    expect(parseHostMessage(size('x'))).toBeNull();
    const link = (url: unknown) => ({ method: 'ui/open-link', params: { url } });
    expect(parseHostMessage(link('https://a.dev/x'))).toEqual({ kind: 'link', url: 'https://a.dev/x' });
    expect(parseHostMessage(link('javascript:alert(1)'))).toBeNull();
    expect(parseHostMessage('not json')).toBeNull();
    expect(parseHostMessage(null)).toBeNull();
  });
});
