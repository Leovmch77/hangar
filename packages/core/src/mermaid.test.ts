import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMermaid = vi.fn();
vi.mock('./api', () => ({
  requestMermaid: (...a: unknown[]) => requestMermaid(...a),
  isTimeoutError: (e: unknown) => e instanceof Error && e.name === 'TimeoutError',
}));

const {
  _resetMermaidForTests, MERMAID_MAX_WIDTH, mermaidFailureText, pngDataUri, pngSize, renderMermaid, splitMermaidBlocks,
} = await import('./mermaid');
const m = await import('./paraglide/messages');

// PNG mínimo: assinatura + IHDR com 480×200.
function fakePng(w = 480, h = 200): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

const ok = (headers: Record<string, string> = { 'x-hangar-css-width': '240', 'x-hangar-css-height': '100' }) =>
  new Response(fakePng() as unknown as ConstructorParameters<typeof Response>[0], { status: 200, headers });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  _resetMermaidForTests();
  requestMermaid.mockReset();
});

describe('renderMermaid', () => {
  it('devolve a imagem com o tamanho dos cabeçalhos e guarda no cache', async () => {
    requestMermaid.mockResolvedValue(ok());
    const r = await renderMermaid('graph TD; A-->B', 'dark');
    expect(r).toMatchObject({ kind: 'image', width: 240, height: 100 });
    await renderMermaid('graph TD; A-->B', 'dark');
    expect(requestMermaid).toHaveBeenCalledTimes(1);
    expect(requestMermaid.mock.calls[0][0]).toEqual({ source: 'graph TD; A-->B', theme: 'dark', width: MERMAID_MAX_WIDTH });
  });

  it('sem cabeçalhos, mede o PNG e divide pela escala 2', async () => {
    requestMermaid.mockResolvedValue(ok({}));
    expect(await renderMermaid('a', 'light')).toMatchObject({ kind: 'image', width: 240, height: 100 });
  });

  it('o tema entra na chave do cache', async () => {
    requestMermaid.mockImplementation(async () => ok());
    await renderMermaid('a', 'dark');
    await renderMermaid('a', 'light');
    await renderMermaid('a', 'dark');
    expect(requestMermaid).toHaveBeenCalledTimes(2);
  });

  it('422 é erro do parser e fica guardado', async () => {
    requestMermaid.mockResolvedValue(json(422, { code: 'mermaid_invalido', message: 'Parse error on line 2' }));
    expect(await renderMermaid('x', 'dark')).toEqual({ kind: 'invalid', code: 'mermaid_invalido', message: 'Parse error on line 2' });
    await renderMermaid('x', 'dark');
    expect(requestMermaid).toHaveBeenCalledTimes(1);
  });

  it('503 é indisponível e a próxima chamada pergunta de novo', async () => {
    requestMermaid.mockResolvedValueOnce(json(503, { code: 'mermaid_indisponivel', message: 'sem Chromium' }));
    expect(await renderMermaid('y', 'dark')).toEqual({ kind: 'unavailable', code: 'mermaid_indisponivel', message: 'sem Chromium' });
    requestMermaid.mockResolvedValueOnce(ok());
    expect((await renderMermaid('y', 'dark')).kind).toBe('image');
    expect(requestMermaid).toHaveBeenCalledTimes(2);
  });

  it('falha de rede é indisponível, sem rejeitar', async () => {
    requestMermaid.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await renderMermaid('z', 'dark')).toMatchObject({ kind: 'unavailable', code: 'rede' });
  });

  it('prazo estourado é indisponível, com código próprio', async () => {
    requestMermaid.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    expect(await renderMermaid('t', 'dark')).toMatchObject({ kind: 'unavailable', code: 'timeout' });
  });

  it('400, 401, 410 e outro erro HTTP são recusa definitiva, guardada', async () => {
    for (const [status, src] of [[400, 'a4'], [401, 'b4'], [410, 'c4'], [500, 'd4']] as const) {
      requestMermaid.mockResolvedValueOnce(json(status, { code: 'qualquer' }));
      expect(await renderMermaid(src, 'dark')).toEqual({ kind: 'rejected', code: `http_${status}`, message: '' });
      await renderMermaid(src, 'dark');
    }
    expect(requestMermaid).toHaveBeenCalledTimes(4);
  });

  it('502 e 504 do proxy são indisponibilidade, com Tentar de novo', async () => {
    for (const [status, src] of [[502, 'p2'], [504, 'p4']] as const) {
      requestMermaid.mockResolvedValueOnce(json(status, {}));
      expect(await renderMermaid(src, 'dark')).toMatchObject({ kind: 'unavailable' });
    }
  });

  it('404 e recusa ao convidado ficam só no código', async () => {
    requestMermaid.mockResolvedValueOnce(json(404, {}));
    expect((await renderMermaid('n4', 'dark')).kind).toBe('not_offered');
    requestMermaid.mockRejectedValueOnce(Object.assign(new Error('fora'), { status: 403, code: 'erro_fora_do_convite' }));
    expect((await renderMermaid('n3', 'dark')).kind).toBe('not_offered');
  });

  it('servidor removido (recusa local) é recusa definitiva', async () => {
    requestMermaid.mockRejectedValueOnce(Object.assign(new Error('removido'), { status: 410, code: 'servidor_nao_existe' }));
    expect(await renderMermaid('g', 'dark')).toEqual({ kind: 'rejected', code: 'http_410', message: '' });
  });

  it('fonte acima de 50000 caracteres não vai ao servidor', async () => {
    expect(await renderMermaid('x'.repeat(50001), 'dark')).toMatchObject({ kind: 'too_long' });
    expect((await renderMermaid('😀'.repeat(50000), 'dark')).kind).not.toBe('too_long');
    expect(requestMermaid).toHaveBeenCalledTimes(1);
  });

  it('um pedido por vez', async () => {
    let ativos = 0;
    let pico = 0;
    requestMermaid.mockImplementation(async () => {
      ativos++;
      pico = Math.max(pico, ativos);
      await new Promise((r) => setTimeout(r, 5));
      ativos--;
      return ok();
    });
    await Promise.all(['a', 'b', 'c'].map((s) => renderMermaid(s, 'dark')));
    expect(pico).toBe(1);
  });
});

describe('mermaidFailureText', () => {
  it('cada falha tem frase própria; código cru nunca aparece', () => {
    expect(mermaidFailureText({ kind: 'invalid', code: 'mermaid_invalido', message: 'Parse error' })).toBe(m.mermaid_error({ message: 'Parse error' }));
    expect(mermaidFailureText({ kind: 'unavailable', code: 'mermaid_indisponivel', message: 'sem Chromium' })).toBe(m.mermaid_error({ message: 'sem Chromium' }));
    expect(mermaidFailureText({ kind: 'unavailable', code: 'rede', message: '' })).toBe(m.mermaid_offline());
    expect(mermaidFailureText({ kind: 'unavailable', code: 'timeout', message: '' })).toBe(m.mermaid_timeout());
    expect(mermaidFailureText({ kind: 'too_long', code: 'fonte_longa', message: '' })).toBe(m.mermaid_too_long());
    expect(mermaidFailureText({ kind: 'rejected', code: 'http_400', message: '' })).toBe(m.mermaid_bad_request());
    expect(mermaidFailureText({ kind: 'rejected', code: 'http_401', message: '' })).toBe(m.mermaid_unauthorized());
    expect(mermaidFailureText({ kind: 'rejected', code: 'http_410', message: '' })).toBe(m.mermaid_gone());
    expect(mermaidFailureText({ kind: 'rejected', code: 'http_500', message: '' })).toBe(m.mermaid_failed());
    expect(mermaidFailureText({ kind: 'not_offered', code: 'http_404', message: '' })).toBeNull();
  });
});

describe('png', () => {
  it('pngSize lê o IHDR', () => {
    expect(pngSize(fakePng(10, 20))).toEqual({ width: 10, height: 20 });
    expect(pngSize(new Uint8Array(3))).toBeNull();
  });

  it('pngDataUri codifica em base64', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(pngDataUri(bytes)).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    const seis = new Uint8Array([250, 251, 252, 253, 254, 255]);
    expect(pngDataUri(seis)).toBe(`data:image/png;base64,${Buffer.from(seis).toString('base64')}`);
  });
});

describe('splitMermaidBlocks', () => {
  it('parte texto, diagrama e texto', () => {
    expect(splitMermaidBlocks('antes\n```mermaid\ngraph TD\nA-->B\n```\ndepois')).toEqual([
      { markdown: 'antes' }, { mermaid: 'graph TD\nA-->B' }, { markdown: 'depois' },
    ]);
  });

  it('mermaid dentro de outra cerca continua texto', () => {
    const md = '````md\n```mermaid\nA\n```\n````';
    expect(splitMermaidBlocks(md)).toEqual([{ markdown: md }]);
  });

  it('cerca sem fechamento continua texto', () => {
    const md = 'x\n```mermaid\nA-->B';
    expect(splitMermaidBlocks(md)).toEqual([{ markdown: md }]);
  });

  it('sem mermaid devolve o markdown inteiro', () => {
    expect(splitMermaidBlocks('só **texto**')).toEqual([{ markdown: 'só **texto**' }]);
  });
});
