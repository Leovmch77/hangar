import { Pressable, ScrollView, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '../../src/ui/Screen';
import { Glass } from '../../src/ui/Glass';
import { InvitePanel } from '../../src/features/share/InvitePanel';
import { useServers } from '../../src/stores/servers';
import * as m from '../../src/paraglide/messages';

export default function Invite() {
  const router = useRouter();
  const { code, link } = useLocalSearchParams<{ code: string; link?: string | string[] }>();
  const initialLink = typeof link === 'string' ? link : '';
  const hasServers = useServers((state) => state.servers.length > 0);
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => router.replace(hasServers ? '/' : '/login')} accessibilityRole="button" accessibilityLabel={m.nav_voltar()} style={styles.back}>
          <Text style={styles.backText}>{m.nav_voltar()}</Text>
        </Pressable>
        <Glass variant="modal" style={styles.card}>
          <InvitePanel key={`${code}:${initialLink}`} initialLink={initialLink} initialError={initialLink ? '' : m.mobile_share_invite_invalid()}
            onAccepted={(server, session) => router.replace(`/s/${encodeURIComponent(server.id)}/${encodeURIComponent(session)}`)} />
        </Glass>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { padding: theme.base.space[4], gap: theme.base.space[4], alignItems: 'center' },
  card: { width: '100%', maxWidth: 440, padding: theme.base.space[4] },
  back: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  backText: { color: theme.tokens.text.secondary, fontSize: theme.base.text.base },
}));
