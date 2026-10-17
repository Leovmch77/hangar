import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import type { Edge } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useServers } from '../../../../src/stores/servers';
import { SharePanel } from '../../../../src/features/share/SharePanel';
import { Screen } from '../../../../src/ui/Screen';
import { HeaderBack, useGlassHeader } from '../../../../src/ui/glassHeader';
import * as m from '../../../../src/paraglide/messages';

// iOS: o painel rola por baixo do cabeçalho de vidro (`automatic` no ScrollView dele) e cuida dos
// recuos de cima e de baixo. Android: a tela começa abaixo do cabeçalho.
const IOS = Platform.OS === 'ios';
const EDGES: Edge[] = IOS ? ['left', 'right'] : ['bottom', 'left', 'right'];

export default function ShareRoute() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : (params.server ?? '');
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? '');
  const ready = useServers((state) => state.ready);
  const server = useServers((state) => state.servers.find((item) => item.id === serverId) ?? null);
  const unavailable = !server || server.removed || !name;
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const header = useGlassHeader();
  const headerHeight = useHeaderHeight();
  const top = { paddingTop: headerHeight };
  const canGoBack = router.canGoBack();

  return (
    <Screen edges={EDGES}>
      <Stack.Screen options={{
        ...header,
        title: m.compartilhar_titulo({ nome: name }),
        headerLeft: canGoBack ? undefined : () => <HeaderBack onPress={close} />,
      }} />
      {!ready ? (
        <View style={[styles.state, top]}>
          <ActivityIndicator color={theme.tokens.text.muted} />
          <Text style={styles.muted}>{m.comum_carregando()}</Text>
        </View>
      ) : unavailable || server?.invite ? (
        <View style={[styles.state, top]}>
          <Text style={styles.error} accessibilityRole="alert">
            {unavailable ? m.compare_servidor_nao_encontrado() : m.mobile_share_owner_only()}
          </Text>
        </View>
      ) : (
        <View style={[styles.flex, IOS ? null : top]}>
          <SharePanel key={`${serverId}::${name}`} server={server!} name={name} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.base.space[4], gap: theme.base.space[2] },
  muted: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.error, textAlign: 'center' },
}));
