import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ReactNode } from 'react';
import { Sheet } from '../../ui/Sheet';
import { PageHeader } from '../config/PageHeader';
import { useSettingsColors } from '../config/colors';
import { ensureActive, reason, type Directions } from './api';
import * as m from '../../paraglide/messages';

export function MachineSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <Sheet open sizes={['large']} scrollable onDismiss={onClose}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
      <PageHeader title={title} actions={[{ label: m.sessao_fechar(), onPress: onClose }]} />
      {children}
    </ScrollView>
  </Sheet>;
}
export function ConnectionDot({ label, loaded, error }: { label: string; loaded: boolean; error?: string | null }) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  const status = error ? error === 'offline' ? m.mobile_machines_offline() : error : loaded ? m.mobile_machines_connected() : '';
  return <View accessible accessibilityLabel={status ? `${label}, ${status}` : label}
    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: error ? theme.tokens.status.error : loaded ? theme.tokens.status.success : c.faint }} />;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useSettingsColors();
  return <View style={styles.field}>
    <Text style={{ color: c.text }}>{label}</Text>
    <TextInput autoCapitalize="none" autoCorrect={false} {...props} accessibilityLabel={label}
      placeholderTextColor={c.faint} style={[styles.input, { color: c.text, borderColor: c.borderStrong, backgroundColor: c.inset }]} />
  </View>;
}
export function Notice({ text, error = false }: { text: string; error?: boolean }) {
  const c = useSettingsColors();
  return text ? <Text accessibilityRole={error ? 'alert' : undefined} accessibilityLiveRegion="polite" style={{ color: c.text }}>{text}</Text> : null;
}

export function DirectionsNotice({ value }: { value: Directions }) {
  return <View style={styles.field}>{(['forward', 'back'] as const).map((direction) => {
    const check = value[direction];
    const error = direction === 'forward' ? value.forwardError : value.backError;
    const title = direction === 'forward' ? m.mobile_machines_forward() : m.mobile_machines_back();
    const text = check ? `${check.estado} · ${check.identificador || '—'}${check.tempo_ms === null ? '' : ` · ${check.tempo_ms} ms`}${check.motivo ? ` · ${check.motivo}` : ''}${error ? ` · ${error}` : ''}` : error || '—';
    return <Notice key={direction} text={`${title}: ${text}`} error={!!error || (!!check && check.estado !== 'ok')} />;
  })}</View>;
}

// Cada abertura tem seu sinal: resposta antiga não pode salvar nem pintar a máquina seguinte.
export function useMachineAction() {
  const controller = useRef(new AbortController());
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (controller.current.signal.aborted) {
      controller.current = new AbortController();
      locked.current = false;
    }
    const current = controller.current;
    return () => current.abort();
  }, []);
  const run = useCallback(async <T,>(work: (signal: AbortSignal) => Promise<T>, commit: (value: T) => void, done = '') => {
    const signal = controller.current.signal;
    if (locked.current || signal.aborted) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const value = await work(signal);
      ensureActive(signal);
      commit(value); setMessage(done);
    } catch (e) { if (!signal.aborted) setError(reason(e)); }
    finally { if (!signal.aborted) { locked.current = false; setBusy(false); } }
  }, []);
  return { busy, error, message, run };
}
export const styles = StyleSheet.create({
  sheet: { padding: 16, gap: 16 },
  field: { gap: 8, paddingVertical: 8 },
  input: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderRadius: 8, fontSize: 15 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 8 },
  content: { padding: 16, gap: 12 },
});
