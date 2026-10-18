import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../../../src/ui/Icon';
import * as m from '../../../../src/paraglide/messages';
import { SessionAccount } from '../../../../src/chat/SessionAccount';

export default function AccountRoute() {
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = typeof params.server === 'string' ? params.server : '';
  const name = typeof params.name === 'string' ? params.name : '';
  const router = useRouter();
  const { theme } = useUnistyles();
  const backgroundColor = theme.tokens.bg.base;
  const screenOptions = useMemo(() => ({ headerShown: false, contentStyle: { backgroundColor } }), [backgroundColor]);
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(`/s/${encodeURIComponent(serverId)}/${encodeURIComponent(name)}` as never);
  };
  return <View style={styles.root}>
    <Stack.Screen options={screenOptions} />
    {/* O formSheet precisa medir o cabeçalho junto da rolagem, sem o cabeçalho nativo. */}
    <View collapsable={false} style={styles.header}>
      <Text accessibilityRole="header" style={styles.title}>{m.accounts_switch_title()}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={m.native_close()} onPress={close} style={styles.close}>
        <Icon name="X" size={20} color={theme.tokens.text.secondary} />
      </Pressable>
    </View>
    <SessionAccount key={`${serverId}:${name}`} serverId={serverId} name={name} />
  </View>;
}

const styles = StyleSheet.create(theme => ({
  // Só layout: permite que a folha encontre o cabeçalho e a rolagem como filhos diretos.
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingHorizontal: theme.base.space[4], paddingVertical: theme.base.space[3] },
  title: { flex: 1, fontSize: theme.base.text.lg, fontWeight: '600', color: theme.tokens.text.primary },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
}));
