import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { mergeImportedMachines, parseMachineImportPayload, type MachineImportResult } from '@hangar/core';
import { useServers } from '../src/stores/servers';
import { discoverSavedMachines, importMachines, machineImportIssueMessage } from '../src/features/machines/importMachines';
import { PageHeader, Pill } from '../src/features/config/PageHeader';
import { SectionCard } from '../src/features/config/SectionCard';
import { InfoNotice } from '../src/features/config/InfoNotice';
import { useSettingsColors } from '../src/features/config/colors';
import { Screen } from '../src/ui/Screen';
import { toast } from '../src/ui/Toast';
import * as m from '../src/paraglide/messages';

export default function ImportMachinesRoute() {
  const params = useLocalSearchParams<{ '#': string | string[] }>();
  const payload = typeof params['#'] === 'string' ? params['#'] : '';
  return <ImportMachines key={payload} payload={payload} />;
}

function ImportMachines({ payload }: { payload: string }) {
  const router = useRouter();
  const c = useSettingsColors();
  const servers = useServers((s) => s.servers);
  const ready = useServers((s) => s.ready);
  const vaultReadable = useServers((s) => s.vaultReadable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MachineImportResult | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const parsed = useMemo(() => {
    try { return { servers: parseMachineImportPayload(payload), invalid: false }; }
    catch { return { servers: [], invalid: true }; }
  }, [payload]);
  const fresh = mergeImportedMachines({ servers, activeId: null }, parsed.servers).added;
  const freshUrls = new Set(fresh.map((s) => s.baseUrl));
  const saved = parsed.servers.filter((s) => !freshUrls.has(s.baseUrl));

  const run = async () => {
    if (locked.current || !vaultReadable || !fresh.length) return;
    locked.current = true; setBusy(true); setError(''); setResult(null);
    try {
      const imported = await importMachines(fresh);
      if (imported.added.length) void discoverSavedMachines();
      if (!mounted.current) return;
      setResult(imported);
      if (!imported.issues.length) {
        toast.ok(imported.added.length ? m.machine_import_success({ count: imported.added.length }) : m.machine_import_empty());
        router.replace('/');
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.message === 'machine_import_vault_unread'
        ? m.servers_warning_vault_unread() : m.mobile_machines_invalid_response());
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <Screen>
    <ScrollView contentContainerStyle={styles.content}>
      <PageHeader title={m.machine_import_title()} subtitle={m.machine_import_help()}
        actions={[{ label: m.comum_cancelar(), disabled: busy, onPress: () => router.replace(servers.length ? '/' : '/login') }]} />
      {!ready ? <InfoNotice text={m.comum_carregando()} /> : parsed.invalid ? (
        <Text accessibilityRole="alert" style={{ color: c.text }}>{m.machine_import_invalid()}</Text>
      ) : <>
        {!vaultReadable ? <>
          <Text accessibilityRole="alert" style={{ color: c.text }}>{m.servers_warning_vault_unread()}</Text>
          <Pill label={m.mobile_machines_retry()} onPress={() => { void useServers.getState().load(); }} />
        </> : null}
        {busy ? <InfoNotice text={m.machine_import_verifying()} /> : null}
        {!fresh.length && !busy && !result?.added.length ? <InfoNotice text={m.machine_import_empty()} /> : null}
        {fresh.length ? <SectionCard icon="Plus" title={m.machine_import_new()}>
          {fresh.map((s) => <View key={s.baseUrl} style={styles.row}>
            <Text style={{ color: c.text }}>{s.label}</Text><Text style={{ color: c.muted }}>{s.baseUrl}</Text>
          </View>)}
        </SectionCard> : null}
        {saved.length ? <SectionCard icon="Check" title={m.machine_import_saved()}>
          {saved.map((s) => <View key={s.baseUrl} style={styles.row}>
            <Text style={{ color: c.text }}>{s.label}</Text><Text style={{ color: c.muted }}>{s.baseUrl}</Text>
          </View>)}
        </SectionCard> : null}
        {error ? <Text accessibilityRole="alert" style={{ color: c.text }}>{error}</Text> : null}
        {result?.issues.map((issue, index) => <Text key={index} accessibilityRole="alert" style={{ color: c.text }}>{machineImportIssueMessage(issue)}</Text>)}
        {result?.added.length ? <Text accessibilityLiveRegion="polite" style={{ color: c.text }}>{m.machine_import_success({ count: result.added.length })}</Text> : null}
        <Pill label={busy ? m.machine_import_verifying() : m.machine_import_action()} disabled={busy || !vaultReadable || !fresh.length} onPress={run} />
      </>}
      {ready && servers.length ? <Pill label={m.machine_import_conversations()} disabled={busy} onPress={() => router.replace('/')} /> : null}
    </ScrollView>
  </Screen>;
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  row: { padding: 16, gap: 6 },
});
