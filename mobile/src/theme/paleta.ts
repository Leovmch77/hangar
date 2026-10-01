import { comAcento, hexParaRgb, type ThemeTokens } from '@hangar/core';

// Paleta, tinta e contraste do desktop Rust (theme.rs), derivados aqui sobre os tokens do core: o
// core é o tema da PWA e não pode mudar por escolha feita no celular.

export type Paleta = 'classic' | 'neutral';
type Modo = 'dark' | 'light';

const hex = (rgb: readonly number[]) =>
  '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');

/** `mix` do theme.rs: anda `t` de `a` até `b`, canal a canal. */
export function misturar(a: string, b: string, t: number): string {
  const x = hexParaRgb(a);
  const y = hexParaRgb(b);
  if (!x || !y) return a;
  return hex(x.map((v, i) => v + (y[i] - v) * t));
}

const misturarRgb = (rgb: readonly number[], b: string, t: number): [number, number, number] => {
  const y = hexParaRgb(b) ?? [0, 0, 0];
  return [0, 1, 2].map((i) => Math.round(rgb[i] + (y[i] - rgb[i]) * t)) as [number, number, number];
};

/** Destaque de fábrica de cada paleta: a primeira amostra da Cor. */
export const ACENTO_PALETA: Record<Paleta, Record<Modo, string>> = {
  classic: { dark: '#7c87e8', light: '#5b6ad0' },
  neutral: { dark: '#459bf7', light: '#0863c4' },
};

// NEUTRAL_DARK / NEUTRAL_LIGHT do theme.rs, cada cor no papel do token que o core dá à Clássica.
const NEUTRO: Record<Modo, (t: ThemeTokens) => ThemeTokens> = {
  dark: (t) => ({
    ...t,
    bg: { base: '#171717', surface: '#1c1c1c', elevated: '#222222', hover: '#272727' },
    veuRgb: [23, 23, 23],
    border: { subtle: 'rgba(235,235,235,0.07)', default: 'rgba(235,235,235,0.12)', strong: 'rgba(235,235,235,0.22)' },
    fillSubtle: 'rgba(235,235,235,0.055)',
    text: { primary: '#d6d6d6', secondary: '#a0a0a0', muted: '#8a8a8a', inverse: '#171717' },
    bubbleUser: '#2b2b2b',
    glass: { ...t.glass, panelRgb: [28, 28, 28], rgb: [38, 38, 38], solidRgb: [23, 23, 23] },
  }),
  light: (t) => ({
    ...t,
    bg: { base: '#f7f7f7', surface: '#ffffff', elevated: '#f2f2f2', hover: '#ececec' },
    veuRgb: [247, 247, 247],
    border: { subtle: 'rgba(43,43,43,0.08)', default: 'rgba(43,43,43,0.14)', strong: 'rgba(43,43,43,0.24)' },
    fillSubtle: 'rgba(43,43,43,0.055)',
    text: { primary: '#2b2b2b', secondary: '#5e5e5e', muted: '#6f6f6f', inverse: '#ffffff' },
    bubbleUser: '#e8e8e8',
    glass: { ...t.glass, panelRgb: [255, 255, 255], rgb: [255, 255, 255], solidRgb: [255, 255, 255] },
  }),
};

/** Tintas do theme.rs (TINTS / TINTS_LIGHT); a posição 0 é "sem tinta". */
export const TINTAS: Record<Modo, readonly string[]> = {
  dark: ['', '#1d1a2e', '#2a1a1a', '#1a2a20'],
  light: ['', '#dfe2f7', '#f6dfdc', '#dcefe2'],
};
/** Amostra do "sem tinta": o fundo da barra (chrome) de cada paleta. */
export const SEM_TINTA: Record<Paleta, Record<Modo, string>> = {
  classic: { dark: '#18151a', light: '#f6f3ee' },
  neutral: { dark: '#1c1c1c', light: '#f7f7f7' },
};

export interface Cores {
  paleta: Paleta;
  acento: string | null;
  tinta: number;
  forcaTinta: number;
  /** Contraste do modo Leitura Texto (0–1); null quando a leitura em vigor não é Texto. */
  contraste: number | null;
}

export function tokensDe(fabrica: ThemeTokens, modo: Modo, c: Cores): ThemeTokens {
  const base = c.paleta === 'neutral' ? comAcento(NEUTRO[modo](fabrica), ACENTO_PALETA.neutral[modo]) : fabrica;
  let t = comAcento(base, c.acento);
  // `tinted` do Rust: só o fundo da janela, os painéis e o véu levam a tinta; caixas e textos não.
  const tinta = TINTAS[modo][c.tinta];
  if (tinta) {
    const f = c.forcaTinta;
    t = {
      ...t,
      bg: { ...t.bg, base: misturar(t.bg.base, tinta, f), surface: misturar(t.bg.surface, tinta, f) },
      veuRgb: misturarRgb(t.veuRgb, tinta, f),
      glass: { ...t.glass, panelRgb: misturarRgb(t.glass.panelRgb, tinta, f) },
    };
  }
  // `reading` do Rust: o texto anda para o branco (escuro) ou o preto (claro); secundário e apagado
  // num passo menor.
  if (c.contraste !== null) {
    const alvo = modo === 'dark' ? '#ffffff' : '#000000';
    const k = c.contraste;
    t = {
      ...t,
      text: {
        ...t.text,
        primary: misturar(t.text.primary, alvo, k),
        secondary: misturar(t.text.secondary, alvo, k * 0.7),
        muted: misturar(t.text.muted, alvo, k * 0.55),
      },
    };
  }
  return t;
}
