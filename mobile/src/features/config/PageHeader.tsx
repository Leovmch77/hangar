import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Icon, type IconName } from '../../ui/Icon';
import { useSettingsColors } from './colors';

export interface PageAction {
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
}

/** Topo das páginas (page_top do Rust): título, a linha que explica e as pílulas de ação embaixo. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: PageAction[] }) {
  const c = useSettingsColors();
  return (
    <View style={styles.top}>
      <View>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={[styles.subtitle, { color: c.muted }]}>{subtitle}</Text> : null}
      </View>
      {actions?.length ? (
        <View style={styles.pills}>
          {actions.map((a) => <Pill key={a.label} {...a} />)}
        </View>
      ) : null}
    </View>
  );
}

export function Pill({ label, icon, onPress, disabled = false }: PageAction) {
  const c = useSettingsColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [styles.pill, { borderColor: c.borderStrong, opacity: disabled ? 0.5 : 1 }, pressed && { backgroundColor: c.hover }]}
    >
      {icon ? <Icon name={icon} size={14} color={c.text} /> : null}
      <Text style={[styles.pillText, { color: c.text }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  top: { gap: theme.base.space[3], paddingHorizontal: theme.base.space[1] },
  title: { fontSize: theme.base.text.lg, fontWeight: theme.base.weight.semibold },
  subtitle: { marginTop: theme.base.space[1.5], fontSize: theme.base.text.sm, lineHeight: 20 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2] },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[1.5],
    height: 32,
    paddingHorizontal: theme.base.space[3],
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
  },
  pillText: { fontSize: theme.base.text.xs, fontWeight: theme.base.weight.medium },
}));
