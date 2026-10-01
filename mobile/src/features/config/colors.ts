import { useUnistyles } from 'react-native-unistyles';
import { hexParaRgb } from '@hangar/core';

// Tons do desktop Rust (theme.rs) que o tema compartilhado com a PWA não tem; calculados aqui
// para não mexer no core.
const LINE = { dark: '255,248,244', light: '50,40,35' } as const;
const INSET = { dark: '14,12,15', light: '240,235,227' } as const;

const withAlpha = (hex: string, a: number) => {
  const rgb = hexParaRgb(hex);
  return rgb ? `rgba(${rgb.join(',')},${a})` : hex;
};

// accent_text do Rust: o matiz do destaque com luminosidade fixa, legível sobre o accent_dim.
function accentText(hex: string, dark: boolean): string {
  const rgb = hexParaRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l0 = (max + min) / 2;
  const s = Math.min(0.8, d ? d / (1 - Math.abs(2 * l0 - 1)) : 0);
  const l = dark ? 0.87 : 0.34;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `rgb(${[r1, g1, b1].map((v) => Math.round((v + m) * 255)).join(',')})`;
}

export function useSettingsColors() {
  const { theme, rt } = useUnistyles();
  const dark = rt.themeName === 'dark';
  const mode = dark ? 'dark' : 'light';
  const accent = theme.tokens.accent.base;
  return {
    dark,
    accent,
    accentDim: withAlpha(accent, dark ? 0.16 : 0.12),
    accentText: accentText(accent, dark),
    border: `rgba(${LINE[mode]},0.08)`,
    borderStrong: `rgba(${LINE[mode]},0.14)`,
    // Translúcido como o inset do Rust com fundo vazado: o papel de parede continua atravessando.
    inset: `rgba(${INSET[mode]},0.55)`,
    text: theme.tokens.text.primary,
    muted: theme.tokens.text.secondary,
    faint: theme.tokens.text.muted,
    hover: theme.tokens.bg.hover,
  };
}
