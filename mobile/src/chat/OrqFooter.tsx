import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import * as m from '../paraglide/messages';

// O orquestrador não recebe mensagem: no lugar do compositor fica o caminho até quem recebe.
// Sem árbitro registrado o botão fica desligado, como no web e no nativo, para a tela não
// parecer um compositor que sumiu.
export function OrqFooter({ serverId, arbiter }: { serverId: string; arbiter: string | null | undefined }) {
  const router = useRouter();
  return (
    <View style={styles.rodape}>
      <Text style={styles.selo}>{m.orq_row_badge()}</Text>
      <Pressable
        onPress={() => { if (arbiter) router.push(`/s/${serverId}/${arbiter}` as never); }}
        disabled={!arbiter}
        style={[styles.botao, !arbiter ? { opacity: 0.5 } : null]}
        accessibilityRole="button"
        accessibilityLabel={m.orq_talk_to_arbiter()}
        accessibilityState={{ disabled: !arbiter }}
      >
        <Text style={styles.texto}>{m.orq_talk_to_arbiter()}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rodape: {
    alignItems: 'center',
    paddingTop: theme.base.space[2],
  },
  selo: {
    fontSize: theme.base.text.sm,
    color: theme.tokens.text.muted,
  },
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
