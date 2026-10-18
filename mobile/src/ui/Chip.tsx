import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from './Icon';
import { superficie } from '../theme/superficie';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

export function Chip({ children, tone = 'neutral', icon, mono }: { children: string; tone?: Tone; icon?: IconName; mono?: boolean }) {
  const { theme } = useUnistyles();
  const cor = {
    neutral: theme.tokens.text.secondary,
    accent: theme.tokens.accent.base,
    success: theme.tokens.status.success,
    warning: theme.tokens.status.warning,
    error: theme.tokens.status.error,
  }[tone];
  return (
    <View style={[styles.chip, { borderColor: cor + '55' }]}>
      {icon ? <Icon name={icon} size={11} color={cor} /> : null}
      <Text style={[styles.txt, { color: cor }, mono && styles.mono]} numberOfLines={1}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1],
    paddingHorizontal: theme.base.space[1.5], paddingVertical: theme.base.space[0.5], borderRadius: theme.base.radius.full, borderWidth: 1,
    backgroundColor: superficie(theme, 0.5),
  },
  txt: { fontSize: theme.base.text.xxs, fontWeight: theme.base.weight.semibold },
  mono: { fontFamily: theme.base.fontMono, fontWeight: theme.base.weight.medium },
}));
