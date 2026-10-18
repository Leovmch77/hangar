import { StyleSheet } from 'react-native-unistyles';
import { themeDark, themeLight, themeBase } from '@hangar/core';
import { prefs } from '../stores/prefs';
import { CONVERSA_PADRAO, type Conversa } from './aplicarMaterial';
import { INK, MONO, RADIUS, SPACE, TEXT, TYPE, WEIGHT } from './scale';

// Lê o MMKV cru, e não o store de aparência: este módulo é o primeiro import do _layout e precisa
// rodar antes de qualquer coisa tocar o UnistylesRuntime — o store importa `aplicarMaterial`, que
// mexe no runtime. Sem semear daqui, tudo pintava com alpha de fábrica até o primeiro
// `aplicarMaterial()`, e a tela abria com um piscão de opacidade errada.
const alphaSalvo = (chave: string, padrao: number, minimum = 0) => {
  const v = prefs.getNumber(chave);
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(minimum, Math.min(1, v)) : padrao;
};

const mk = (t: typeof themeDark) => ({
  tokens: t,
  // A JetBrains Mono do core não vem embutida no app: sem trocar, código cai na fonte proporcional.
  base: {
    ...themeBase,
    fontMono: MONO,
    // Escala do celular um ponto acima da do desktop: corpo 17 é o padrão de leitura do iPhone.
    text: TEXT,
    space: SPACE,
    radius: RADIUS,
    weight: WEIGHT,
  },
  type: TYPE,
  ink: INK,
  panelAlpha: alphaSalvo('aparencia.panelAlpha', t.glass.panelAlpha, 0.3),
  surfaceAlpha: alphaSalvo('aparencia.surfaceAlpha', 1),
  // O valor salvo chega no primeiro `aplicarMaterial()` do _layout, antes da primeira tela.
  conversa: CONVERSA_PADRAO as Conversa,
});

const appThemes = { light: mk(themeLight), dark: mk(themeDark) };

type AppThemes = typeof appThemes;

declare module 'react-native-unistyles' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
}

StyleSheet.configure({ themes: appThemes, settings: { adaptiveThemes: true } });
