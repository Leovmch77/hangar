import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';
import type { Fundo } from '../../stores/aparencia';
import { useSettingsColors } from './colors';
import type { Option } from './Segmented';
import { Tiles } from './Tiles';

/** Desenho de cada fundo (art_background do Rust): mostra o efeito, não um ícone genérico. */
function Art({ fundo }: { fundo: Fundo }) {
  const c = useSettingsColors();
  return fundo === 'texture' ? (
    <View style={styles.dots}>
      {Array.from({ length: 40 }, (_, i) => <View key={i} style={[styles.dot, { backgroundColor: c.faint }]} />)}
    </View>
  ) : fundo === 'aurora' ? (
    // Brilho difuso no alto, como a sombra borrada do Rust: círculo chapado parecia uma bola.
    <Svg style={styles.glow} pointerEvents="none">
      <Defs>
        <RadialGradient id="tileGlow" cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0" stopColor={c.accent} stopOpacity={0.55} />
          <Stop offset="1" stopColor={c.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#tileGlow)" />
    </Svg>
  ) : fundo === 'image' ? (
    <View style={styles.center}><Icon name="Image" size={18} color={c.faint} /></View>
  ) : null;
}

export function BackgroundTiles({
  options,
  value,
  onChange,
  label,
  imageMenu,
}: {
  options: ReadonlyArray<Option<Fundo>>;
  value: Fundo;
  onChange: (v: Fundo) => void;
  label: string;
  /** Imagem sem foto salva: o toque abre o menu de origem (Fotos/Arquivos) em vez de trocar o fundo. */
  imageMenu?: (tile: ReactNode) => ReactNode;
}) {
  return (
    <Tiles
      options={options}
      value={value}
      onChange={onChange}
      label={label}
      art={(v) => <Art fundo={v} />}
      wrap={(v, tile) => (v === 'image' && imageMenu ? imageMenu(tile) : null)}
    />
  );
}

const styles = StyleSheet.create({
  dots: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 5, padding: 6, opacity: 0.55 },
  dot: { width: 2, height: 2, borderRadius: 1 },
  glow: { position: 'absolute', top: -30, right: -20, width: 90, height: 80 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
