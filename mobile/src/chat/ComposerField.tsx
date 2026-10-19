import { forwardRef, useMemo, type ComponentProps, type ReactNode } from 'react';
import { ActionSheetIOS, ActivityIndicator, Platform, Pressable, Text, View, type TextInput } from 'react-native';
import { MenuView, type NativeActionEvent } from '@react-native-menu/menu';
import * as Haptics from 'expo-haptics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SharedValue } from 'react-native-reanimated';
import { hexParaRgb } from '@hangar/core';
import { Glass } from '../ui/Glass';
import { MultilineInput } from '../ui/MultilineInput';
import { RecordingWave } from '../ui/RecordingWave';
import { Icon } from '../ui/Icon';
import * as m from '../paraglide/messages';
import { haptic } from '../ui/haptics';
import { deliveryModeLabel, deliveryOptions, type DeliveryControls, type DeliveryMode } from './queueDelivery';

export function ComposerBox({ focused, children }: { focused: boolean; children: ReactNode }) {
  const { theme } = useUnistyles();
  const accent = hexParaRgb(theme.tokens.accent.base);
  return <Glass variant="chrome" style={[styles.box, focused && accent ? { borderColor: `rgba(${accent.join(',')},0.45)` } : null]}>{children}</Glass>;
}

export const ComposerInput = forwardRef<TextInput, ComponentProps<typeof MultilineInput> & {
  recording: boolean; rms: SharedValue<number>; onCancelRecording: () => void;
}>(function ComposerInput({ recording, rms, onCancelRecording, ...props }, ref) {
  return <View style={[styles.inputWrap, recording && styles.recordingWrap]}>
    <MultilineInput {...props} ref={ref} maxHeight={props.maxHeight ?? 120}
      style={[props.style, recording && styles.hidden]} editable={!recording && props.editable !== false}
      accessibilityElementsHidden={recording} importantForAccessibility={recording ? 'no-hide-descendants' : 'auto'} />
    {recording ? <View style={styles.wave}><RecordingWave rms={rms} onCancel={onCancelRecording} /></View> : null}
  </View>;
});

type Action = { onPress: () => void; disabled: boolean; busy?: boolean; showBusy?: boolean };
type ModeMenu = { delivery: DeliveryControls; onPick: (mode: DeliveryMode) => void };

// Toque longo no Enviar escolhe o modo de envio: com a fila vazia não há painel, e este é o caminho de volta.
// iOS usa a folha de ações (o menu de contexto engolia o toque simples), Android o PopupMenu.
export function modeMenuHandlers(menu: ModeMenu | undefined) {
  if (!menu) return null;
  const options = deliveryOptions(menu.delivery);
  const pick = (mode: string) => {
    const option = options.find((o) => o.mode === mode);
    if (!option || option.disabled || menu.delivery.mode === option.mode) return;
    haptic.selection();
    menu.onPick(option.mode);
  };
  const openIOS = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const enabled = options.filter((o) => !o.disabled);
    const current = options.find((o) => o.checked)!;
    const jev = options.find((o) => o.mode === 'jev')!;
    ActionSheetIOS.showActionSheetWithOptions({
      title: m.mobile_queue_mode_label(),
      message: [m.mobile_queue_mode_current({ mode: deliveryModeLabel[current.mode]() }), jev.disabled ? menu.delivery.help : ''].filter(Boolean).join('\n'),
      options: [...enabled.map((o) => deliveryModeLabel[o.mode]()), m.comum_cancelar()],
      cancelButtonIndex: enabled.length,
    }, (i) => { if (i < enabled.length) pick(enabled[i].mode); });
  };
  // O PopupMenu do Android não marca opção (state e subtitle são só iOS): a atual vem dita no título.
  const actions = options.map((o) => ({ id: o.mode, attributes: { disabled: o.disabled },
    title: o.checked ? m.mobile_queue_mode_selected({ mode: deliveryModeLabel[o.mode]() }) : deliveryModeLabel[o.mode]() }));
  // O toque longo não chega pelo leitor de tela no Android: cada modo vira uma ação do botão.
  const a11yActions = options.filter((o) => !o.disabled).map((o) => ({ name: o.mode, label: deliveryModeLabel[o.mode]() }));
  return { pick, openIOS, actions, a11yActions };
}

export function ComposerActions({ attach, mic, send, settings, beforeMic, afterMic, afterSettings, modeMenu }: {
  attach: Action;
  mic: Action & { recording: boolean; styleLabel: string; onStyle: () => void };
  send: Action & { label: string; hint?: string; editing?: boolean; count?: number; visible?: boolean };
  settings: ReactNode; beforeMic?: ReactNode; afterMic?: ReactNode; afterSettings?: ReactNode; modeMenu?: ModeMenu;
}) {
  const { theme } = useUnistyles();
  const count = send.count ?? 0;
  const menu = useMemo(() => modeMenuHandlers(modeMenu), [modeMenu]);
  const ios = Platform.OS === 'ios';
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
      style={({ pressed }) => [styles.iconBtn, mic.recording && styles.recordingBtn, pressed && styles.pressed, mic.disabled && styles.disabled]}
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
    {send.visible === false ? null : withModeMenu(menu, ios, <Pressable
      onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); send.onPress(); }}
      disabled={send.disabled} hitSlop={5} accessibilityState={{ disabled: send.disabled, busy: send.busy }}
      // No Android o toque longo é do MenuView; o no-op impede que soltar o dedo vire envio.
      onLongPress={!menu ? undefined : ios ? menu.openIOS : () => {}} delayLongPress={350}
      accessibilityActions={menu?.a11yActions}
      onAccessibilityAction={(e) => menu?.pick(e.nativeEvent.actionName)}
      style={({ pressed }) => [styles.roundBtn, { backgroundColor: !send.disabled ? theme.tokens.text.primary : theme.tokens.border.default }, pressed && !send.disabled && styles.sendPressed]}
      accessibilityLabel={send.label} accessibilityHint={send.hint} accessibilityRole="button">
      {send.busy && send.showBusy ? <ActivityIndicator size="small" color={!send.disabled ? theme.tokens.bg.base : theme.tokens.text.muted} />
        : <Icon name={send.editing ? 'Check' : 'ArrowUp'} size={18} color={!send.disabled ? theme.tokens.bg.base : theme.tokens.text.muted} />}
      {count > 0 ? <View style={[styles.queueBadge, { backgroundColor: theme.tokens.status.warning }]} pointerEvents="none">
        <Text style={[styles.queueBadgeText, { color: theme.tokens.text.inverse }]} maxFontSizeMultiplier={1.4}>{count > 9 ? '9+' : count}</Text>
      </View> : null}
    </Pressable>)}
  </View>;
}

function withModeMenu(menu: ReturnType<typeof modeMenuHandlers>, ios: boolean, button: ReactNode) {
  if (!menu) return button;
  // Enviar desativado (campo vazio) não pega o toque; o de fora recebe o toque longo e o menu abre igual.
  if (ios) return <Pressable onLongPress={menu.openIOS} delayLongPress={350} hitSlop={5} accessible={false}>{button}</Pressable>;
  return <MenuView shouldOpenOnLongPress title={m.mobile_queue_mode_label()} actions={menu.actions}
    onPressAction={({ nativeEvent }: NativeActionEvent) => menu.pick(nativeEvent.event)}>{button}</MenuView>;
}

const styles = StyleSheet.create((theme) => ({
  box: { marginHorizontal: theme.base.space[2], borderRadius: theme.base.radius.xl, paddingHorizontal: theme.base.space[3], paddingTop: theme.base.space[3], paddingBottom: theme.base.space[2], gap: theme.base.space[1] },
  inputWrap: { minHeight: 40, justifyContent: 'center', paddingHorizontal: theme.base.space[1] },
  // Montado e sem altura: com display none o Fabric desmonta o campo nativo e ele perde o foco.
  hidden: { height: 0, paddingVertical: 0, opacity: 0 },
  recordingWrap: { minHeight: 92 },
  wave: { justifyContent: 'center', paddingHorizontal: theme.base.space[1] },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1.5] },
  spacer: { flex: 1, minWidth: 0 },
  iconBtn: { width: 34, height: 34, borderRadius: theme.base.radius.full, alignItems: 'center', justifyContent: 'center' },
  recordingBtn: { width: 44, height: 44 },
  pressed: { backgroundColor: theme.tokens.bg.hover },
  disabled: { opacity: 0.5 },
  roundBtn: { width: 34, height: 34, borderRadius: theme.base.radius.full, alignItems: 'center', justifyContent: 'center' },
  queueBadge: { position: 'absolute', top: 0, right: 0, minWidth: 15, height: 15, paddingHorizontal: theme.base.space[0.5], borderRadius: theme.base.radius.sm, alignItems: 'center', justifyContent: 'center' },
  queueBadgeText: { fontSize: theme.base.text.xxxs, fontWeight: theme.base.weight.bold, lineHeight: 13 },
  sendPressed: { opacity: 0.8 },
}));
