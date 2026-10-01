import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';

// Linha da folha de ajustes da sessão: nome do campo à esquerda, valor atual à direita. É a
// apresentação comum de Modelo, Nível e Permissão; cada um continua com o próprio seletor.
export function SettingRow({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.tokens.bg.hover }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
    >
      <Text style={[styles.label, { color: theme.tokens.text.secondary }]}>{label}</Text>
      <View style={styles.right}>
        <Text style={[styles.value, { color: theme.tokens.text.primary }]} numberOfLines={1}>
          {value}
        </Text>
        <Icon name="ChevronRight" size={16} color={theme.tokens.text.muted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.base.space[3],
    minHeight: 48,
    paddingHorizontal: theme.base.space[2],
    borderRadius: theme.base.radius.md,
  },
  label: {
    fontSize: theme.base.text.base,
  },
  right: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[1],
  },
  value: {
    flexShrink: 1,
    fontSize: theme.base.text.base,
    fontWeight: '600',
  },
}));
