import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Image } from 'expo-image';
import Svg, { Defs, Path, Pattern, Rect } from 'react-native-svg';
import type { BackgroundEffect } from '@hangar/core';
import { Icon } from '../../ui/Icon';
import { useSettingsColors } from './colors';
import type { Option } from './Segmented';

// Célula de cada efeito desenhada por cima da própria foto, na geometria de effects.rs: o que não é
// tinta recebe o "papel" (preto no escuro, branco no claro) a 40%, as linhas de TV a 48%. Processar a
// foto cinco vezes só pra miniatura custaria uma ida à WebView por ladrilho.
const CELL: Record<Exclude<BackgroundEffect, 'none'>, { w: number; h: number; d: string; opacity: number }> = {
  // Bayer 2×2 em blocos de 2: metade das células apaga quase por inteiro (ganho 0.08).
  dither: { w: 4, h: 4, d: 'M0 0H2V2H0Z M2 2H4V4H2Z', opacity: 0.9 },
  // Glifo "+" (GLYPHS[5]) numa célula 6×8; o resto da célula vira papel.
  ascii: { w: 6, h: 8, d: 'M0 0H6V8H0Z M2 1H3V3H5V4H3V6H2V4H0V3H2Z', opacity: 0.4 },
  // Ponto de raio ~1.6 numa célula 4×4; fora dele, papel.
  halftone: { w: 4, h: 4, d: 'M0 0H4V4H0Z M2 0.4A1.6 1.6 0 1 0 2 3.6A1.6 1.6 0 1 0 2 0.4Z', opacity: 0.4 },
  scanlines: { w: 3, h: 3, d: 'M0 0H3V1H0Z', opacity: 0.48 },
};

function Art({ effect, uri, light }: { effect: BackgroundEffect; uri: string; light: boolean }) {
  const c = useSettingsColors();
  const cell = effect === 'none' ? null : CELL[effect];
  // Dither ignora o tema (effects.rs `key`): apaga para preto nos dois.
  const paper = effect === 'dither' || !light ? '#000' : '#fff';
  return (
    <View style={[styles.art, { backgroundColor: c.inset }]}>
      <Image source={{ uri }} style={StyleSheet.absoluteFillObject} contentFit="cover" />
      {cell ? (
        <Svg style={StyleSheet.absoluteFillObject}>
          <Defs>
            <Pattern id={`fx-${effect}`} width={cell.w} height={cell.h} patternUnits="userSpaceOnUse">
              <Path d={cell.d} fill={paper} fillOpacity={cell.opacity} fillRule="evenodd" />
            </Pattern>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#fx-${effect})`} />
        </Svg>
      ) : null}
    </View>
  );
}

export function EffectTiles({
  options,
  value,
  onChange,
  label,
  imageUri,
}: {
  options: ReadonlyArray<Option<BackgroundEffect>>;
  value: BackgroundEffect;
  onChange: (v: BackgroundEffect) => void;
  label: string;
  imageUri: string;
}) {
  const c = useSettingsColors();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.v === value;
        return (
          <View key={o.v} style={styles.cell}>
            <View style={[styles.frame, { borderColor: on ? c.accent : c.borderStrong }]}>
              <Pressable
                onPress={() => { if (!on) onChange(o.v); }}
                accessibilityRole="radio"
                accessibilityLabel={o.aria ?? o.label}
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.button, on && { backgroundColor: c.accentDim }, pressed && { opacity: 0.7 }]}
              >
                <Art effect={o.v} uri={imageUri} light={!c.dark} />
                <View style={styles.caption}>
                  {on ? <Icon name="Check" size={12} color={c.accent} /> : null}
                  <Text style={[styles.captionText, { color: on ? c.text : c.muted, fontWeight: on ? '500' : '400' }]} numberOfLines={1}>
                    {o.label}
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  cell: { flex: 1, minWidth: 0 },
  frame: { borderRadius: 11, borderWidth: 2 },
  button: { padding: 4, borderRadius: 9, gap: 5 },
  art: { height: 48, borderRadius: 7, overflow: 'hidden' },
  caption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  captionText: { fontSize: 12.5, flexShrink: 1 },
});
