import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StatusBar, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { WebView } from 'react-native-webview';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as m from '../../paraglide/messages';
import { Icon } from '../../ui/Icon';
import { localCopy } from './mediaCache';

interface Props {
  visible: boolean;
  uri: string;
  headers?: Record<string, string>;
  filename: string;
  onClose: () => void;
  kind?: 'image' | 'video';
  /** "2/5" quando a mensagem tem várias mídias. */
  counter?: string;
  /** Presente = galeria: arrastar de lado (sem zoom) e as setas passam de mídia. */
  onStep?: (dir: 1 | -1) => void;
}

const ARRASTO_PASSA = 60;

export function Lightbox({ visible, uri, headers, filename, onClose, kind = 'image', counter, onStep }: Props) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const reset = () => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedX.value = 0;
    savedY.value = 0;
  };
  // Trocar de mídia na galeria não herda o zoom da anterior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reset, [uri]);

  const handleClose = () => {
    reset();
    onClose();
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = savedScale.value * e.scale;
      scale.value = Math.min(6, Math.max(1, next));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1.05) {
        scale.value = 1;
        savedScale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
        savedX.value = 0;
        savedY.value = 0;
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (scale.value > 1) {
        translateX.value = savedX.value + e.translationX;
        translateY.value = savedY.value + e.translationY;
      }
    })
    .onEnd((e) => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
      // Sem zoom, o arrasto de lado é passar de mídia; com zoom ele é panorâmica.
      if (scale.value <= 1 && onStep && Math.abs(e.translationX) > ARRASTO_PASSA && Math.abs(e.translationX) > Math.abs(e.translationY)) {
        scheduleOnRN(onStep, e.translationX < 0 ? 1 : -1);
      }
    });

  // Toque fecha, como no visor do web. É gesto e não um Pressable por cima: a camada por cima da
  // imagem engolia o toque antes da pinça, e o zoom não funcionava.
  const tap = Gesture.Tap().onEnd(() => {
    if (scale.value <= 1) scheduleOnRN(handleClose);
  });

  const composed = Gesture.Simultaneous(pinch, pan, tap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  // Camada por cima da própria tela de anexos, e não uma `Sheet`: a rota que a hospeda JÁ é um
  // `formSheet`, e a folha dentro da folha nasce achatada — o nome do arquivo colava no topo, a
  // imagem não aparecia, e o arrasto de fechar disputava o pan do zoom.
  if (!visible) return null;

  const topo = (insets.top > 0 ? insets.top : (StatusBar.currentHeight ?? 24)) + theme.base.space[2];

  return (
    <View style={StyleSheet.absoluteFill}>
      <View style={styles.backdrop}>
        <Pressable style={[styles.closeArea, { top: topo }]} onPress={handleClose} accessibilityLabel={m.anexos_fechar_imagem()} accessibilityRole="button">
          <View style={styles.roundBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </View>
        </Pressable>
        {kind === 'video' ? (
          <View style={[styles.videoWrap, { paddingTop: topo + 48 }]}>
            <VideoPage uri={uri} headers={headers} name={filename} />
          </View>
        ) : (
          <GestureDetector gesture={composed}>
            <Animated.View style={[styles.imgWrap, animatedStyle]}>
              <Image source={{ uri, headers }} style={styles.img} contentFit="contain" transition={200} />
            </Animated.View>
          </GestureDetector>
        )}
        <View style={[styles.footer, { bottom: Math.max(insets.bottom, theme.base.space[4]) }]}>
          {onStep ? (
            <Pressable onPress={() => onStep(-1)} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel={m.visor_anterior()}>
              <Icon name="ChevronLeft" size={20} color="#fff" />
            </Pressable>
          ) : null}
          <Text style={styles.caption} numberOfLines={1}>
            {counter ? `${counter} · ${filename}` : filename}
          </Text>
          {onStep ? (
            <Pressable onPress={() => onStep(1)} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel={m.visor_proxima()}>
              <Icon name="ChevronRight" size={20} color="#fff" />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// Vídeo toca no WebView (o player nativo do sistema dentro dele): o app não tem expo-video. O do
// servidor vai pro cache antes, porque o player pede o arquivo aos pedaços sem o header do token.
function VideoPage({ uri, headers, name }: { uri: string; headers?: Record<string, string>; name: string }) {
  const comToken = !!headers && Object.keys(headers).length > 0;
  const [src, setSrc] = useState<string | null>(comToken ? null : uri);
  const [erro, setErro] = useState('');
  useEffect(() => {
    if (!comToken) {
      setSrc(uri);
      return;
    }
    let vivo = true;
    setSrc(null);
    setErro('');
    localCopy(uri, headers, name)
      .then((f) => { if (vivo) setSrc(f.uri); })
      .catch((e: unknown) => { if (vivo) setErro(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  if (erro) {
    return (
      <Text style={styles.videoMsg} accessibilityRole="alert">
        {`${m.visor_nao_carregou()}\n${erro}`}
      </Text>
    );
  }
  if (!src) {
    return (
      <View style={styles.videoLoading}>
        <ActivityIndicator color="#fff" />
        <Text style={styles.videoMsg}>{m.comum_carregando()}</Text>
      </View>
    );
  }
  // Só a cópia baixada pelo app lê arquivo local; URL vinda do texto do assistente fica em http(s),
  // senão o WebView repassaria outro esquema ao sistema.
  const local = comToken;
  if (!local && !/^https?:\/\//i.test(src)) {
    return <Text style={styles.videoMsg} accessibilityRole="alert">{m.visor_nao_carregou()}</Text>;
  }
  return (
    <WebView
      source={{ uri: src }}
      style={styles.video}
      originWhitelist={local ? ['file://*'] : ['http://*', 'https://*']}
      allowFileAccess={local}
      allowingReadAccessToURL={local ? src.slice(0, src.lastIndexOf('/') + 1) : undefined}
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      mediaPlaybackRequiresUserAction={false}
      onError={(e) => setErro(e.nativeEvent.description || m.arquivo_carregar_erro())}
      onHttpError={(e) => setErro(`HTTP ${e.nativeEvent.statusCode}`)}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.base.space[4],
  },
  closeArea: {
    position: 'absolute',
    right: theme.base.space[4],
    zIndex: 2,
  },
  roundBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderColor: 'rgba(255,255,255,0.25)',
  },
  closeTxt: {
    color: '#fff',
    fontSize: 18,
  },
  imgWrap: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  img: {
    width: '100%',
    height: '100%',
  },
  videoWrap: {
    width: '100%',
    flex: 1,
    paddingBottom: 72,
    justifyContent: 'center',
  },
  video: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoLoading: {
    alignItems: 'center',
    gap: theme.base.space[2],
  },
  videoMsg: {
    color: '#fff',
    textAlign: 'center',
    fontSize: theme.base.text.sm,
  },
  footer: {
    position: 'absolute',
    left: theme.base.space[4],
    right: theme.base.space[4],
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[3],
    zIndex: 2,
  },
  caption: {
    flex: 1,
    color: '#fff',
    textAlign: 'center',
    fontSize: theme.base.text.xs,
  },
}));
