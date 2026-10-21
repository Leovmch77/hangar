import { useMemo } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseStatusLine } from '@hangar/core';
import { chatStore } from '../../stores/chat';
import { useSessions } from '../../stores/sessions';
import { composerStatus, usageWindows } from '../../chat/usage';
import { ActionsGrid } from './ActionsGrid';
import * as m from '../../paraglide/messages';

const clamp = (pct: number) => Math.min(100, Math.max(0, pct));

export function ContextTab({ serverId, name }: { serverId: string; name: string }) {
  const { theme } = useUnistyles();
  const statusLine = chatStore(serverId, name).use((s) => s.statusLine);
  const loading = chatStore(serverId, name).use((s) => s.stateEvent === null);
  const session = useSessions((s) => s.byServerRecord?.[serverId]?.find((item) => item.name === name)
    ?? s.rows.find((item) => item.serverId === serverId && item.name === name) ?? null);
  const fields = useMemo(() => parseStatusLine(statusLine, session), [statusLine, session]);
  const status = composerStatus(fields, session);
  const windows = usageWindows(fields);
  const pct = status.ctxPct;
  const tone = (value: number) => value >= 90 ? theme.tokens.status.error
    : value >= 70 ? theme.tokens.status.warning : theme.tokens.accent.base;
  const bar = (label: string, value: number) => (
    <View accessibilityRole="progressbar" accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamp(value)) }} style={styles.bar}>
      <View style={[styles.fill, { width: `${clamp(value)}%`, backgroundColor: tone(value) }]} />
    </View>
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.label} accessibilityRole="header">{m.ctx_contexto()}</Text>
        {pct != null ? <>
          <Text style={[styles.percent, { color: tone(pct) }]}>{Math.round(clamp(pct))}%</Text>
          {bar(m.ctx_uso_contexto(), pct)}
        </> : loading ? <ActivityIndicator color={theme.tokens.text.muted} accessibilityLabel={m.comum_carregando()} />
          : <Text style={styles.muted}>{m.tablet_context_empty()}</Text>}
      </View>

      {status.cost ? <View style={styles.row}>
        <Text style={styles.label}>{m.uso_custo()}</Text>
        <Text style={styles.value}>{status.cost}</Text>
      </View> : null}

      {windows.length ? <View style={styles.section}>
        <Text style={styles.label} accessibilityRole="header">{m.uso_secao_cota()}</Text>
        {windows.map((window) => <View key={window.key} style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>{window.label}</Text>
            <Text style={styles.value}>{Math.round(clamp(window.pct))}%</Text>
          </View>
          {bar(window.label, window.pct)}
          {window.reset ? <Text style={styles.muted}>{m.uso_reset({ quando: window.reset })}</Text> : null}
        </View>)}
      </View> : null}

      {status.folder || status.branch ? <View style={styles.section}>
        <Text style={styles.label} accessibilityRole="header">{m.uso_linha_projeto()}</Text>
        {status.folder ? <Text style={styles.value} selectable>{status.folder}</Text> : null}
        {status.branch ? <Text style={styles.muted} selectable>{status.branch}</Text> : null}
      </View> : null}

      <View style={styles.section}>
        <Text style={styles.label} accessibilityRole="header">{m.tablet_actions()}</Text>
        <ActionsGrid serverId={serverId} name={name} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  content: { padding: theme.base.space[4], gap: theme.base.space[5] },
  section: { gap: theme.base.space[2] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.base.space[3] },
  label: { fontSize: theme.base.text.xs, fontWeight: theme.base.weight.semibold, color: theme.tokens.text.secondary },
  percent: { fontSize: theme.base.text.xl * 2, fontWeight: theme.base.weight.bold },
  value: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.medium, color: theme.tokens.text.primary, flexShrink: 1 },
  muted: { fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
  bar: { height: 6, borderRadius: theme.base.radius.full, overflow: 'hidden', backgroundColor: theme.tokens.border.subtle },
  fill: { height: '100%', borderRadius: theme.base.radius.full },
}));
