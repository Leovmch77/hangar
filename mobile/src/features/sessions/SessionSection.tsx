import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';
import { superficie } from '../../theme/superficie';
import type { SessionSection } from './sessionSections';
import * as m from '../../paraglide/messages';

export function SessionSectionHeader({ section, onToggle }: { section: SessionSection; onToggle: (id: string) => void }) {
  const { theme } = useUnistyles();
  if (!section.label) return null;
  const color = section.id === 'state:awaiting_input' ? theme.tokens.pill.input.fg
    : section.id === 'state:working' ? theme.tokens.pill.working.fg
      : section.color ?? theme.tokens.text.muted;
  return (
    <Pressable onPress={() => onToggle(section.id)} style={styles.group}
      accessibilityRole="button" accessibilityLabel={`${section.label}, ${section.total} ${m.lista_sessoes_plural()}`}
      accessibilityState={{ expanded: !section.collapsed }}
      accessibilityHint={section.collapsed ? m.sessao_expandir() : m.sessao_recolher()}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text accessibilityRole="header" style={[styles.label, { color: theme.tokens.text.primary }]} numberOfLines={1}>{section.label}</Text>
      <View style={[styles.badge, { backgroundColor: superficie(theme, 0.5) }]}>
        <Text style={[styles.count, { color: theme.tokens.text.muted }]}>{section.total}</Text>
      </View>
      <View style={styles.arrow}>
        <Icon name={section.collapsed ? 'ChevronRight' : 'ChevronDown'} size={12} color={theme.tokens.text.muted} />
      </View>
    </Pressable>
  );
}

export function SessionSectionCard({ index, total, children }: { index: number; total: number; children: ReactNode }) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.card, { backgroundColor: superficie(theme, 0.4) }, index === 0 && styles.first,
      index === total - 1 && styles.last]}>
      {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.tokens.border.subtle }]} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], minHeight: 44, paddingTop: theme.base.space[3], paddingBottom: theme.base.space[1.5], paddingHorizontal: theme.base.space[1.5], backgroundColor: 'transparent' },
  label: { flexShrink: 1, fontSize: theme.base.text.lg, fontWeight: theme.base.weight.bold },
  dot: { width: 7, height: 7, borderRadius: theme.base.radius.xs },
  badge: { paddingHorizontal: theme.base.space[1.5], paddingVertical: theme.base.space[0.5], borderRadius: theme.base.radius.full },
  count: { fontSize: theme.base.text.xs, fontVariant: ['tabular-nums'] },
  arrow: { marginLeft: 'auto' },
  card: { overflow: 'hidden' },
  first: { borderTopLeftRadius: theme.base.radius.lg, borderTopRightRadius: theme.base.radius.lg },
  last: { borderBottomLeftRadius: theme.base.radius.lg, borderBottomRightRadius: theme.base.radius.lg },
  // O separador começa na coluna do texto, como nas listas do iOS.
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
}));
