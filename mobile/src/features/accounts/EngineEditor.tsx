import { useEffect, useRef, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { putEngineForServer, type Motor, type Server } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { PageHeader, Pill } from '../config/PageHeader';
import { SettingsRow } from '../config/SettingsRow';
import { useSettingsColors } from '../config/colors';
import * as m from '../../paraglide/messages';

const flags = ['bundled_skills', 'experimental_betas', 'prompt_caching', 'adaptive_thinking', 'tool_search',
  'gateway_model_discovery', 'fine_grained_tool_streaming', 'auth_via_api_key'] as const;
const numbers = ['context_window', 'auto_compact_window', 'max_output_tokens'] as const;
type Flag = typeof flags[number];
type NumberField = typeof numbers[number];
type TextField = 'name' | 'label' | 'base_url' | 'api_key' | 'model' | 'subagent_model' | NumberField;

export function EngineEditor({ server, name, engine, names, onSaved, onClose }: {
  server: Server; name?: string; engine?: Motor; names: string[]; onSaved: () => void; onClose: () => void;
}) {
  const c = useSettingsColors();
  const [text, setText] = useState<Record<TextField, string>>(() => ({
    name: name ?? '', label: engine?.label ?? name ?? '', base_url: engine?.base_url ?? '', api_key: '',
    model: engine?.model ?? '', subagent_model: engine?.subagent_model ?? '',
    context_window: engine?.context_window?.toString() ?? '', auto_compact_window: engine?.auto_compact_window?.toString() ?? '',
    max_output_tokens: engine?.max_output_tokens?.toString() ?? '',
  }));
  const [enabled, setEnabled] = useState<Record<Flag, boolean>>(() => Object.fromEntries(flags.map(flag => [flag,
    engine?.[flag] ?? (flag === 'prompt_caching' || flag === 'adaptive_thinking'),
  ])) as Record<Flag, boolean>);
  const [vision, setVision] = useState<boolean | null>(engine?.vision ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const alive = useRef(true);
  const identity = JSON.stringify([server.id, server.baseUrl, server.token]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => () => { alive.current = false; }, []);

  const labels: Record<TextField | Flag, string> = {
    name: m.mobile_accounts_engine_name(), label: m.mobile_accounts_engine_label(), base_url: m.mobile_accounts_engine_base_url(),
    api_key: m.mobile_accounts_engine_key(), model: m.mobile_accounts_engine_model(), subagent_model: m.mobile_accounts_engine_subagent_model(),
    context_window: m.mobile_accounts_engine_context_window(), auto_compact_window: m.mobile_accounts_engine_auto_compact_window(),
    max_output_tokens: m.mobile_accounts_engine_max_output_tokens(), bundled_skills: m.mobile_accounts_engine_bundled_skills(),
    experimental_betas: m.mobile_accounts_engine_experimental_betas(), prompt_caching: m.mobile_accounts_engine_prompt_caching(),
    adaptive_thinking: m.mobile_accounts_engine_adaptive_thinking(), tool_search: m.mobile_accounts_engine_tool_search(),
    gateway_model_discovery: m.mobile_accounts_engine_gateway_model_discovery(), fine_grained_tool_streaming: m.mobile_accounts_engine_fine_grained_tool_streaming(),
    auth_via_api_key: m.mobile_accounts_engine_auth_via_api_key(),
  };
  async function save() {
    if (saving.current || !alive.current) return;
    const value = Object.fromEntries(Object.entries(text).map(([key, value]) => [key, value.trim()])) as Record<TextField, string>;
    const id = name ?? value.name;
    if (!id || !value.label || !value.base_url || !value.model || (!engine?.api_key_definida && !value.api_key)) {
      setError(m.mobile_accounts_engine_required()); return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { setError(m.mobile_accounts_engine_bad_name()); return; }
    if (!name && names.includes(id)) { setError(m.mobile_accounts_engine_name_taken()); return; }
    try {
      const url = new URL(value.base_url);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    } catch { setError(m.mobile_accounts_engine_bad_url()); return; }
    if (numbers.some(key => value[key] && (!/^\d+$/.test(value[key]) || !Number.isSafeInteger(Number(value[key])) || Number(value[key]) <= 0))) {
      setError(m.mobile_accounts_engine_bad_number()); return;
    }
    const payload: Record<string, unknown> = { label: value.label, base_url: value.base_url, model: value.model,
      subagent_model: value.subagent_model, ...enabled };
    if (vision !== null) payload.vision = vision;
    for (const key of numbers) payload[key] = value[key] ? Number(value[key]) : '';
    if (value.api_key) payload.api_key = value.api_key;
    const target = server;
    const requestIdentity = identity;
    const valid = () => alive.current && currentIdentity.current === requestIdentity;
    saving.current = true; setBusy(true); setError('');
    try {
      await putEngineForServer(target, id, payload);
      if (valid()) onSaved();
    } catch (cause) {
      if (valid()) setError(cause instanceof Error ? cause.message : m.erro_desconhecido());
    } finally {
      saving.current = false;
      if (valid()) setBusy(false);
    }
  }
  const field = (key: TextField) => (
    <SettingsRow key={key} title={labels[key]}
      description={key === 'api_key' && engine?.api_key_definida ? m.mobile_accounts_engine_key_saved() : undefined}>
      <TextInput accessibilityLabel={labels[key]} value={text[key]} onChangeText={value => setText(prev => ({ ...prev, [key]: value }))}
        editable={!busy && !(key === 'name' && !!name)} secureTextEntry={key === 'api_key'}
        autoCapitalize="none" autoCorrect={false} keyboardType={numbers.includes(key as NumberField) ? 'number-pad' : key === 'base_url' ? 'url' : 'default'}
        placeholderTextColor={c.faint} style={[styles.input, { color: c.text, borderColor: c.borderStrong, backgroundColor: c.inset }]} />
    </SettingsRow>
  );
  return (
    <Sheet open sizes={['large']} scrollable dismissible={!busy} onDismiss={onClose}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <PageHeader title={name ? m.mobile_accounts_engine_edit() : m.mobile_accounts_engine_new()} subtitle={server.label}
          actions={[{ label: m.comum_cancelar(), disabled: busy, onPress: onClose }]} />
        {(['name', 'label', 'base_url', 'api_key', 'model', 'subagent_model', ...numbers] as TextField[]).map(field)}
        <View style={styles.actions}>
          {([null, true, false] as const).filter(value => value !== null || engine?.vision == null).map(value => <Pill key={String(value)}
            label={value == null ? m.mobile_accounts_engine_vision_auto() : value ? m.mobile_accounts_engine_vision_yes() : m.mobile_accounts_engine_vision_no()}
            disabled={busy || value === vision} onPress={() => setVision(value)} />)}
        </View>
        {flags.map(flag => <SettingsRow key={flag} title={labels[flag]}>
          <Switch accessibilityLabel={labels[flag]} value={enabled[flag]} disabled={busy}
            onValueChange={value => setEnabled(prev => ({ ...prev, [flag]: value }))} />
        </SettingsRow>)}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {busy ? <Text style={styles.muted}>{m.comum_carregando()}</Text> : null}
        <View style={styles.actions}><Pill label={m.mobile_accounts_engine_save()} disabled={busy} onPress={() => { void save(); }} /></View>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create(theme => ({
  body: { padding: 16, paddingBottom: 32, gap: 12 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  error: { color: theme.tokens.status.error, fontSize: 14 },
  muted: { color: theme.tokens.text.muted, fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
}));
