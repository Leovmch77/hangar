import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import type { Credencial, LiveVoiceState, LiveVoiceSettings, LiveVoiceSettingsReply, ModelOption, Server, VoiceMemory } from '@hangar/core';
import { liveVoiceSpeaker, liveVoiceStatus, liveVoiceThoughtTail } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { Icon } from '../../ui/Icon';
import { mkMarkdownStyle } from '../../chat/AssistantBubble';
import { Segmented } from '../config/Segmented';
import { QuietPill } from '../create/QuietPill';
import * as m from '../../paraglide/messages';

export interface LiveVoiceView {
  phase: 'idle' | 'connecting' | 'live' | 'closed';
  serverLabel: string;
  state: LiveVoiceState | null;
  error: { code: string; detail?: string } | null;
  muted: boolean;
  dictating?: boolean;
  levels: { input: number; output: number };
  liveSince: number | null;
  settings: {
    loading: boolean;
    reply: LiveVoiceSettingsReply | null;
    error: string | null;
    saving: boolean;
    saveError: string | null;
    accounts: Credencial[];
    models: ModelOption[];
    modelsError: string | null;
  };
  memory: { loading: boolean; entries: VoiceMemory[]; error: string | null; forgetError: string | null };
}

export interface LiveVoiceSheetProps {
  open: boolean;
  view: LiveVoiceView;
  servers: Pick<Server, 'id' | 'label'>[];
  serverId: string | null;
  onSelectServer: (serverId: string) => void;
  onDismiss: () => void;
  onStart: () => void;
  onStop: () => void;
  onToggleMute: () => void;
  onMode: (mode: 'direto' | 'planejar') => void;
  onRetry: () => void;
  onSaveSettings: (next: LiveVoiceSettings) => void;
  onSettingsOpen: () => void;
  onForgetMemory: (id: string) => void;
}

type Mode = 'direct' | 'plan';
type Choice = { value: string | null; label: string };
const MODES: Mode[] = ['direct', 'plan'];
const ERRORS: Record<string, () => string> = {
  disabled: m.live_voice_error_disabled,
  codex_missing: m.live_voice_error_codex_missing,
  account_missing: m.live_voice_error_account_missing,
  unknown_account: m.live_voice_error_account_missing,
  connection_lost: m.live_voice_error_connection_lost,
  microphone: m.native_live_voice_error_microphone,
  playback: m.native_live_voice_error_playback,
  notifications_permission: m.native_live_voice_error_notifications_permission,
  audio_interrupted: m.native_live_voice_error_audio_interrupted,
  focus_lost: m.native_live_voice_error_focus_lost,
  foreground_required: m.native_live_voice_error_foreground_required,
  dictation_active: m.native_live_voice_error_dictation_active,
  audio_levels_unavailable: m.native_live_voice_error_audio_levels_unavailable,
  audio_restore: m.native_live_voice_error_audio_restore,
  opening_timeout: m.native_live_voice_error_opening_timeout,
  timeout: m.live_voice_error_timeout,
  taken: m.live_voice_taken,
};
const MEMORY_KINDS: Record<VoiceMemory['kind'], () => string> = {
  pessoa: m.live_voice_memory_kind_pessoa, preferencia: m.live_voice_memory_kind_preferencia,
  referencia: m.live_voice_memory_kind_referencia, projeto: m.live_voice_memory_kind_projeto,
};
const modeLabel = (mode: Mode) => mode === 'direct' ? m.live_voice_mode_direct() : m.live_voice_mode_plan();
const tierLabel = (tier: string | null) => tier === 'priority' ? m.live_voice_tier_fast()
  : tier === 'default' ? m.live_voice_tier_standard() : tier ?? m.native_live_voice_not_reported();
const percent = (window: { used_percent: number } | null) => window ? `${Math.round(window.used_percent)}%` : m.native_live_voice_not_reported();

const STATUS: Record<ReturnType<typeof liveVoiceStatus>, () => string> = {
  connecting: m.live_voice_connecting, voice: m.live_voice_status_voice, muted: m.codex_voice_muted,
  you: m.live_voice_status_you, thinking: m.live_voice_status_thinking, searching: m.live_voice_status_searching,
  working: m.live_voice_status_working, listening: m.codex_voice_listening,
};
function statusLabel(view: LiveVoiceView): string {
  const muted = view.muted || !!view.dictating;
  const speaker = liveVoiceSpeaker(view.levels.input, view.levels.output, muted);
  return STATUS[liveVoiceStatus(view.phase === 'live', speaker, muted, view.state?.activity)]();
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.section}><Text accessibilityRole="header" style={styles.label}>{title}</Text>{children}</View>;
}

function Action({ title, onPress, danger = false, selected = false, disabled = false }: {
  title: string; onPress: () => void; danger?: boolean; selected?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title}
      accessibilityState={{ selected, disabled }} style={[styles.action, selected && styles.selected, disabled && styles.disabled]}>
      <Text style={[styles.actionText, danger && styles.danger]}>{title}</Text>
    </Pressable>
  );
}

function MenuField({ title, context, value, choices, disabled, onChange }: {
  title: string; context?: string; value: string | null; choices: Choice[]; disabled: boolean; onChange: (value: string | null) => void;
}) {
  // Um catálogo incompleto não pode esconder nem substituir a escolha guardada no servidor.
  const options = choices.some(c => c.value === value) ? choices
    : [{ value, label: value || m.live_voice_default() }, ...choices];
  return (
    <View style={styles.field}>
      <Text style={styles.detail}>{title}</Text>
      <QuietPill label={options.find(c => c.value === value)!.label} aria={context ? `${context}: ${title}` : title}
        menuTitle={context ? `${context}: ${title}` : title} disabled={disabled}
        actions={options.map((choice, i) => ({ id: String(i), title: choice.label, state: choice.value === value ? 'on' : 'off' }))}
        onAction={id => { const choice = options.find((_, i) => String(i) === id); if (!disabled && choice) onChange(choice.value); }} />
    </View>
  );
}

function Level({ title, value }: { title: string; value: number }) {
  const level = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return (
    <View style={styles.level}>
      <Text style={styles.detail}>{title}</Text>
      <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={[styles.fill, { width: `${level * 100}%` }]} />
      </View>
    </View>
  );
}

export function LiveVoiceSheet({ open, view, servers, serverId, onSelectServer, onDismiss, onStart, onStop, onToggleMute, onMode, onRetry,
  onSaveSettings, onSettingsOpen, onForgetMemory }: LiveVoiceSheetProps) {
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const markdownStyle = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const [now, setNow] = useState(Date.now);
  const inCall = view.phase === 'connecting' || view.phase === 'live';
  const { settings, memory, state } = view;
  const reply = settings.reply;
  const disabled = settings.saving || settings.loading;
  const seconds = view.liveSince === null ? 0 : Math.max(0, Math.floor((now - view.liveSince) / 1000));
  const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const thought = state?.activity && state.activity !== 'idle' ? liveVoiceThoughtTail(state.thought ?? '') : [];
  const muted = view.muted || !!view.dictating;

  useEffect(() => {
    if (!open || view.phase !== 'live') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, view.phase, view.liveSince]);
  useEffect(() => { setSettingsOpen(false); }, [open, serverId]);
  useEffect(() => { setServerPickerOpen(false); }, [open, serverId, inCall]);
  useEffect(() => { if (serverPickerOpen) scroll.current?.scrollTo({ y: 0, animated: false }); }, [serverPickerOpen]);

  const save = (next: LiveVoiceSettings) => { if (!disabled) onSaveSettings(next); };
  const savePair = (mode: Mode, field: 'model' | 'effort' | 'tier', value: string | null) => {
    if (!reply || field === 'effort' && value === null) return;
    const current = reply.settings.organizer[mode];
    const model = field === 'model' ? settings.models.find(item => item.id === value) : undefined;
    const efforts = model?.efforts;
    const effort = efforts?.length && !efforts.includes(current.effort)
      ? model?.default_effort && efforts.includes(model.default_effort) ? model.default_effort : efforts[0] ?? current.effort
      : current.effort;
    save({ ...reply.settings, organizer: { ...reply.settings.organizer,
      [mode]: { ...current, effort, [field]: value } } });
  };
  const expandSettings = () => {
    if (!settingsOpen) onSettingsOpen();
    setSettingsOpen(!settingsOpen);
  };

  return (
    <Sheet open={open} sizes={['large']} onDismiss={onDismiss} scrollable>
      <View style={[styles.wrap, { height: height * 0.84 }]}>
        <View style={styles.header}>
          <View style={styles.heading}>
            <Text style={styles.title} accessibilityRole="header">{m.live_voice_open()}</Text>
            {servers.length > 0 ? <View style={styles.field}>
              <Text style={styles.detail}>{m.live_voice_server()}</Text>
              <QuietPill label={view.serverLabel} aria={m.live_voice_server()} disabled={inCall}
                onPress={() => { if (!inCall) setServerPickerOpen(!serverPickerOpen); }} />
            </View> : <Text style={styles.detail} selectable>{m.live_voice_server()}: {view.serverLabel}</Text>}
          </View>
          <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={m.native_live_voice_close()}
            style={styles.close}><Icon name="X" size={22} /></Pressable>
        </View>
        {inCall ? (
          <>
            <View style={styles.row}>
              <Text style={styles.status}>{statusLabel(view)}</Text>
              {view.phase === 'live' ? <Text style={styles.time}>{elapsed}</Text> : <ActivityIndicator size="small" color={theme.tokens.accent.base} />}
            </View>
            <View style={styles.row}>
              <Action title={view.dictating ? m.native_live_voice_dictation_hold_short() : muted ? m.live_voice_unmute() : m.live_voice_mute()}
                onPress={onToggleMute} selected={muted} disabled={!!view.dictating} />
              <Action title={m.live_voice_stop()} onPress={onStop} danger />
            </View>
            {state && state.mode !== null ? <Segmented label={m.native_live_voice_mode()} value={state.mode}
              options={MODES.map(mode => ({ v: mode, label: modeLabel(mode) }))}
              onChange={mode => onMode(mode === 'direct' ? 'direto' : 'planejar')} /> : null}
          </>
        ) : null}
        <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {serverPickerOpen ? <View accessibilityRole="radiogroup" accessibilityLabel={m.live_voice_server()}>
            {servers.map(server => <Pressable key={server.id} disabled={inCall}
              onPress={() => { if (!inCall) { setServerPickerOpen(false); onSelectServer(server.id); } }}
              accessibilityRole="radio" accessibilityLabel={server.label}
              accessibilityState={{ selected: server.id === serverId, disabled: inCall }} style={styles.serverItem}>
              <Text style={[styles.serverName, { fontWeight: server.id === serverId ? '700' : '500' }]} numberOfLines={1}>{server.label}</Text>
              {server.id === serverId ? <Icon name="Check" size={16} color={theme.tokens.accent.base} /> : null}
            </Pressable>)}
          </View> : null}
          {inCall && view.dictating ? <Text style={styles.detail}>{m.native_live_voice_dictation_hold()}</Text> : null}
          {view.error ? (
            <View style={styles.section}>
              <Text style={styles.danger} accessibilityRole="alert">{(ERRORS[view.error.code] ?? m.live_voice_error_failed)()}</Text>
              {view.error.detail ? <Text selectable style={styles.detail}>{view.error.detail}</Text> : null}
              <Action title={m.sync_retry()} onPress={onRetry} />
            </View>
          ) : null}
          {reply && settings.error ? (
            <View style={styles.section}>
              <Text selectable style={styles.danger} accessibilityRole="alert">{settings.error}</Text>
              <Action title={m.sync_retry()} onPress={onRetry} />
            </View>
          ) : null}
          {!inCall ? settings.loading && !reply ? (
            <View style={styles.row}><ActivityIndicator color={theme.tokens.accent.base} /><Text style={styles.detail}>{m.comum_carregando()}</Text></View>
          ) : !reply ? (
            <View style={styles.section}>
              <Text style={styles.danger} accessibilityRole="alert">{m.live_voice_error_failed()}</Text>
              {settings.error ? <Text selectable style={styles.detail}>{settings.error}</Text> : null}
              {!view.error ? <Action title={m.sync_retry()} onPress={onRetry} /> : null}
            </View>
          ) : !reply.codex ? <Text style={styles.danger}>{m.live_voice_error_codex_missing()}</Text>
            : !reply.enabled ? <Text style={styles.danger}>{m.live_voice_error_no_account()}</Text>
              : <Action title={m.live_voice_start()} onPress={onStart} /> : null}
          {inCall ? (
            <View style={styles.row}>
              <Level title={m.native_live_voice_input_level()} value={muted ? 0 : view.levels.input} />
              <Level title={m.native_live_voice_output_level()} value={view.levels.output} />
            </View>
          ) : null}
          {state?.error ? <Text selectable style={styles.danger} accessibilityRole="alert">{state.error.text}</Text> : null}
          {state?.activity && state.activity !== 'idle' && (state.action || state.progress || thought.length > 0) ? (
            <View style={styles.section}>
              {state.action ? <Text selectable style={styles.activity}>{state.action.text}</Text> : null}
              {state.progress ? <Text selectable style={styles.text}>{state.progress}</Text> : null}
              {thought.map((line, i) => <Text key={i} selectable style={styles.detail}>{line}</Text>)}
            </View>
          ) : null}
          {state?.draft ? <Section title={m.live_voice_draft()}><Text selectable style={styles.text}>{state.draft}</Text></Section> : null}
          {state?.backstage.length ? <Section title={m.live_voice_backstage()}>
            {state.backstage.slice(-6).map((line, i) => <Text key={i} selectable style={line.kind === 'heard' ? styles.text : styles.detail}>{line.text}</Text>)}
          </Section> : null}
          {state?.plan ? <Section title={m.live_voice_plan()}>
            <EnrichedMarkdownText markdown={state.plan.markdown} markdownStyle={markdownStyle} flavor="github" />
          </Section> : null}
          {state?.followed.length ? <Section title={m.live_voice_followed()}>
            {state.followed.map(item => <Text key={`${item.server}::${item.name}`} selectable style={styles.detail}>
              {item.server ? `${item.server}::${item.name}` : item.name}
            </Text>)}
          </Section> : null}
          {state ? (
            <>
              <View style={styles.row}>
                <Text style={styles.detail}>{m.ctx_limite_5h()}: {percent(state.limits.five_hour)}</Text>
                <Text style={styles.detail}>{m.ctx_limite_7d()}: {percent(state.limits.seven_day)}</Text>
              </View>
              <Section title={m.native_live_voice_effective()}>
                <Text selectable style={styles.detail}>{m.live_voice_model()}: {state.effective?.model ?? m.native_live_voice_not_reported()}</Text>
                <Text selectable style={styles.detail}>{m.live_voice_effort()}: {state.effective?.effort ?? m.native_live_voice_not_reported()}</Text>
                <Text selectable style={styles.detail}>{m.live_voice_tier()}: {tierLabel(state.effective?.tier ?? null)}</Text>
              </Section>
            </>
          ) : null}
          <Pressable onPress={expandSettings} accessibilityRole="button" accessibilityLabel={m.native_live_voice_settings_memory()}
            accessibilityState={{ expanded: settingsOpen }} style={styles.settingsToggle}>
            <Text style={styles.label}>{m.live_voice_settings()}</Text><Icon name={settingsOpen ? 'ChevronUp' : 'ChevronDown'} />
          </Pressable>
          {settingsOpen ? (
            <>
              <Action title={m.native_live_voice_reload_settings_memory()} onPress={onSettingsOpen} />
              {settings.loading ? <Text style={styles.detail}>{m.comum_carregando()}</Text> : null}
              {settings.error && !reply ? <Text selectable style={styles.danger} accessibilityRole="alert">{settings.error}</Text> : null}
              {reply ? (
                <View style={styles.section}>
                  <Text style={styles.detail}>{m.native_live_voice_next_call()}</Text>
                  <MenuField title={m.live_voice_account()} value={reply.settings.codex_account} disabled={disabled}
                    choices={settings.accounts.filter(c => c.tipo === 'codex').map(c => ({ value: c.codex_account ?? c.id, label: c.apelido || c.nome_natural || c.nome }))}
                    onChange={value => { if (value !== null) save({ ...reply.settings, codex_account: value }); }} />
                  {!settings.loading && !settings.accounts.some(c => c.tipo === 'codex') ? <Text style={styles.detail}>{m.native_live_voice_accounts_empty()}</Text> : null}
                  <MenuField title={m.live_voice_voice()} value={reply.settings.voice} disabled={disabled}
                    choices={[{ value: null, label: m.live_voice_default() }, ...reply.voices.map(value => ({ value, label: value }))]}
                    onChange={voice => save({ ...reply.settings, voice })} />
                  {settings.modelsError ? <>
                    <Text style={styles.danger} accessibilityRole="alert">{m.comum_falha_carregar_modelos()}</Text>
                    <Text selectable style={styles.detail}>{settings.modelsError}</Text>
                  </> : !settings.loading && settings.models.length === 0 ? <Text style={styles.detail}>{m.native_live_voice_models_empty()}</Text> : null}
                  {MODES.map(mode => {
                    const pair = reply.settings.organizer[mode];
                    const model = settings.models.find(item => item.id === pair.model);
                    const efforts = model ? model.efforts ?? [] : settings.models.reduce<string[] | null>((all, item) =>
                      all === null ? [...item.efforts ?? []] : all.filter(effort => item.efforts?.includes(effort)), null) ?? [];
                    return (
                      <Section key={mode} title={modeLabel(mode)}>
                        <MenuField title={m.live_voice_model()} context={modeLabel(mode)} value={pair.model} disabled={disabled}
                          choices={[{ value: null, label: m.live_voice_default() }, ...settings.models.map(item => ({ value: item.id, label: item.name ?? item.id }))]}
                          onChange={value => savePair(mode, 'model', value)} />
                        <MenuField title={m.live_voice_effort()} context={modeLabel(mode)} value={pair.effort} disabled={disabled}
                          choices={efforts.map(value => ({ value, label: value }))} onChange={value => savePair(mode, 'effort', value)} />
                        <MenuField title={m.live_voice_tier()} context={modeLabel(mode)} value={pair.tier} disabled={disabled}
                          choices={[{ value: null, label: m.live_voice_default() }, { value: 'default', label: m.live_voice_tier_standard() },
                            { value: 'priority', label: m.live_voice_tier_fast() }]} onChange={value => savePair(mode, 'tier', value)} />
                      </Section>
                    );
                  })}
                </View>
              ) : null}
              {settings.saving ? <Text style={styles.detail}>{m.native_live_voice_saving()}</Text> : null}
              {settings.saveError ? <Text selectable style={styles.danger} accessibilityRole="alert">{settings.saveError}</Text> : null}
              <Section title={m.live_voice_memory_title()}>
                {memory.loading ? <Text style={styles.detail}>{m.comum_carregando()}</Text> : null}
                {memory.error ? <>
                  <Text style={styles.danger} accessibilityRole="alert">{m.live_voice_memory_error()}</Text>
                  <Text selectable style={styles.detail}>{memory.error}</Text>
                </> : null}
                {memory.forgetError ? <>
                  <Text style={styles.danger} accessibilityRole="alert">{m.live_voice_memory_forget_failed()}</Text>
                  <Text selectable style={styles.detail}>{memory.forgetError}</Text>
                </> : null}
                {!memory.loading && !memory.error && memory.entries.length === 0 ? <Text style={styles.detail}>{m.live_voice_memory_empty()}</Text> : null}
                {memory.entries.map(entry => (
                  <View key={entry.id} style={styles.row}>
                    <View style={styles.heading}>
                      <Text style={styles.label}>{(MEMORY_KINDS[entry.kind] ?? (() => entry.kind))()}</Text>
                      <Text selectable style={styles.text}>{entry.text}</Text>
                      {entry.kind === 'projeto' ? <Text selectable style={styles.detail}>{entry.confirmed}</Text> : null}
                    </View>
                    <Pressable onPress={() => onForgetMemory(entry.id)} accessibilityRole="button"
                      accessibilityLabel={m.live_voice_memory_forget({ text: entry.text })} style={styles.close}>
                      <Icon name="Trash2" size={20} />
                    </Pressable>
                  </View>
                ))}
              </Section>
            </>
          ) : null}
        </ScrollView>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { padding: theme.base.space[4], gap: theme.base.space[3] },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2] },
  heading: { flex: 1, gap: theme.base.space[1] },
  title: { fontSize: theme.base.text.lg, fontWeight: theme.base.weight.semibold, color: theme.tokens.text.primary },
  label: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.semibold, color: theme.tokens.text.secondary },
  text: { fontSize: theme.base.text.sm, color: theme.tokens.text.primary, lineHeight: 23 },
  detail: { fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
  status: { flex: 1, fontSize: theme.base.text.sm, color: theme.tokens.accent.base },
  time: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3] },
  section: { gap: theme.base.space[2] },
  scroll: { flex: 1 },
  serverItem: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3], minHeight: 48,
    paddingHorizontal: theme.base.space[2], borderRadius: theme.base.radius.md },
  serverName: { flex: 1, fontSize: theme.base.text.base, color: theme.tokens.text.primary },
  content: { gap: theme.base.space[4], paddingBottom: theme.base.space[4] },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  action: { flexGrow: 1, minHeight: 44, paddingHorizontal: theme.base.space[3], paddingVertical: theme.base.space[2],
    borderWidth: 1, borderColor: theme.tokens.border.default, borderRadius: theme.base.radius.md, alignItems: 'center', justifyContent: 'center' },
  actionText: { fontSize: theme.base.text.sm, color: theme.tokens.text.primary },
  selected: { borderColor: theme.tokens.accent.base, backgroundColor: theme.tokens.accent.dim },
  disabled: { opacity: 0.5 },
  danger: { fontSize: theme.base.text.sm, color: theme.tokens.status.error },
  activity: { fontSize: theme.base.text.sm, color: theme.tokens.status.warning },
  settingsToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderTopWidth: 1, borderColor: theme.tokens.border.subtle, paddingTop: theme.base.space[2] },
  field: { minHeight: 48, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
    columnGap: theme.base.space[3], rowGap: theme.base.space[2], paddingVertical: theme.base.space[2] },
  level: { flex: 1, gap: theme.base.space[1] },
  track: { height: 4, borderRadius: theme.base.radius.full, backgroundColor: theme.tokens.border.subtle, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: theme.tokens.accent.base },
}));
