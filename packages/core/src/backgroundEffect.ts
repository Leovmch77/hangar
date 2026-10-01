// Porte de desktop-native/src/effects.rs (apply) e do tamanho de media.rs (fit).
// `effectSize` e `applyBackgroundEffect` rodam também DENTRO da WebView do app, que recebe o texto
// delas por `toString()`: por isso são autocontidas (nada do módulo, nenhum helper de transpilação:
// sem for..of, spread, classe) e começam com 'show source', sem o qual o Hermes devolve "[bytecode]".

export type BackgroundEffect = 'none' | 'dither' | 'ascii' | 'halftone' | 'scanlines';
export const BACKGROUND_EFFECTS: readonly BackgroundEffect[] = ['none', 'dither', 'ascii', 'halftone', 'scanlines'];

export function isBackgroundEffect(v: unknown): v is BackgroundEffect {
  return BACKGROUND_EFFECTS.includes(v as BackgroundEffect);
}

/** Claro/escuro só muda Ascii, Halftone e Scanlines (effects.rs `key`). */
export function effectUsesLight(effect: BackgroundEffect, light: boolean): boolean {
  return light && effect !== 'none' && effect !== 'dither';
}

/** Lado maior em 2048, para cima também: é o `thumbnail(2048, 2048)` do media.rs `fit`. */
export function effectSize(w: number, h: number): { width: number; height: number } {
  'show source';
  const ratio = Math.min(2048 / w, 2048 / h);
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

/**
 * effects.rs `apply` sobre RGBA; devolve um buffer novo (ou o mesmo, sem efeito). As contas imitam o
 * f32 do Rust (Math.fround): em f64 células de borda caem no inteiro vizinho.
 */
export function applyBackgroundEffect(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  effect: BackgroundEffect,
  light: boolean,
): Uint8Array | Uint8ClampedArray {
  'show source';
  if (effect === 'none' || w === 0 || h === 0) return src;
  const f = Math.fround;
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  const GLYPHS = [
    [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 4, 0], [0, 4, 0, 0, 4, 0, 0], [0, 0, 0, 14, 0, 0, 0], [0, 0, 14, 0, 14, 0, 0],
    [0, 4, 4, 31, 4, 4, 0], [0, 21, 14, 31, 14, 21, 0], [10, 10, 31, 10, 31, 10, 10], [17, 2, 4, 4, 8, 16, 17], [14, 17, 23, 21, 23, 16, 14],
  ];
  const K60 = f(0.6), K40 = f(0.4), K52 = f(0.52), K48 = f(1 - K52), K008 = f(0.08), K03 = f(0.3), K07 = f(0.7);
  // `as u8` do Rust: trunca e satura.
  const u8 = (v: number) => (v >= 255 ? 255 : v <= 0 ? 0 : Math.trunc(v));
  const out = new Uint8Array(src);
  const at = (x: number, y: number) => ((y < h ? y : h - 1) * w + (x < w ? x : w - 1)) * 4;
  const density = (i: number) => {
    const luma = Math.floor((2126 * src[i] + 7152 * src[i + 1] + 722 * src[i + 2]) / 10000);
    return light ? 255 - luma : luma;
  };
  const paper = light ? 255 : 0;
  for (let y = 0; y < h; y++) {
    if (effect === 'scanlines' && y % 3 !== 0) continue;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (effect === 'dither') {
        const s = at(((x >> 1) << 1) + 1, ((y >> 1) << 1) + 1);
        const peak = Math.max(src[s], src[s + 1], src[s + 2]);
        const t = BAYER[(y >> 1) % 4][(x >> 1) % 4];
        const gain = f(peak / 255) > f((t + 0.5) / 16) ? f(255 / Math.max(peak, 1)) : K008;
        for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.round(f(src[s + c] * gain)));
        out[o + 3] = src[s + 3];
      } else if (effect === 'ascii') {
        const s = at(Math.floor(x / 6) * 6 + 3, (y >> 3) * 8 + 4);
        const glyph = Math.trunc(f(f(Math.sqrt(f(density(s) / 255))) * 9));
        const ink = x % 6 < 5 && y % 8 < 7 && (GLYPHS[glyph][y % 8] & (1 << (4 - (x % 6)))) !== 0;
        for (let c = 0; c < 3; c++) out[o + c] = u8(f(f(src[o + c] * K60) + f((ink ? src[s + c] : paper) * K40)));
      } else if (effect === 'halftone') {
        const left = (x >> 2) << 2, top = (y >> 2) << 2;
        const s = at(left + 2, top + 2);
        const radius = f(2 * f(K03 + f(K07 * f(Math.sqrt(f(density(at(left, top)) / 255))))));
        const dx = f(x - left - 1.5), dy = f(y - top - 1.5);
        const distance = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
        const cov = f(Math.min(1, Math.max(0, f(f(radius + 0.5) - distance))) * f(src[s + 3] / 255));
        for (let c = 0; c < 3; c++) {
          const dot = f(f(src[s + c] * cov) + f(paper * f(1 - cov)));
          out[o + c] = u8(f(f(src[o + c] * K60) + f(dot * K40)));
        }
      } else {
        for (let c = 0; c < 3; c++) {
          const v = src[o + c];
          out[o + c] = u8(light ? f(v + f(f(255 - v) * K48)) : f(v * K52));
        }
      }
    }
  }
  return out;
}
