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
  minHeight,
}: {
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (v: T) => void;
  /** Nome do grupo pro leitor de tela — o título da linha que contém o segmentado. */
  label: string;
  /** Escolha sem efeito agora (outra opção manda nela): fica à vista e apagada, como no Rust. */
  disabled?: boolean;
  minHeight?: number;
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
              minHeight !== undefined && { minHeight },
              i > 0 && { borderLeftWidth: 1, borderLeftColor: c.borderStrong },
              { backgroundColor: on ? c.accentDim : pressed ? c.hover : 'transparent' },
            ]}
            accessibilityRole="radio"
            accessibilityLabel={o.aria ?? o.label}
            accessibilityState={{ selected: on, disabled }}
          >
            <Text style={[styles.text, { color: on ? c.accentText : c.muted }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: { flexDirection: 'row', alignSelf: 'stretch', borderWidth: 1, borderRadius: theme.base.radius.sm, overflow: 'hidden' },
  option: { flex: 1, minHeight: 36, paddingHorizontal: theme.base.space[3], paddingVertical: theme.base.space[2], alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.medium, textAlign: 'center' },
}));
