import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AggSession } from '@hangar/core';
import { Glass } from '../../ui/Glass';
import { useServers } from '../../stores/servers';
import { FilesPanel } from '../files/FilesPanel';
import { ActivityPanel } from '../activity/ActivityPanel';
import { GitPanel } from '../git/GitPanel';
import { ContextTab } from './ContextTab';
import * as m from '../../paraglide/messages';

type Props = { serverId: string; name: string; onPick?: (session: AggSession) => void };
type Tab = 'context' | 'files' | 'background' | 'git';
const tabs: { value: Tab; label: () => string }[] = [
  { value: 'context', label: () => m.tablet_tab_context() },
  { value: 'files', label: () => m.tablet_tab_files() },
  { value: 'background', label: () => m.tablet_tab_background() },
  { value: 'git', label: () => m.tablet_tab_git() },
];

export function ContextPanel({ serverId, name, onPick }: Props) {
  const sessionKey = `${serverId}::${name}`;
  const [selection, setSelection] = useState<{ key: string; tab: Tab }>({ key: sessionKey, tab: 'context' });
  if (selection.key !== sessionKey) setSelection({ key: sessionKey, tab: 'context' });
  const tab = selection.key === sessionKey ? selection.tab : 'context';
  const ready = useServers((s) => s.ready);
  const server = useServers((s) => s.servers.find((item) => item.id === serverId));

  return (
    <Glass variant="panel" style={styles.panel}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {tabs.map((item) => <Pressable key={item.value} accessibilityRole="tab" accessibilityLabel={item.label()}
          accessibilityState={{ selected: tab === item.value }} onPress={() => setSelection({ key: sessionKey, tab: item.value })}
          style={[styles.tab, tab === item.value && styles.selectedTab]}>
          <Text style={[styles.tabLabel, tab === item.value && styles.selectedLabel]}>{item.label()}</Text>
        </Pressable>)}
      </View>
      <View key={sessionKey} style={styles.body}>
        {tab === 'context' ? <ContextTab serverId={serverId} name={name} onPick={onPick} />
          : !ready ? <View style={styles.feedback}><ActivityIndicator accessibilityLabel={m.comum_carregando()} /></View>
          : !server ? <View style={styles.feedback}><Text style={styles.error} accessibilityRole="alert">{m.chat_servidor_removido()}</Text></View>
          : tab === 'files' ? <FilesPanel serverId={serverId} name={name} />
          : tab === 'background' ? <ActivityPanel serverId={serverId} name={name} />
          : <GitPanel server={server} name={name} />}
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { width: 300, flexShrink: 0, minHeight: 0 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.tokens.border.subtle },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    padding: theme.base.space[1], borderBottomWidth: 2, borderBottomColor: 'transparent' },
  selectedTab: { borderBottomColor: theme.tokens.accent.base },
  tabLabel: { fontSize: theme.base.text.xs, color: theme.tokens.text.secondary, textAlign: 'center' },
  selectedLabel: { color: theme.tokens.accent.base, fontWeight: theme.base.weight.semibold },
  body: { flex: 1, minHeight: 0 },
  feedback: { flex: 1, padding: theme.base.space[4], alignItems: 'center', justifyContent: 'center' },
  error: { fontSize: theme.base.text.xs, color: theme.tokens.status.error },
}));
