import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { agruparSessoes, relativeTime, rotuloEstado } from '@hangar/core';
import { Sheet } from '../ui/Sheet';
import { HangarMark } from '../ui/HangarMark';
import { WorkingMark } from '../ui/WorkingMark';
import { Icon } from '../ui/Icon';
import { superficie } from '../theme/superficie';
import { useSessions } from '../stores/sessions';
import { placeOutside } from '../features/sessions/outsideRows';
import * as m from '../paraglide/messages';

// Trocar de sessão sem voltar pra lista. `replace` e não `push`: empilhar chats faria o voltar
// percorrer a fila de sessões visitadas em vez de sair do chat.
export function SessionPickerSheet({
  open,
  onClose,
  atual,
  serverId,
}: {
  open: boolean;
  onClose: () => void;
  atual: string;
  serverId: string;
}) {
  // O TrueSheet desenha os filhos mesmo fechado: a lista só existe da abertura até a folha sumir.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (!shown) return;
    return useSessions.getState().retain();
  }, [shown]);

  return (
    <Sheet open={open} sizes={['medium', 'large']} onDismiss={() => { setShown(false); onClose(); }} scrollable>
      {shown ? <PickerList onClose={onClose} atual={atual} serverId={serverId} /> : null}
    </Sheet>
  );
}

function PickerList({ onClose, atual, serverId }: { onClose: () => void; atual: string; serverId: string }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const rows = useSessions((s) => s.rows);
  const byServer = useSessions((s) => s.byServer);
  const loading = useSessions((s) => s.loading);
  const machineStatus = byServer.filter((bucket) => bucket.server.inviteEnded || bucket.error || !bucket.loaded);
  const effectiveLoading = byServer.length
    ? byServer.some((bucket) => !bucket.server.inviteEnded && !bucket.loaded && !bucket.error)
    : loading;
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const liveRows = useMemo(() => rows.filter((s) => s.state !== 'dead'), [rows]);
  const groups = useMemo(() => {
    const current = liveRows.find((s) => s.name === atual && s.serverId === serverId);
    const currentServer = current?.outside?.localServerId ?? serverId;
    const visible = search ? liveRows.filter((s) => s.name.toLowerCase().includes(search) || (s.cwd ?? '').toLowerCase().includes(search)) : liveRows;
    return placeOutside(
      agruparSessoes(visible.filter((s) => !s.outside), 'server'),
      visible.filter((s) => s.outside), 'server', liveRows,
    ).filter((group) => group.sessions.length)
      .sort((a, b) => Number(b.id === currentServer) - Number(a.id === currentServer) || a.label.localeCompare(b.label));
  }, [liveRows, atual, serverId, search]);

  return (
    <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.container}>
    <ScrollView style={styles.container}
      contentContainerStyle={[styles.inner, { paddingBottom: insets.bottom + theme.base.space[3] }]}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Text style={[styles.title, { color: theme.tokens.text.primary }]}>{m.sessao_trocar_de()}</Text>
      {liveRows.length > 8 || query ? <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={m.switcher_buscar_sessao()}
        accessibilityLabel={m.switcher_buscar_sessao()}
        placeholderTextColor={theme.tokens.text.muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.search, { color: theme.tokens.text.primary, backgroundColor: superficie(theme, 0.6) }]}
      /> : null}
      {machineStatus.map((bucket) => <Text key={bucket.server.id}
        accessibilityRole={bucket.error ? 'alert' : undefined}
        style={[styles.meta, { color: bucket.error ? theme.tokens.status.error : theme.tokens.text.muted }]}>
        {bucket.server.inviteEnded ? `${bucket.server.label}: ${m.convite_encerrado()}`
          : bucket.error === 'offline' ? m.lista_servidor_offline({ label: bucket.server.label })
          : `${bucket.server.label}: ${bucket.error || m.lista_carregando()}`}
      </Text>)}
      {effectiveLoading && !machineStatus.length ? <Text style={[styles.meta, { color: theme.tokens.text.muted }]}>{m.lista_carregando()}</Text> : null}
      {!groups.length && !effectiveLoading && machineStatus.every((bucket) => bucket.server.inviteEnded) ? <Text style={[styles.meta, { color: theme.tokens.text.muted }]}>
        {search ? m.lista_vazia_filtro() : m.lista_nenhuma_ativa()}
      </Text> : null}
      {groups.map((group) => <View key={group.id}>
        <Text accessibilityRole="header" style={[styles.servidor, { color: theme.tokens.text.muted }]}>{group.label}</Text>
        {group.sessions.map((s) => {
          const selected = s.name === atual && s.serverId === serverId;
          const stateLabel = rotuloEstado(s.state);
          const stateColor = theme.tokens.pill[s.state === 'awaiting_input' ? 'input' : s.state].fg;
          const engine = s.provider === 'claude' ? s.engine : null;
          const time = relativeTime(s.last_activity);
          return <Pressable
            key={`${s.serverId}::${s.name}`}
            onPress={() => {
              onClose();
              router.replace(`/s/${s.serverId}/${s.name}` as never);
            }}
            style={({ pressed }) => [styles.item, (selected || pressed) && { backgroundColor: superficie(theme, selected ? 0.8 : 0.6) }]}
            accessibilityRole="button"
            accessibilityLabel={`${s.name}, ${s.serverLabel}, ${stateLabel}${time ? `, ${time}` : ''}${engine ? `, ${engine}` : ''}${selected ? `, ${m.switcher_atual()}` : ''}`}
            disabled={selected}
            accessibilityState={{ selected, disabled: selected }}
          >
            {s.state === 'working' ? <WorkingMark size={20} color={stateColor} /> : <HangarMark size={20} color={stateColor} />}
            <View style={styles.col}>
              <View style={styles.line}>
                <Text style={[styles.nome, { color: theme.tokens.text.primary, fontWeight: selected ? '700' : '500' }]} numberOfLines={1}>{s.name}</Text>
                <Text style={[styles.time, { color: theme.tokens.text.muted }]} numberOfLines={1}>{time}</Text>
              </View>
              <View style={styles.line}>
                <Text style={[styles.meta, { color: stateColor }]} numberOfLines={1}>{stateLabel}</Text>
                {s.outside ? <Text style={[styles.meta, { color: theme.tokens.text.muted }]} numberOfLines={1}>{s.serverLabel}</Text> : null}
                {engine ? <View style={styles.engine}>
                  <Icon name="Settings" size={12} color={theme.tokens.accent.base} />
                  <Text style={[styles.meta, { color: theme.tokens.accent.base }]} numberOfLines={1}>{engine}</Text>
                </View> : null}
              </View>
            </View>
            {selected ? <Icon name="Check" size={18} color={theme.tokens.accent.base} /> : null}
          </Pressable>;
        })}
      </View>)}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  inner: { gap: theme.base.space[1], padding: theme.base.space[3] },
  title: { fontSize: theme.base.text.base, fontWeight: '600', marginBottom: theme.base.space[2] },
  search: { fontSize: theme.base.text.sm, minHeight: 44, paddingHorizontal: theme.base.space[3], borderRadius: theme.base.radius.md, marginBottom: theme.base.space[2] },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[3],
    minHeight: 48,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: theme.base.space[1],
    borderRadius: theme.base.radius.md,
  },
  col: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], minWidth: 0 },
  nome: { flex: 1, fontSize: theme.base.text.base },
  time: { fontSize: theme.base.text.xs, fontVariant: ['tabular-nums'], flexShrink: 0 },
  meta: { fontSize: theme.base.text.xs, flexShrink: 1 },
  engine: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1], flexShrink: 1, minWidth: 0 },
  servidor: { fontSize: theme.base.text.xs, maxWidth: 120 },
}));
