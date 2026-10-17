import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { HeaderBack, useGlassHeader } from '../../../../src/ui/glassHeader';
import * as m from '../../../../src/paraglide/messages';
import { SessionAccount } from '../../../../src/chat/SessionAccount';

export default function AccountRoute() {
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = typeof params.server === 'string' ? params.server : '';
  const name = typeof params.name === 'string' ? params.name : '';
  const router = useRouter();
  const header = useGlassHeader();
  return <View style={styles.root}>
    <Stack.Screen options={{ ...header, title: m.accounts_switch_title(), headerLeft: router.canGoBack() ? undefined
      : () => <HeaderBack onPress={() => router.replace(`/s/${encodeURIComponent(serverId)}/${encodeURIComponent(name)}` as never)} /> }} />
    <SessionAccount key={`${serverId}:${name}`} serverId={serverId} name={name} />
  </View>;
}

const styles = StyleSheet.create(theme => ({ root: { flex: 1, backgroundColor: theme.tokens.bg.base } }));
