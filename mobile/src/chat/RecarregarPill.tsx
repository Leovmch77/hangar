import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as m from '../paraglide/messages';
import { superficie } from '../theme/superficie';

interface Props {
  /** Motivo vindo do `state` (null = nada a recarregar; a pill não monta). */
  motivo: string | null | undefined;
  bloqueado: boolean;
  onPress: () => void;
}

/** O processo da sessão sem terminal está desatualizado: discreto, só enquanto há motivo. */
export function RecarregarPill({ motivo, bloqueado, onPress }: Props) {
  const { theme } = useUnistyles();
  if (!motivo) return null;
  return (
    <View style={[styles.pill, { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]}
          accessibilityRole="text">
      <Text style={[styles.text, { color: theme.tokens.text.secondary }]} numberOfLines={2}>
        {m.recarregar_aviso_config()}
      </Text>
      <Pressable
        onPress={onPress}
        disabled={bloqueado}
        style={[styles.btn, { borderColor: theme.tokens.accent.base, opacity: bloqueado ? 0.5 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={m.recarregar_agora()}
        accessibilityHint={bloqueado ? m.modo_so_ociosa() : m.recarregar_sessao_detalhe()}
      >
        <Text style={[styles.btnText, { color: theme.tokens.accent.base }]}>{m.recarregar_agora()}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    marginHorizontal: theme.base.space[3],
    marginVertical: theme.base.space[2],
    paddingLeft: theme.base.space[3],
    paddingRight: theme.base.space[2],
    paddingVertical: theme.base.space[2],
    borderRadius: theme.base.radius.full,
    borderWidth: 1,
    minHeight: 44,
  },
  text: {
    fontSize: theme.base.text.sm,
    flex: 1,
  },
  btn: {
    paddingHorizontal: theme.base.space[3],
    paddingVertical: theme.base.space[1],
    borderRadius: theme.base.radius.full,
    borderWidth: 1,
  },
  btnText: {
    fontSize: theme.base.text.sm,
    fontWeight: '600',
  },
}));
