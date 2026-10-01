import { applyBackgroundEffect, effectSize, type BackgroundEffect } from './backgroundEffect';

// Mesmas células de referência do teste `reference_cells_and_legacy_settings` de effects.rs.
const solid = (w: number, h: number, px: number[]) => {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i += 4) d.set(px, i);
  return d;
};
const px = (d: ArrayLike<number>, w: number, x: number, y: number) => Array.from(d).slice((y * w + x) * 4, (y * w + x) * 4 + 4);

describe('applyBackgroundEffect (paridade com effects.rs)', () => {
  const src = solid(8, 8, [100, 150, 200, 255]);
  const run = (e: BackgroundEffect, light = false) => applyBackgroundEffect(src, 8, 8, e, light);

  it('células de referência', () => {
    expect(run('none', true)).toBe(src);
    const dither = run('dither');
    expect(px(dither, 8, 0, 0)).toEqual([128, 191, 255, 255]);
    expect(px(dither, 8, 1, 1)).toEqual(px(dither, 8, 0, 0));
    expect(px(dither, 8, 4, 2)).toEqual([8, 12, 16, 255]);
    expect(run('dither', true)).toEqual(dither);
    const ascii = run('ascii');
    expect(px(ascii, 8, 5, 7)).toEqual([60, 90, 120, 255]);
    expect(px(ascii, 8, 2, 2)).toEqual(px(src, 8, 2, 2));
    const dots = run('halftone');
    expect(px(dots, 8, 1, 1)).toEqual(px(src, 8, 1, 1));
    expect(px(dots, 8, 0, 0)[0]).toBeLessThan(px(dots, 8, 1, 1)[0]);
    const scan = run('scanlines');
    expect(px(scan, 8, 0, 0)).toEqual([52, 78, 104, 255]);
    expect(px(scan, 8, 0, 1)).toEqual(px(src, 8, 0, 1));
    for (const e of ['ascii', 'halftone', 'scanlines'] as const) {
      expect(run(e, false)).not.toEqual(run(e, true));
      expect(applyBackgroundEffect(new Uint8Array([20, 30, 40, 80]), 1, 1, e, false)[3]).toBe(80);
    }
  });

  // A WebView do app recebe o TEXTO da função: ela tem que rodar sozinha, sem nada do módulo.
  it('o texto da função, avaliado fora do módulo, dá os mesmos pixels', () => {
    const text = applyBackgroundEffect.toString();
    expect(text).toContain('show source');
    const standalone = new Function(`return (${text});`)() as typeof applyBackgroundEffect;
    const sizeText = effectSize.toString();
    expect((new Function(`return (${sizeText});`)() as typeof effectSize)(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    const noise = new Uint8ClampedArray(37 * 23 * 4).map((_, i) => (i * 2654435761) >>> 24);
    for (const e of ['dither', 'ascii', 'halftone', 'scanlines'] as const)
      for (const light of [false, true])
        expect(Array.from(standalone(noise, 37, 23, e, light))).toEqual(Array.from(applyBackgroundEffect(noise, 37, 23, e, light)));
  });
});

describe('effectSize', () => {
  it('leva o lado maior a 2048, ampliando também (thumbnail do Rust)', () => {
    expect(effectSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(effectSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(effectSize(1000, 500)).toEqual({ width: 2048, height: 1024 });
  });
});
