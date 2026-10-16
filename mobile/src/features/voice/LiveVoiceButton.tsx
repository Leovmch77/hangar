import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';
import type { LiveVoiceView } from './LiveVoiceSheet';
import * as m from '../../paraglide/messages';

export interface LiveVoiceButtonProps {
  phase: LiveVoiceView['phase'];
  muted: boolean;
  levels: LiveVoiceView['levels'];
  error: boolean;
  visible: boolean;
  onPress: () => void;
}

const levelHeight = (value: number) => 4 + 16 * (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

export function LiveVoiceButton({ phase, muted, levels, error, visible, onPress }: LiveVoiceButtonProps) {
  const { theme } = useUnistyles();
  if (!visible) return null;
  const live = phase === 'live';
  const status = error ? m.live_voice_error_failed() : phase === 'connecting' ? m.live_voice_connecting()
    : live ? muted ? m.codex_voice_muted() : m.live_voice_live() : m.live_voice_open();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${m.live_voice_open()}: ${status}`}
      accessibilityState={{ busy: phase === 'connecting' }}
      style={[styles.button, live && styles.live]}
    >
      {phase === 'connecting' ? <ActivityIndicator size="small" color={theme.tokens.accent.base} />
        : live ? (
          <View style={styles.levels} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={[styles.bar, { height: levelHeight(muted ? 0 : levels.input) }]} />
            <View style={[styles.bar, styles.output, { height: levelHeight(levels.output) }]} />
            <View style={[styles.bar, { height: levelHeight(muted ? 0 : levels.input) }]} />
          </View>
        ) : <Icon name="AudioLines" size={22} />}
      {error ? <View style={styles.errorDot} accessibilityElementsHidden /> : null}
      {error ? <Text style={styles.errorText}>{m.native_live_voice_error_short()}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: { minWidth: 44, minHeight: 44, paddingHorizontal: 8, borderRadius: theme.base.radius.full,
    alignItems: 'center', justifyContent: 'center', gap: 2 },
  live: { backgroundColor: theme.tokens.accent.dim },
  levels: { height: 22, flexDirection: 'row', alignItems: 'center', gap: 3 },
  bar: { width: 3, borderRadius: 2, backgroundColor: theme.tokens.accent.base },
  output: { backgroundColor: theme.tokens.status.success },
  errorDot: { position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: 4, backgroundColor: theme.tokens.status.error },
  errorText: { fontSize: theme.base.text.xxs, color: theme.tokens.status.error },
}));
