import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSettingsColors } from './colors';

export interface Option<T extends string> {
  v: T;
  label: string;
  /** Rótulo de leitor de tela quando o texto curto do botão não explica a opção. */
  aria?: string;
}

/** Segmentado do desktop Rust: uma silhueta só, divisória entre opções, escolhida em destaque suave. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
}: {
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (v: T) => void;
  /** Nome do grupo pro leitor de tela — o título da linha que contém o segmentado. */
  label: string;
  /** Escolha sem efeito agora (outra opção manda nela): fica à vista e apagada, como no Rust. */
  disabled?: boolean;
}) {
  const c = useSettingsColors();
  return (
    <View style={[styles.rail, { borderColor: c.borderStrong }, disabled && { opacity: 0.5 }]} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o, i) => {
        const on = o.v === value;
        return (
          <Pressable
            key={o.v}
            onPress={() => { if (!on) onChange(o.v); }}
            disabled={disabled}
            style={({ pressed }) => [
              styles.option,
              i > 0 && { borderLeftWidth: 1, borderLeftColor: c.borderStrong },
              { backgroundColor: on ? c.accentDim : pressed ? c.hover : 'transparent' },
            ]}
            accessibilityRole="radio"
            accessibilityLabel={o.aria ?? o.label}
            accessibilityState={{ selected: on, disabled }}
          >
            <Text style={[styles.text, { color: on ? c.accentText : c.muted }]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { flexDirection: 'row', alignSelf: 'stretch', borderWidth: 1, borderRadius: 6, overflow: 'hidden' },
  option: { flex: 1, height: 36, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 15, fontWeight: '500' },
});
