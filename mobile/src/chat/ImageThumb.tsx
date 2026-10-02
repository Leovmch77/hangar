import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as m from '../paraglide/messages';
import { Lightbox } from '../features/attachments/Lightbox';
import { Icon } from '../ui/Icon';
import { superficie } from '../theme/superficie';

export interface MediaItem {
  uri: string;
  headers?: Record<string, string>;
  name: string;
  kind: 'image' | 'video';
}

interface Props {
  /** Todas as mídias da mensagem: o visor abre nesta e passa entre elas, como o do web. */
  items: MediaItem[];
  index: number;
  style: object;
}

export function ImageThumb({ items, index, style }: Props) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState<number | null>(null);
  const [falhou, setFalhou] = useState(false);
  const item = items[index];
  const cur = open !== null ? items[open] : null;
  const step = (dir: 1 | -1) => setOpen((i) => (i === null ? i : Math.min(items.length - 1, Math.max(0, i + dir))));

  // Falha não some calada nem vira quadrado vazio: fica o nome, como no web.
  if (falhou) {
    return (
      <View style={styles.broken}>
        <Text style={[styles.brokenTxt, { color: theme.tokens.text.muted }]} numberOfLines={1}>
          {`⚠ ${m.anexos_nao_carregou({ nome: item.name })}`}
        </Text>
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(index)}
        accessibilityRole="imagebutton"
        accessibilityLabel={item.kind === 'video' ? m.anexos_tocar({ nome: item.name }) : m.anexos_ver({ n: item.name })}
      >
        {item.kind === 'image' ? (
          <Image source={{ uri: item.uri, headers: item.headers }} style={style} contentFit="cover" transition={150} onError={() => setFalhou(true)} />
        ) : (
          // ponytail: sem expo-video não há quadro do vídeo; a miniatura é o ▶ e o nome.
          <View style={[style, styles.video]}>
            <Icon name="Play" size={26} color="#fff" />
            <Text style={styles.videoName} numberOfLines={1}>{item.name}</Text>
          </View>
        )}
      </Pressable>
      {/* O Lightbox é camada absoluta: dentro da bolha ele ficaria do tamanho dela. O Modal dá a tela
          inteira, e o gesto de zoom precisa da própria raiz do gesture-handler ali dentro. */}
      <Modal visible={cur !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setOpen(null)}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          {cur ? (
            <Lightbox
              visible
              uri={cur.uri}
              headers={cur.headers}
              filename={cur.name}
              kind={cur.kind}
              counter={items.length > 1 ? `${open! + 1}/${items.length}` : undefined}
              onStep={items.length > 1 ? step : undefined}
              onClose={() => setOpen(null)}
            />
          ) : null}
        </GestureHandlerRootView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  video: {
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.base.space[1],
    padding: theme.base.space[1],
  },
  videoName: {
    color: '#fff',
    fontSize: 10,
    maxWidth: '100%',
  },
  broken: {
    height: 30,
    maxWidth: 220,
    justifyContent: 'center',
    paddingHorizontal: theme.base.space[2],
    borderRadius: theme.base.radius.sm,
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
    backgroundColor: superficie(theme),
  },
  brokenTxt: {
    fontSize: theme.base.text.xs,
    fontFamily: theme.base.fontMono,
  },
}));
