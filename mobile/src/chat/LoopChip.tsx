import { Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { loopBadge } from '@hangar/core';
import type { LoopState } from '@hangar/core';
import * as m from '../paraglide/messages';
import { superficie } from '../theme/superficie';

interface Props {
  status: LoopState['status'] | null | undefined;
  iter?: number | null;
  max?: number | null;
  onPress: () => void;
}

export function LoopChip({ status, iter, max, onPress }: Props) {
  const { theme } = useUnistyles();
  const badge = loopBadge(status, iter, max);
  if (!badge) return null;
  const color = {
    ok: theme.tokens.accent.base,
    warn: theme.tokens.status.error,
    attention: theme.tokens.status.warning,
    muted: theme.tokens.text.muted,
  }[badge.tone];

  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, { backgroundColor: superficie(theme), borderColor: color }]}
      accessibilityRole="button"
      accessibilityLabel={m.loop_titulo()}
      hitSlop={{ top: 8, bottom: 8 }}
    >
      <Text style={[styles.text, { color }]}>{badge.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    minHeight: 28,
    maxWidth: 68,
    paddingHorizontal: theme.base.space[1.5],
    borderRadius: theme.base.radius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: theme.base.text.xxs,
    fontWeight: theme.base.weight.semibold,
    fontVariant: ['tabular-nums'],
  },
}));
