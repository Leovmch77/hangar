import { ActivityIndicator, Text, View } from 'react-native';
// Mora nas barras do topo, na faixa de arrasto da gaveta: o Pressable comum perde o toque rápido no Android.
import { Pressable } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';
import { VoiceBars } from './VoiceBars';
import type { LiveVoiceView } from './LiveVoiceSheet';
import * as m from '../../paraglide/messages';

export interface LiveVoiceButtonProps {
  phase: LiveVoiceView['phase'];
  muted: boolean;
  error: boolean;
  visible: boolean;
  onPress: () => void;
}

export function LiveVoiceButton({ phase, muted, error, visible, onPress }: LiveVoiceButtonProps) {
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
        : live && !muted ? <VoiceBars mode={{ kind: 'wave', fast: true }} color={theme.tokens.accent.base} count={4} height={18} />
        : <Icon name={live ? 'MicOff' : 'AudioLines'} size={22} color={live ? theme.tokens.accent.base : undefined} />}
      {error ? <View style={styles.errorDot} accessibilityElementsHidden /> : null}
      {error ? <Text style={styles.errorText}>{m.native_live_voice_error_short()}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: { minWidth: 44, minHeight: 44, paddingHorizontal: theme.base.space[2], borderRadius: theme.base.radius.full,
    alignItems: 'center', justifyContent: 'center', gap: theme.base.space[0.5] },
  live: { backgroundColor: theme.tokens.accent.dim },
  errorDot: { position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: theme.base.radius.full, backgroundColor: theme.tokens.status.error },
  errorText: { fontSize: theme.base.text.xxs, color: theme.tokens.status.error },
}));
