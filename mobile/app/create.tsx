import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter, useSegments } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import { Icon } from '../src/ui/Icon';
import { CreateSessionSheet } from '../src/features/create/CreateSessionSheet';
import * as m from '../src/paraglide/messages';

export default function CreateRoute() {
  const router = useRouter();
  const { theme } = useUnistyles();
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
            {/* "‹ Nova conversa" do app de PC; sair é cancelar a criação, por isso o rótulo. */}
            <View style={styles.header}>
              <Pressable accessibilityRole="button" accessibilityLabel={m.comum_cancelar()} onPress={close} style={styles.close}>
                <Icon name="ChevronLeft" size={22} color={theme.tokens.text.primary} />
              </Pressable>
              <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{m.native_new_chat_title()}</Text>
            </View>
            <CreateSessionSheet onClose={close} />
          </>
        ) : null}
      </View>
    </Screen>
  );
}

// Transparente: o Background da Screen pinta o fundo escolhido em Aparência.
const styles = StyleSheet.create((theme) => ({
  wrap: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1], paddingHorizontal: theme.base.space[2] },
  close: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  title: { flexShrink: 1, fontSize: theme.base.text.base, fontWeight: '600', color: theme.tokens.text.primary },
}));
