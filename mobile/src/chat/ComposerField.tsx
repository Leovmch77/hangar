import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View, type TextInput } from 'react-native';
import * as Haptics from 'expo-haptics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { hexParaRgb } from '@hangar/core';
import { Glass } from '../ui/Glass';
import { MultilineInput } from '../ui/MultilineInput';
import { RecordingWave } from '../ui/RecordingWave';
import { Icon } from '../ui/Icon';
import * as m from '../paraglide/messages';

export function ComposerBox({ focused, children }: { focused: boolean; children: ReactNode }) {
  const { theme } = useUnistyles();
  const accent = hexParaRgb(theme.tokens.accent.base);
  return <Glass variant="chrome" style={[styles.box, focused && accent ? { borderColor: `rgba(${accent.join(',')},0.45)` } : null]}>{children}</Glass>;
}

export const ComposerInput = forwardRef<TextInput, ComponentProps<typeof MultilineInput> & {
  recording: boolean; rms: number; onCancelRecording: () => void;
}>(function ComposerInput({ recording, rms, onCancelRecording, ...props }, ref) {
  return <View style={styles.inputWrap}>
    <MultilineInput {...props} ref={ref} maxHeight={props.maxHeight ?? 120}
      style={[props.style, recording && styles.hidden]} editable={!recording && props.editable !== false}
      accessibilityElementsHidden={recording} importantForAccessibility={recording ? 'no-hide-descendants' : 'auto'} />
    {recording ? <View style={styles.wave}><RecordingWave rms={rms} onCancel={onCancelRecording} /></View> : null}
  </View>;
});

type Action = { onPress: () => void; disabled: boolean; busy?: boolean; showBusy?: boolean };
export function ComposerActions({ attach, mic, send, settings, beforeMic, afterMic, afterSettings }: {
  attach: Action;
  mic: Action & { recording: boolean; styleLabel: string; onStyle: () => void };
  send: Action & { label: string; hint?: string; editing?: boolean; count?: number; visible?: boolean };
  settings: ReactNode; beforeMic?: ReactNode; afterMic?: ReactNode; afterSettings?: ReactNode;
}) {
  const { theme } = useUnistyles();
  const count = send.count ?? 0;
  return <View style={styles.row}>
    <Pressable onPress={attach.onPress} disabled={attach.disabled} hitSlop={5}
      accessibilityState={{ disabled: attach.disabled, busy: attach.busy }}
      style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, attach.disabled && styles.disabled]}
      accessibilityLabel={m.composer_adicionar_ao_chat()} accessibilityRole="button">
      {attach.busy ? <ActivityIndicator size="small" color={theme.tokens.text.secondary} /> : <Icon name="Plus" size={22} color={theme.tokens.text.secondary} />}
    </Pressable>
    {beforeMic}
    <Pressable onPress={mic.onPress} disabled={mic.disabled} hitSlop={5}
      accessibilityState={{ disabled: mic.disabled, busy: mic.busy }}
      style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, mic.disabled && styles.disabled]}
      accessibilityLabel={mic.recording ? m.composer_parar_gravacao() : m.composer_gravar_audio()} accessibilityRole="button"
      onLongPress={mic.recording ? undefined : mic.onStyle}
      accessibilityHint={m.composer_mic_style_hint({ estilo: mic.styleLabel })}
      accessibilityActions={mic.recording ? undefined : [{ name: 'longpress', label: m.ditado_estilo_titulo() }]}
      onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'longpress' && !mic.recording) mic.onStyle(); }}>
      {mic.busy && mic.showBusy ? <ActivityIndicator size="small" color={theme.tokens.text.secondary} />
        : <Icon name={mic.recording ? 'Square' : 'Mic'} size={mic.recording ? 16 : 20} color={mic.recording ? theme.tokens.status.error : theme.tokens.text.secondary} />}
    </Pressable>
    {afterMic}
    <View style={styles.spacer} />
    {settings}
    {afterSettings}
    {send.visible === false ? null : <Pressable
      onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); send.onPress(); }}
      disabled={send.disabled} hitSlop={5} accessibilityState={{ disabled: send.disabled, busy: send.busy }}
      style={({ pressed }) => [styles.roundBtn, { backgroundColor: !send.disabled ? theme.tokens.text.primary : theme.tokens.border.default }, pressed && !send.disabled && styles.sendPressed]}
      accessibilityLabel={send.label} accessibilityHint={send.hint} accessibilityRole="button">
      {send.busy && send.showBusy ? <ActivityIndicator size="small" color={!send.disabled ? theme.tokens.bg.base : theme.tokens.text.muted} />
        : <Icon name={send.editing ? 'Check' : 'ArrowUp'} size={18} color={!send.disabled ? theme.tokens.bg.base : theme.tokens.text.muted} />}
      {count > 0 ? <View style={[styles.queueBadge, { backgroundColor: theme.tokens.status.warning }]} pointerEvents="none">
        <Text style={[styles.queueBadgeText, { color: theme.tokens.text.inverse }]} maxFontSizeMultiplier={1.4}>{count > 9 ? '9+' : count}</Text>
      </View> : null}
    </Pressable>}
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  box: { marginHorizontal: theme.base.space[2], borderRadius: theme.base.radius.xl, paddingHorizontal: theme.base.space[3], paddingTop: theme.base.space[3], paddingBottom: theme.base.space[2], gap: theme.base.space[1] },
  inputWrap: { minHeight: 40, justifyContent: 'center', paddingHorizontal: theme.base.space[1] },
  hidden: { opacity: 0 },
  wave: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', paddingHorizontal: theme.base.space[1] },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1.5] },
  spacer: { flex: 1, minWidth: 0 },
  iconBtn: { width: 34, height: 34, borderRadius: theme.base.radius.full, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: theme.tokens.bg.hover },
  disabled: { opacity: 0.5 },
  roundBtn: { width: 34, height: 34, borderRadius: theme.base.radius.full, alignItems: 'center', justifyContent: 'center' },
  queueBadge: { position: 'absolute', top: 0, right: 0, minWidth: 15, height: 15, paddingHorizontal: theme.base.space[0.5], borderRadius: theme.base.radius.sm, alignItems: 'center', justifyContent: 'center' },
  queueBadgeText: { fontSize: theme.base.text.xxxs, fontWeight: theme.base.weight.bold, lineHeight: 13 },
  sendPressed: { opacity: 0.8 },
}));
