import { Pressable, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import * as m from '../paraglide/messages';

// O orquestrador não recebe mensagem: no lugar do compositor fica o caminho até quem recebe.
export function OrqFooter({ serverId, arbiter }: { serverId: string; arbiter: string | null | undefined }) {
  const router = useRouter();
  if (!arbiter) return null;
  return (
    <Pressable
      onPress={() => router.push(`/s/${serverId}/${arbiter}` as never)}
      style={styles.botao}
      accessibilityRole="button"
      accessibilityLabel={m.orq_talk_to_arbiter()}
    >
      <Text style={styles.texto}>{m.orq_talk_to_arbiter()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  botao: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.base.space[4],
  },
  texto: {
    fontSize: theme.base.text.base,
    fontWeight: '600',
    color: theme.tokens.accent.base,
  },
}));
