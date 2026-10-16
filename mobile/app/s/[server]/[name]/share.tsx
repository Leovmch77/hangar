import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useServers } from '../../../../src/stores/servers';
import { SharePanel } from '../../../../src/features/share/SharePanel';
import { Screen } from '../../../../src/ui/Screen';
import { Icon } from '../../../../src/ui/Icon';
import * as m from '../../../../src/paraglide/messages';

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

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={m.comum_voltar()} onPress={close} style={styles.back}>
          <Icon name="ChevronLeft" size={22} color={theme.tokens.text.primary} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{m.compartilhar_titulo({ nome: name })}</Text>
      </View>
      {!ready ? (
        <View style={styles.state}>
          <ActivityIndicator color={theme.tokens.text.muted} />
          <Text style={styles.muted}>{m.comum_carregando()}</Text>
        </View>
      ) : unavailable || server?.invite ? (
        <View style={styles.state}>
          <Text style={styles.error} accessibilityRole="alert">
            {unavailable ? m.compare_servidor_nao_encontrado() : m.mobile_share_owner_only()}
          </Text>
        </View>
      ) : (
        <SharePanel key={`${serverId}::${name}`} server={server!} name={name} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1], paddingHorizontal: theme.base.space[2] },
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  title: { flexShrink: 1, fontSize: theme.base.text.base, fontWeight: '600', color: theme.tokens.text.primary },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.base.space[4], gap: theme.base.space[2] },
  muted: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.error, textAlign: 'center' },
}));
