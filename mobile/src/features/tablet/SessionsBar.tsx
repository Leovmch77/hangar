import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { rotuloEstado, type AggSession } from '@hangar/core';
import { useTabletPrefs, type SessionsBarPlacement } from '../../stores/tabletPrefs';
import { useSessions } from '../../stores/sessions';
import { useServers } from '../../stores/servers';
import { useIdentities } from '../pair/identities';
import { SessionRow } from '../sessions/SessionRow';
import { SessionAvatar } from '../sessions/SessionAvatar';
import { Glass } from '../../ui/Glass';
import { Sheet } from '../../ui/Sheet';
import { Icon, type IconName } from '../../ui/Icon';
import { StateDot } from '../../ui/StateDot';
import { superficie } from '../../theme/superficie';
import { SessionChip } from './SessionChip';
import { barRows, type BarItem } from './barRows';
import * as m from '../../paraglide/messages';

type Props = { placement: SessionsBarPlacement; selected?: { serverId: string; name: string }; onPick(s: AggSession): void; onNew(): void };

const placements: { value: SessionsBarPlacement; label: () => string; icon: IconName }[] = [
  { value: 'left', label: () => m.tablet_bar_left(), icon: 'PanelLeft' },
  { value: 'rail', label: () => m.tablet_bar_rail(), icon: 'PanelLeftClose' },
  { value: 'bottom', label: () => m.tablet_bar_bottom(), icon: 'PanelBottom' },
  { value: 'top', label: () => m.tablet_bar_top(), icon: 'PanelTop' },
];
const keyOf = (s: AggSession) => `${s.serverId}::${s.name}`;

export function SessionsBar({ placement, selected, onPick, onNew }: Props) {
  const { theme } = useUnistyles();
  const rows = useSessions(s => s.rows);
  const loading = useSessions(s => s.loading);
  const byServer = useSessions(s => s.byServer);
  const servers = useServers(s => s.servers);
  const crossMachine = rows.some(s => s.pair_owner || s.pair_peers?.some(p => p.includes('::')));
  const identityServers = useMemo(() => crossMachine ? servers : [], [crossMachine, servers]);
  const { identities } = useIdentities(identityServers);
  const items = useMemo(() => barRows(rows, identities), [rows, identities]);
  const setPlacement = useTabletPrefs(s => s.setPlacement);
  const keyboardVisible = useKeyboardState(s => s.isVisible);
  const [positionOpen, setPositionOpen] = useState(false);
  useEffect(() => useSessions.getState().retain(), []);

  if (placement === 'bottom' && keyboardVisible) return null;
  const horizontal = placement === 'bottom' || placement === 'top';
  const isSelected = (s: AggSession) => s.serverId === selected?.serverId && s.name === selected?.name;
  const sessionItem = (s: AggSession) => {
    if (placement === 'left') return <SessionRow key={keyOf(s)} session={s} mostrarServidor compact selected={isSelected(s)} onPress={onPick} />;
    if (placement === 'rail') return (
      <Pressable key={keyOf(s)} onPress={() => onPick(s)} accessibilityRole="button"
        accessibilityLabel={`${s.name}, ${s.serverLabel}, ${rotuloEstado(s.state)}`} accessibilityState={{ selected: isSelected(s) }}
        style={({ pressed }) => [styles.railItem, { backgroundColor: isSelected(s) || pressed ? superficie(theme, 0.8) : 'transparent' }]}>
        <SessionAvatar session={s} size={30} />
        <View style={styles.dot}><StateDot state={s.state} size={6} /></View>
      </Pressable>
    );
    return <SessionChip key={keyOf(s)} session={s} selected={isSelected(s)} onPress={() => onPick(s)} />;
  };
  const renderItem = ({ item }: { item: BarItem }) => item.kind === 'single' ? sessionItem(item.session) : (
    <View style={[styles.group, horizontal && styles.horizontalGroup]}>
      {!horizontal && placement !== 'rail' && item.label ? <Text numberOfLines={1}
        style={[styles.groupLabel, { color: theme.tokens.text.muted }]}>{item.label}</Text> : null}
      {item.members.map(sessionItem)}
    </View>
  );

  return (
    <>
      <Glass variant="panel" style={[styles.bar, horizontal ? styles.horizontal : placement === 'rail' ? styles.rail : styles.left]}>
        <FlatList key={horizontal ? 'horizontal' : 'vertical'} data={items} horizontal={horizontal}
          style={styles.list} contentContainerStyle={styles.items}
          keyExtractor={item => keyOf(item.kind === 'single' ? item.session : item.members[0])}
          renderItem={renderItem} showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}
          ListEmptyComponent={<View style={styles.emptyState}>
            {loading ? <ActivityIndicator accessibilityLabel={m.lista_carregando()} /> :
              <Text style={[styles.empty, { color: theme.tokens.text.muted }]}>{m.tablet_sessions_empty()}</Text>}
            {byServer.filter(b => b.error).map(b => <Text key={b.server.id} accessibilityRole="alert"
              style={[styles.empty, { color: theme.tokens.status.error }]}>
              {b.error === 'offline' ? m.lista_servidor_offline({ label: b.server.label }) : `${b.server.label}: ${b.error}`}
            </Text>)}
          </View>} />
        <View style={[styles.controls, horizontal && styles.horizontalControls]}>
          <Pressable onPress={() => setPositionOpen(true)} style={styles.control} accessibilityRole="button" accessibilityLabel={m.tablet_bar_position()}>
            <Icon name={placements.find(p => p.value === placement)!.icon} size={20} />
          </Pressable>
          <Pressable onPress={onNew} style={styles.control} accessibilityRole="button" accessibilityLabel={m.tablet_new_session()}>
            <Icon name="Plus" size={22} color={theme.tokens.accent.base} />
          </Pressable>
        </View>
      </Glass>
      {positionOpen ? <Sheet open onDismiss={() => setPositionOpen(false)}>
        <View style={styles.sheet}>
          <Text style={[styles.title, { color: theme.tokens.text.primary }]}>{m.tablet_bar_position()}</Text>
          {placements.map(p => <Pressable key={p.value} accessibilityRole="button" accessibilityState={{ selected: placement === p.value }}
            onPress={() => { setPlacement(p.value); setPositionOpen(false); }} style={styles.option}>
            <Icon name={p.icon} size={20} />
            <Text style={[styles.optionLabel, { color: theme.tokens.text.primary }]}>{p.label()}</Text>
            {placement === p.value ? <Icon name="Check" color={theme.tokens.accent.base} /> : null}
          </Pressable>)}
        </View>
      </Sheet> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: { flexShrink: 0 },
  left: { width: 250, flexDirection: 'column' },
  rail: { width: 64, flexDirection: 'column' },
  horizontal: { height: 62, flexDirection: 'row', alignItems: 'center' },
  list: { flex: 1 },
  items: { padding: theme.base.space[1], gap: theme.base.space[1], flexGrow: 1 },
  railItem: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: theme.base.radius.md },
  dot: { position: 'absolute', right: 5, bottom: 5 },
  group: { borderWidth: 1, borderColor: theme.tokens.border.subtle, borderRadius: theme.base.radius.md, overflow: 'hidden' },
  horizontalGroup: { flexDirection: 'row', alignItems: 'center' },
  groupLabel: { fontSize: theme.base.text.xxxs, paddingHorizontal: theme.base.space[3], paddingTop: theme.base.space[1] },
  empty: { fontSize: theme.base.text.xxxs, padding: theme.base.space[1], alignSelf: 'center', flexShrink: 1 },
  emptyState: { justifyContent: 'center', flexShrink: 1 },
  controls: { alignItems: 'center', padding: theme.base.space[1] },
  horizontalControls: { flexDirection: 'row' },
  control: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  sheet: { padding: theme.base.space[4], gap: theme.base.space[2] },
  title: { fontSize: theme.base.text.lg, fontWeight: theme.base.weight.semibold },
  option: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3], minHeight: 44 },
  optionLabel: { fontSize: theme.base.text.base, flex: 1 },
}));
