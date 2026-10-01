import { Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { planBadge } from '@hangar/core';
import type { SessionInfo } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { Icon } from '../../ui/Icon';
import { superficie } from '../../theme/superficie';

interface Props {
  session: SessionInfo | null | undefined;
  onPress: () => void;
}

// Chip discreto no estilo do nativo: ícone lucide no lugar do emoji do rótulo e a cor só no ícone,
// sem borda de destaque — no cabeçalho ela competia com o nome da sessão.
export function PlanChip({ session, onPress }: Props) {
  const { theme } = useUnistyles();
  const badge = planBadge(session);
  if (!badge) return null;
  const cor = badge.complete ? theme.tokens.status.success : theme.tokens.accent.base;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, { backgroundColor: pressed ? theme.tokens.bg.hover : superficie(theme, 0.8) }]}
      accessibilityRole="button"
      accessibilityLabel={`${m.ctx_plano()}, ${badge.text}`}
    >
      <Icon name={badge.complete ? 'CircleCheck' : 'ClipboardList'} size={12} color={cor} />
      <Text style={[styles.text, { color: theme.tokens.text.secondary }]} numberOfLines={1}>
        {badge.text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 24,
    maxWidth: 220,
    paddingHorizontal: 9,
    borderRadius: theme.base.radius.full,
  },
  text: {
    flexShrink: 1,
    fontSize: theme.base.text.xxs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
}));
