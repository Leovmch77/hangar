import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSettingsColors } from './colors';

export interface Dot {
  key: string;
  color: string;
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Amostra do "sem cor" (tinta 0): leva contorno para não sumir no fundo de mesma cor. */
  empty?: boolean;
}

/** Amostras de cor do Rust: quadradinho 20 com anel de 2px na cor do texto quando escolhido. */
export function ColorDots({ dots, label }: { dots: Dot[]; label: string }) {
  const c = useSettingsColors();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {dots.map((d) => (
        <View key={d.key} style={[styles.ring, { borderColor: d.selected ? c.text : 'transparent' }]}>
          <Pressable
            onPress={d.onPress}
            accessibilityRole="radio"
            accessibilityLabel={d.label}
            accessibilityState={{ selected: d.selected }}
            // Alvo de toque de 36: o desenho é de 28 com o anel.
            hitSlop={4}
            style={({ pressed }) => [styles.target, pressed && { opacity: 0.7 }]}
          >
            <View style={[styles.swatch, { backgroundColor: d.color }, d.empty && { borderWidth: 1, borderColor: c.borderStrong }]} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  ring: { borderWidth: 2, borderRadius: 8 },
  target: { width: 24, height: 24, padding: 2, borderRadius: 6 },
  swatch: { flex: 1, borderRadius: 6 },
});
