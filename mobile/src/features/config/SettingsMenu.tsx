import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Icon, type IconName } from '../../ui/Icon';
import { useSettingsColors } from './colors';

/** Título de grupo da coluna das Configurações do Rust ("Este aparelho", "Servidor"). */
export function SettingsMenuGroup({ title, right }: { title: string; right?: ReactNode }) {
  const c = useSettingsColors();
  return (
    <View style={styles.group}>
      <Text style={[styles.groupText, { color: c.faint }]} accessibilityRole="header">{title}</Text>
      {right}
    </View>
  );
}

/** Item da navegação: ícone discreto e nome, sem caixa; o toque é o realce. */
export function SettingsMenuItem({ icon, label, onPress }: { icon?: IconName; label: string; onPress: () => void }) {
  const c = useSettingsColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: c.hover }]}
    >
      {icon ? <Icon name={icon} size={18} color={c.faint} /> : null}
      <Text style={[styles.itemText, { color: c.muted }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingTop: 12, paddingBottom: 6 },
  groupText: { flex: 1, fontSize: 13, fontWeight: '500' },
  item: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  itemText: { flex: 1, fontSize: 15 },
});
