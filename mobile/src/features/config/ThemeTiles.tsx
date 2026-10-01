import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';
import { useSettingsColors } from './colors';
import type { Option } from './Segmented';
import type { Paleta } from '../../theme/paleta';

// Cores das miniaturas: chrome, fundo e linha de cada paleta do Rust (theme::thumbnail). Desenham o
// tema da opção, não o que está na tela, por isso não vêm do tema atual.
const MINI = {
  classic: {
    dark: { side: '#18151a', main: '#121013', line: 'rgba(138,129,134,0.55)' },
    light: { side: '#f6f3ee', main: '#fffdfa', line: 'rgba(111,102,96,0.55)' },
  },
  neutral: {
    dark: { side: '#1c1c1c', main: '#171717', line: 'rgba(138,138,138,0.55)' },
    light: { side: '#f7f7f7', main: '#ffffff', line: 'rgba(111,111,111,0.55)' },
  },
} as const;

type Mode = 'system' | 'light' | 'dark';

function Bars({ color }: { color: string }) {
  return (
    <View style={styles.bars}>
      <View style={[styles.bar, { width: '80%', backgroundColor: color }]} />
      <View style={[styles.bar, { width: '60%', backgroundColor: color }]} />
    </View>
  );
}

/** Janela em miniatura (mini_window do Rust): barra lateral a 30% e a conversa ao lado. */
function MiniWindow({ mode, paleta, square }: { mode: 'light' | 'dark'; paleta: Paleta; square?: boolean }) {
  const p = MINI[paleta][mode];
  return (
    <View style={[styles.window, { backgroundColor: p.side }, square && { borderRadius: 0 }]}>
      <View style={styles.side}><Bars color={p.line} /></View>
      <View style={[styles.main, { backgroundColor: p.main }]}><Bars color={p.line} /></View>
    </View>
  );
}

export function ThemeTiles({
  options,
  value,
  onChange,
  label,
  paleta = 'classic',
}: {
  options: ReadonlyArray<Option<Mode>>;
  value: Mode;
  onChange: (v: Mode) => void;
  label: string;
  paleta?: Paleta;
}) {
  const c = useSettingsColors();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.v === value;
        return (
          <View key={o.v} style={styles.tile}>
            <View style={[styles.frame, { borderColor: on ? c.accent : c.borderStrong }]}>
              <Pressable
                onPress={() => { if (!on) onChange(o.v); }}
                accessibilityRole="radio"
                accessibilityLabel={o.aria ?? o.label}
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.art, pressed && { opacity: 0.7 }]}
              >
                {/* Automático é metade claro, metade escuro: é o sistema que decide. */}
                {o.v === 'system' ? (
                  <View style={styles.split}>
                    <View style={styles.half}><MiniWindow mode="light" paleta={paleta} square /></View>
                    <View style={styles.half}><MiniWindow mode="dark" paleta={paleta} square /></View>
                  </View>
                ) : (
                  <MiniWindow mode={o.v} paleta={paleta} />
                )}
              </Pressable>
            </View>
            <View style={styles.caption}>
              {on ? <Icon name="Check" size={13} color={c.accent} /> : null}
              <Text
                style={[styles.captionText, { color: on ? c.text : c.muted, fontWeight: on ? '500' : '400' }]}
                numberOfLines={1}
              >
                {o.label}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, minWidth: 0, alignItems: 'center', gap: 8 },
  frame: { alignSelf: 'stretch', borderWidth: 2, borderRadius: 10 },
  art: { height: 72, borderRadius: 8, overflow: 'hidden' },
  split: { flex: 1, flexDirection: 'row' },
  half: { flex: 1 },
  window: { flex: 1, flexDirection: 'row', gap: 6, padding: 8, borderRadius: 8 },
  side: { width: '30%', paddingTop: 4 },
  main: { flex: 1, borderRadius: 6, padding: 8 },
  bars: { gap: 5 },
  bar: { height: 4, borderRadius: 2 },
  caption: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  captionText: { fontSize: 14 },
});
