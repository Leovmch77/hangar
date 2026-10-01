import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getPushSettingsForServer, setQuietHoursForServer, type Server } from '@hangar/core';
import { Box, Chip, ConfigRow, Disclosure, Muted, RowShell, ServerConfigPage, useInputStyle } from '../../src/features/config/ServerConfigParts';
import { Pill } from '../../src/features/config/PageHeader';
import { useServerConfig } from '../../src/features/config/serverConfig';
import { useSettingsColors } from '../../src/features/config/colors';
import * as m from '../../src/paraglide/messages';

const KEYS = ['notify_finished', 'finish_min_seconds', 'notify_dead', 'stall_seconds'];

export default function Notifications() {
  const cfg = useServerConfig();
  return (
    <ServerConfigPage title={m.native_settings_page_notifications()} cfg={cfg} extra={cfg.server ? <QuietHours server={cfg.server} /> : null}>
      <Box>{KEYS.map((k) => <ConfigRow key={k} cfg={cfg} k={k} />)}</Box>
    </ServerConfigPage>
  );
}

const err = (e: unknown) => (e instanceof Error && e.message ? e.message : m.erro_desconhecido());

/** Horas silenciosas (`render_quiet` do Rust): leitura e Salvar próprios, fora do rascunho. */
function QuietHours({ server }: { server: Server }) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  const input = useInputStyle();
  const [values, setValues] = useState(['', '']);
  // Sem leitura boa não se edita nem salva: campo vazio de uma leitura que falhou desligaria a janela do servidor.
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [why, setWhy] = useState(false);
  const gen = useRef(0);

  const load = useCallback(() => {
    const g = ++gen.current;
    setLoading(true);
    setNote(null);
    getPushSettingsForServer(server)
      .then((r) => {
        if (g !== gen.current) return;
        setValues([r.quiet_hours?.start ?? '', r.quiet_hours?.end ?? '']);
        setConfirmed(true);
      })
      .catch((e: unknown) => {
        if (g !== gen.current) return;
        setConfirmed(false);
        setNote({ text: err(e), error: true });
      })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, [server]);

  useEffect(() => {
    load();
    return () => { gen.current++; };
  }, [load]);

  const busy = !confirmed || loading || saving;
  const save = () => {
    if (busy) return;
    const sent = [...values];
    const g = gen.current;
    setSaving(true);
    setNote(null);
    setQuietHoursForServer(server, sent[0] || null, sent[1] || null)
      .then(() => {
        if (g !== gen.current) return;
        setNote({ text: sent[0] && sent[1] ? m.native_server_quiet_on({ start: sent[0], end: sent[1] }) : m.native_server_quiet_off(), error: false });
      })
      // "horario invalido (use HH:MM)" chega como veio; o digitado fica nos campos.
      .catch((e: unknown) => { if (g === gen.current) setNote({ text: err(e), error: true }); })
      .finally(() => { if (g === gen.current) setSaving(false); });
  };
  const set = (i: number, t: string) => setValues((v) => v.map((x, j) => (j === i ? t.replace(/[^\d:]/g, '').slice(0, 5) : x)));

  return (
    <Box>
      <RowShell icon="Moon" title={m.native_server_quiet()} chips={<Chip text={m.native_server_scope()} />}>
        <View style={styles.line}>
          <Text style={[styles.help, { color: c.muted }]}>{m.native_server_quiet_verdict()}</Text>
          <Disclosure small open={why} label={m.native_accounts_engine_why()} onChange={setWhy} />
        </View>
        {why ? <Text style={[styles.help, { color: c.muted }]}>{m.native_server_quiet_why()}</Text> : null}
        {loading && !confirmed ? <Muted>{m.native_server_loading()}</Muted> : (
          <View style={styles.line}>
            <TextInput {...input} style={[input.style, styles.time]} accessibilityLabel={m.native_server_quiet_start()} placeholder="22:00"
              keyboardType="numbers-and-punctuation" editable={!busy} value={values[0]} onChangeText={(t) => set(0, t)} />
            <Text style={[styles.help, { color: c.muted }]}>{m.native_server_quiet_and()}</Text>
            <TextInput {...input} style={[input.style, styles.time]} accessibilityLabel={m.native_server_quiet_end()} placeholder="07:00"
              keyboardType="numbers-and-punctuation" editable={!busy} value={values[1]} onChangeText={(t) => set(1, t)} />
            <Pill label={saving ? m.native_server_saving() : m.native_server_save()} onPress={save} />
          </View>
        )}
        {note ? (
          <Text accessibilityRole={note.error ? 'alert' : undefined} accessibilityLiveRegion="polite"
            style={[styles.help, { color: note.error ? theme.tokens.status.error : theme.tokens.status.success }]}>{note.text}</Text>
        ) : null}
        {!confirmed && !loading ? <View style={styles.line}><Pill icon="RefreshCw" label={m.native_server_retry()} onPress={load} /></View> : null}
      </RowShell>
    </Box>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  help: { fontSize: 14, lineHeight: 18 },
  time: { width: 84, textAlign: 'center' },
});
