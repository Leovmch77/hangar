import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useServers } from '../../../../src/stores/servers';
import { HeaderBack, useGlassHeader } from '../../../../src/ui/glassHeader';
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
  const header = useGlassHeader();
  const headerHeight = useHeaderHeight();
  const back = useCallback(() => router.replace(`/s/${encodeURIComponent(serverId)}/${encodeURIComponent(name)}` as never), [router, serverId, name]);
  const canGoBack = router.canGoBack();
  const title = m.sessao_git();
  const backgroundColor = theme.tokens.bg.base;
  const localHeader = Platform.OS === 'ios';
  const headerOptions = useMemo(() => ({
    ...header,
    headerShown: !localHeader,
    title,
    contentStyle: { backgroundColor },
    headerLeft: canGoBack ? undefined : () => <HeaderBack onPress={back} />,
  }), [header, title, canGoBack, back, localHeader, backgroundColor]);
  const close = () => {
    if (router.canGoBack()) router.back();
    else back();
  };
  return <View style={styles.root}>
    <Stack.Screen options={headerOptions} />
    {localHeader ? <View collapsable={false} style={styles.header}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={m.native_close()} onPress={close} style={styles.close}>
        <Icon name="X" size={20} color={theme.tokens.text.secondary} />
      </Pressable>
    </View> : null}
    <KeyboardAvoidingView behavior="padding" automaticOffset style={[styles.root, { paddingTop: localHeader ? 0 : headerHeight }]}>
      <View style={{ flex: 1, paddingBottom: insets.bottom }}>
        {!ready ? <View style={styles.center}><ActivityIndicator color={theme.tokens.text.muted} /><Text style={styles.text}>{m.native_git_loading()}</Text></View>
          : refused || !server || !name ? <Text selectable accessibilityRole="alert" style={styles.error}>{m.chat_servidor_removido()}</Text>
          : <GitPanel key={`${serverId}:${name}:${baseUrl}:${token}`} server={server} name={name} />}
      </View>
    </KeyboardAvoidingView>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingHorizontal: theme.base.space[4], paddingVertical: theme.base.space[3] },
  title: { flex: 1, fontSize: theme.base.text.lg, fontWeight: '600', color: theme.tokens.text.primary },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  text: { color: theme.tokens.text.secondary, fontSize: theme.base.text.sm },
  error: { padding: theme.base.space[3], color: theme.tokens.status.error, fontSize: theme.base.text.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
}));
