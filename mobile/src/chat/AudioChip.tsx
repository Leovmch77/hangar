import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as m from '../paraglide/messages';
import { Icon } from '../ui/Icon';
import { superficie } from '../theme/superficie';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Tocador na própria bolha, como o <audio controls> do web. A fonte só entra no primeiro toque:
// a lista monta várias bolhas, e cada uma baixaria o áudio sem ninguém pedir.
export function AudioChip({ uri, headers, name }: { uri: string; headers?: Record<string, string>; name: string }) {
  const { theme } = useUnistyles();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [carregado, setCarregado] = useState(false);
  const fim = status.duration > 0 && status.currentTime >= status.duration - 0.1;

  const alternar = () => {
    if (status.playing) return player.pause();
    if (!carregado) {
      player.replace({ uri, headers });
      setCarregado(true);
    } else if (fim) {
      void player.seekTo(0);
    }
    player.play();
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={alternar}
        style={styles.btn}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? m.anexos_pausar({ nome: name }) : m.anexos_tocar({ nome: name })}
      >
        <Icon name={status.playing ? 'Pause' : 'Play'} size={16} color={theme.tokens.accent.base} />
      </Pressable>
      <View style={styles.info}>
        <Text style={[styles.name, { color: theme.tokens.text.primary }]} numberOfLines={1}>{name}</Text>
        {status.error ? (
          <Text style={[styles.meta, { color: theme.tokens.status.error }]} accessibilityRole="alert" numberOfLines={2}>
            {`${m.visor_nao_carregou()} (${status.error})`}
          </Text>
        ) : carregado ? (
          <Text style={[styles.meta, { color: theme.tokens.text.muted }]}>
            {status.duration > 0 ? `${mmss(status.currentTime)} / ${mmss(status.duration)}` : m.comum_carregando()}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    paddingRight: theme.base.space[3],
    borderRadius: theme.base.radius.md,
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
    backgroundColor: superficie(theme),
    maxWidth: 320,
    minWidth: 180,
  },
  btn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  info: { flexShrink: 1, paddingVertical: theme.base.space[1] },
  name: { fontSize: theme.base.text.xs, fontFamily: theme.base.fontMono },
  meta: { fontSize: theme.base.text.xs },
}));
