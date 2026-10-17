import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useServers } from '../../../../src/stores/servers';
import { Icon } from '../../../../src/ui/Icon';
import { GitPanel } from '../../../../src/features/git/GitPanel';
import * as m from '../../../../src/paraglide/messages';

export default function GitRoute() {
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = typeof params.server === 'string' ? params.server : '';
  const name = typeof params.name === 'string' ? params.name : '';
  const ready = useServers((s) => s.ready);
  const baseUrl = useServers((s) => s.servers.find((x) => x.id === serverId)?.baseUrl);
  const token = useServers((s) => s.servers.find((x) => x.id === serverId)?.token);
  const label = useServers((s) => s.servers.find((x) => x.id === serverId)?.label);
  const refused = useServers((s) => {
    const server = s.servers.find((x) => x.id === serverId);
    return !server || !!(server.removed || server.invite || server.inviteEnded);
  });
  const server = useMemo(() => baseUrl && token ? { id: serverId, baseUrl, token, label: label ?? serverId } : null, [serverId, baseUrl, token, label]);
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.root, { paddingBottom: insets.bottom }]}>
    <View style={styles.header}>
      <Text style={styles.title} accessibilityRole="header">{m.sessao_git()}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={m.comum_voltar()} onPress={() => router.back()} style={styles.back}>
        <Icon name="X" /><Text style={styles.text}>{m.comum_voltar()}</Text>
      </Pressable>
    </View>
    {!ready ? <View style={styles.center}><ActivityIndicator color={theme.tokens.text.muted} /><Text style={styles.text}>{m.native_git_loading()}</Text></View>
      : refused || !server || !name ? <Text selectable accessibilityRole="alert" style={styles.error}>{m.chat_servidor_removido()}</Text>
      : <GitPanel key={`${serverId}:${name}:${baseUrl}:${token}`} server={server} name={name} />}
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.tokens.bg.base },
  header: { flexDirection: 'row', alignItems: 'center', padding: theme.base.space[3], gap: theme.base.space[2] },
  title: { flex: 1, color: theme.tokens.text.primary, fontSize: theme.base.text.lg, fontWeight: '600' },
  back: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1], minHeight: 44, paddingHorizontal: theme.base.space[2] },
  text: { color: theme.tokens.text.secondary, fontSize: theme.base.text.sm },
  error: { padding: theme.base.space[3], color: theme.tokens.status.error, fontSize: theme.base.text.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
}));
