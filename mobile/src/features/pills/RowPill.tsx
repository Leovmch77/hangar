import { Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { superficie } from '../../theme/superficie';

// Pílula da linha do composer (modo, modelo, nível, permissão): rótulo curto que encolhe com
// reticências quando a linha aperta. `shrink` diz quem cede primeiro — o nome do modelo é o longo.
export function RowPill({ label, value, onPress, accent = false, shrink = 1 }: {
  label: string;
  value: string;
  onPress: () => void;
  accent?: boolean;
  shrink?: number;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8 }}
      style={({ pressed }) => [styles.pill, { flexShrink: shrink, backgroundColor: pressed ? theme.tokens.bg.hover : superficie(theme, 0.6) }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
    >
      <Text
        style={[styles.text, { color: accent ? theme.tokens.accent.base : theme.tokens.text.primary }, accent && styles.accent]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    minWidth: 36,
    height: 28,
    justifyContent: 'center',
    borderRadius: theme.base.radius.xs,
    paddingHorizontal: theme.base.space[2],
  },
  text: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  accent: {
    fontWeight: '700',
  },
}));
