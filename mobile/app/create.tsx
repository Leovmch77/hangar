import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useSegments } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import { CreateSessionSheet } from '../src/features/create/CreateSessionSheet';
import * as m from '../src/paraglide/messages';

export default function CreateRoute() {
  const router = useRouter();
  const segments = useSegments();
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  return (
    <Screen>
      <View style={styles.wrap}>
        {segments[0] === 'create' ? (
          <>
            <View style={styles.header}>
              <Pressable accessibilityRole="button" accessibilityLabel={m.comum_cancelar()} onPress={close} style={styles.close}>
                <Text style={styles.closeText}>{m.comum_cancelar()}</Text>
              </Pressable>
            </View>
            <CreateSessionSheet onClose={close} />
          </>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { flex: 1, backgroundColor: theme.tokens.bg.base },
  header: { alignItems: 'flex-end', paddingHorizontal: theme.base.space[4] },
  close: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  closeText: { color: theme.tokens.accent.base, fontSize: theme.base.text.base },
}));
