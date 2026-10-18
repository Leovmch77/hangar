import { memo, useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View, type ListRenderItemInfo } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { formatElapsed, formataErro, getOrqForServer, retentarAgora, type OrqExecucao, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { Screen } from '../../ui/Screen';
import { Icon } from '../../ui/Icon';
import { OrchestrationContent, OrchestrationHeader, OrchestrationStatus, orqWhen, useOrchestrationPanel } from './OrchestrationPanel';
import * as m from '../../paraglide/messages';

type HistoryRow = { run: OrqExecucao; key: string };
const screenOptions = { headerShown: false };
const titleOf = (run: OrqExecucao) => run.metadata?.title.trim() || run.plano.trim() || run.id;
const keyOf = (item: HistoryRow) => item.key;
const HistoryRun = memo(function HistoryRun({ run, onSelect }: { run: OrqExecucao; onSelect: (id: string) => void }) {
  const title = titleOf(run);
  const seconds = run.inicio && run.fim ? (Date.parse(run.fim) - Date.parse(run.inicio)) / 1000 : null;
  const status = !run.fim ? m.orq_em_curso() : run.resultado === 'abortada' ? m.orq_abortada() : !run.resultado || ['ok', 'concluido', 'concluida'].includes(run.resultado) ? m.orq_concluida() : run.resultado;
  const summary = `${orqWhen(run.inicio)} · ${m.orq_history_tasks({ n: run.metadata?.total_tasks ?? run.tasks.length })} · ${formatElapsed(seconds)} · ${status}`;
  return <Pressable style={styles.run} accessibilityRole="button" accessibilityLabel={[title, run.metadata?.repo, summary, run.metadata?.error && m.orq_mobile_metadata_read_error(), run.metadata?.error].filter(Boolean).join(', ')} onPress={() => onSelect(run.id)}>
    <Text style={styles.title}>{title}</Text>
    {run.metadata?.repo ? <Text style={styles.note}>{run.metadata.repo}</Text> : null}
    <Text style={styles.note}>{summary}</Text>
    {run.metadata?.error ? <><Text style={styles.error}>{m.orq_mobile_metadata_read_error()}</Text><Text style={styles.note}>{run.metadata.error}</Text></> : null}
  </Pressable>;
});

function HistoryDetail({ serverId, runId, onBack }: { serverId: string; runId: string; onBack: () => void }) {
  const { server, panel, error, refresh } = useOrchestrationPanel(serverId, runId, true);
  return <>
    <View style={styles.controls}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={m.orq_history_back()} style={styles.refresh}><Text style={styles.action}>{m.orq_history_back()}</Text></Pressable>
      {server && !server.invite ? <Pressable onPress={refresh} accessibilityRole="button" accessibilityLabel={m.orq_history_refresh()} style={styles.refresh}><Text style={styles.action}>{m.orq_history_refresh()}</Text></Pressable> : null}
    </View>
    {error || !panel ? <OrchestrationStatus error={error} retry={server && !server.invite ? refresh : undefined} /> : null}
    {panel ? <OrchestrationContent key={panel.run} panel={panel} history /> : null}
  </>;
}

export function OrchestrationHistory() {
  const params = useLocalSearchParams<{ server?: string }>();
  const ready = useServers(state => state.ready);
  const [serverId, setServerId] = useState<string | null>(() => (Array.isArray(params.server) ? params.server[0] : params.server) ?? (ready ? useServers.getState().activeId ?? '' : null));
  useEffect(() => { if (ready && serverId === null) setServerId(useServers.getState().activeId ?? ''); }, [ready, serverId]);
  const server = useServers(state => state.servers.find(item => item.id === serverId && !item.removed) ?? null);
  const focused = useIsFocused();
  const router = useRouter();
  const { theme } = useUnistyles();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ server: Server | null; runs: OrqExecucao[] | null; error: string | null }>({ server: null, runs: null, error: null });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!ready || !server || server.invite || !focused || selected) return;
    let current = true;
    setResult(previous => previous.server === server ? { ...previous, error: null } : { server, runs: null, error: null });
    getOrqForServer(server).then(
      data => { if (current) setResult({ server, runs: data.execucoes, error: null }); },
      error => { if (current) setResult(previous => ({ server, runs: previous.server === server ? previous.runs : null, error: formataErro(error) ?? String(error) })); },
    );
    return () => { current = false; };
  }, [ready, server, focused, selected, attempt]);
  const refresh = useCallback(() => { if (serverId) retentarAgora(serverId); setAttempt(value => value + 1); }, [serverId]);
  const renderRun = useCallback(({ item }: ListRenderItemInfo<HistoryRow>) => <HistoryRun run={item.run} onSelect={setSelected} />, []);
  const matches = result.server === server;
  const error = ready && serverId !== null && !server ? m.chat_servidor_removido() : server?.invite ? m.lista_acesso_recusado() : matches ? result.error : null;
  const runs = server && !server.invite && matches ? result.runs : null;
  return <Screen>
    <Stack.Screen options={screenOptions} />
    <OrchestrationHeader title={m.orq_history_title()} serverLabel={server?.label ?? serverId ?? undefined} onClose={() => router.back()} />
    {selected ? <HistoryDetail key={selected} serverId={serverId ?? ''} runId={selected} onBack={() => setSelected(null)} /> : <>
    {server && !server.invite ? <View style={styles.controls}><Pressable onPress={refresh} accessibilityRole="button" accessibilityLabel={m.orq_history_refresh()} style={styles.refresh}>
      <Icon name="RefreshCw" size={theme.base.text.base} color={theme.tokens.accent.base} /><Text style={styles.action}>{m.orq_history_refresh()}</Text>
    </Pressable></View> : null}
    {error || !runs ? <OrchestrationStatus error={error} retry={server && !server.invite ? refresh : undefined} /> : null}
    {runs ? <FlatList style={styles.list} data={runs.map((run, index) => ({ run, key: `${run.id}:${index}` }))} keyExtractor={keyOf} renderItem={renderRun} ListEmptyComponent={<Text style={styles.empty}>{m.orq_vazio()}</Text>} contentContainerStyle={styles.content} /> : null}
    </>}
  </Screen>;
}

const styles = StyleSheet.create(theme => ({
  list: { flex: 1, backgroundColor: 'transparent' },
  content: { paddingBottom: theme.base.space[6] },
  controls: { paddingHorizontal: theme.base.space[4], paddingBottom: theme.base.space[3], flexDirection: 'row', gap: theme.base.space[4] },
  refresh: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingVertical: theme.base.space[2] },
  action: { fontSize: theme.base.text.sm, color: theme.tokens.accent.base },
  run: { padding: theme.base.space[4], gap: theme.base.space[2] },
  title: { fontSize: theme.base.text.base, fontWeight: '600', color: theme.tokens.text.primary },
  note: { fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
  empty: { padding: theme.base.space[4], fontSize: theme.base.text.sm, color: theme.tokens.text.muted },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.warning },
}));
