import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';
import { useSettingsColors } from './colors';
import type { Option } from './Segmented';

/**
 * Escolha em miniaturas (`tiles` do Rust): moldura de 2px no destaque quando escolhida, o desenho
 * da opção e a legenda com ✓. Quem chama dá o desenho de cada opção.
 */
export function Tiles<T extends string>({
  options,
  value,
  onChange,
  label,
  art,
  wrap,
}: {
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  art: (v: T) => ReactNode;
  /** Envolve a miniatura de uma opção (menu de origem da imagem); devolve `null` para não envolver. */
  wrap?: (v: T, tile: ReactNode) => ReactNode | null;
}) {
  const c = useSettingsColors();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.v === value;
        const tile = (viaMenu: boolean) => (
          <View style={[styles.frame, { borderColor: on ? c.accent : c.borderStrong }]}>
            <Pressable
              onPress={viaMenu ? undefined : () => { if (!on) onChange(o.v); }}
              accessibilityRole="radio"
              accessibilityLabel={o.aria ?? o.label}
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [styles.button, on && { backgroundColor: c.accentDim }, pressed && { opacity: 0.7 }]}
            >
              <View style={[styles.art, { backgroundColor: c.inset }]}>{art(o.v)}</View>
              <View style={styles.caption}>
                {on ? <Icon name="Check" size={13} color={c.accent} /> : null}
                <Text style={[styles.captionText, { color: on ? c.text : c.muted, fontWeight: on ? '500' : '400' }]} numberOfLines={1}>
                  {o.label}
                </Text>
              </View>
            </Pressable>
          </View>
        );
        const wrapped = wrap?.(o.v, tile(true));
        return <View key={o.v} style={styles.cell}>{wrapped ?? tile(false)}</View>;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, minWidth: 0 },
  frame: { borderRadius: 11, borderWidth: 2 },
  button: { padding: 5, borderRadius: 9, gap: 6 },
  art: { height: 56, borderRadius: 7, overflow: 'hidden' },
  caption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  captionText: { fontSize: 13.5, flexShrink: 1 },
});
