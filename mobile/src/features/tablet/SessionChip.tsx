import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { rotuloEstado, type AggSession } from '@hangar/core';
import { SessionAvatar } from '../sessions/SessionAvatar';
import { Icon } from '../../ui/Icon';
import { superficie } from '../../theme/superficie';

export const SessionChip = memo(function SessionChip({ session, selected, onPress }: {
  session: AggSession; selected: boolean; onPress(): void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}
      accessibilityLabel={`${session.name}, ${session.serverLabel}, ${rotuloEstado(session.state)}`}
      style={({ pressed }) => [styles.chip, {
        backgroundColor: selected || pressed ? superficie(theme, 0.8) : 'transparent',
        borderColor: selected ? theme.tokens.accent.base : 'transparent',
      }]}>
      <SessionAvatar session={session} size={30} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.tokens.text.primary }]}>{session.name}</Text>
        <View style={styles.machine}>
          <Icon name="Monitor" size={12} color={theme.tokens.text.muted} />
          <Text numberOfLines={1} style={[styles.server, { color: theme.tokens.text.muted }]}>{session.serverLabel}</Text>
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  chip: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], minHeight: 44, maxWidth: 220,
    paddingHorizontal: theme.base.space[3], paddingVertical: theme.base.space[1], borderRadius: theme.base.radius.md, borderWidth: 1 },
  text: { flexShrink: 1, gap: theme.base.space[0.5] },
  name: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.semibold },
  machine: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1] },
  server: { fontSize: theme.base.text.xxxs, flexShrink: 1 },
}));
