import { useCallback, useMemo } from 'react';
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
  const canGoBack = router.canGoBack();
  const title = m.accounts_switch_title();
  const back = useCallback(() => router.replace(`/s/${encodeURIComponent(serverId)}/${encodeURIComponent(name)}` as never), [router, serverId, name]);
  const headerOptions = useMemo(() => ({ ...header, title, headerLeft: canGoBack ? undefined
    : () => <HeaderBack onPress={back} /> }), [header, title, canGoBack, back]);
  return <View style={styles.root}>
    <Stack.Screen options={headerOptions} />
    <SessionAccount key={`${serverId}:${name}`} serverId={serverId} name={name} />
  </View>;
}

const styles = StyleSheet.create(theme => ({ root: { flex: 1, backgroundColor: theme.tokens.bg.base } }));
