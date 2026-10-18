import { useCallback, useContext, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { BackHandler, Platform, useWindowDimensions, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import Animated, { interpolate, useAnimatedReaction, useAnimatedStyle, useReducedMotion, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import ReanimatedDrawerLayout, {
  DrawerKeyboardDismissMode,
  DrawerLockMode,
  DrawerType,
  type DrawerLayoutMethods,
} from 'react-native-gesture-handler/ReanimatedDrawerLayout';
import { Glass } from '../../ui/Glass';
import { WorkingMarkPaused } from '../../ui/WorkingMark';
import { DrawerMenu } from './DrawerMenu';

// Gaveta de navegação da tela inicial e do chat. Ocupa a altura toda (passa por baixo da barra de
// status, como Claude/ChatGPT): quem usa monta numa `Screen edges={[]}`, e a margem segura fica só
// no conteúdo, aqui dentro. `onClose` roda antes de toda navegação que a lista faz.
// `edgeStart`: a faixa de arrasto começa a essa distância da borda, que fica com o voltar do iOS.
// `openOnBack` (Início): o Back do Android abre a gaveta fechada; com ela aberta, segue o sistema
// e sai do app, senão o Back nunca sairia dali.
export function SessionsDrawer({ ref, edgeStart, openOnBack, onClose, onOpenServers, children }: {
  ref?: Ref<DrawerLayoutMethods>;
  edgeStart?: number;
  openOnBack?: boolean;
  onClose: () => void;
  onOpenServers: () => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const inner = useRef<DrawerLayoutMethods | null>(null);
  const [open, setOpen] = useState(false);
  useFocusEffect(useCallback(() => {
    // Só fechada com `openOnBack` (abre) ou aberta sem ele (fecha); no resto o Back é do sistema.
    if (Platform.OS !== 'android' || open === !!openOnBack) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (open) inner.current?.closeDrawer();
      else inner.current?.openDrawer();
      return true;
    });
    return () => sub.remove();
  }, [open, openOnBack]));
  const setRef = (r: DrawerLayoutMethods | null) => {
    inner.current = r;
    if (typeof ref === 'function') ref(r);
    else if (ref) ref.current = r;
  };
  // A faixa da própria gaveta nasce colada na borda (hitSlop fixo do gesture-handler): com
  // `edgeStart` ela fica travada fechada e este arrasto, mais para dentro, a abre.
  const insetPan = useMemo(() => edgeStart == null ? null : Gesture.Pan()
    .runOnJS(true)
    .hitSlop(drawerEdgeSlop(edgeStart))
    .activeOffsetX(10)
    .failOffsetY([-15, 15])
    .onEnd((e, success) => {
      if (success && shouldOpenDrawer(e.translationX, e.velocityX)) inner.current?.openDrawer({ initialVelocity: e.velocityX });
    }), [edgeStart]);
  const content = (progress?: SharedValue<number>) => <DrawerContent progress={progress}>{children}</DrawerContent>;
  return (
    <ReanimatedDrawerLayout
      ref={setRef}
      onDrawerOpen={() => setOpen(true)}
      onDrawerClose={() => setOpen(false)}
      drawerType={DrawerType.FRONT}
      drawerWidth={Math.min(width * 0.85, 360)}
      edgeWidth={EDGE_WIDTH}
      drawerLockMode={edgeStart == null ? DrawerLockMode.UNLOCKED : DrawerLockMode.LOCKED_CLOSED}
      overlayColor="rgba(0,0,0,0.3)"
      animationSpeed={0.8}
      keyboardDismissMode={DrawerKeyboardDismissMode.ON_DRAG}
      renderNavigationView={(progress) => (
        <DrawerPanel progress={progress}>
          <DrawerMenu open={open} onClose={onClose} onOpenServers={onOpenServers} />
        </DrawerPanel>
      )}
    >
      {(progress) => insetPan ? (
        <GestureDetector gesture={insetPan}><View style={styles.content}>{content(progress)}</View></GestureDetector>
      ) : content(progress)}
    </ReanimatedDrawerLayout>
  );
}

// Padrão do DrawerLayout do Android. Mais larga, a faixa cobria o começo do conteúdo (16 dp): com a
// gaveta fechada o arrasto ativa no primeiro movimento e cancelava o toque ali.
const EDGE_WIDTH = 20;

export function drawerEdgeSlop(edgeStart: number) {
  return { left: -edgeStart, width: EDGE_WIDTH };
}

export function shouldOpenDrawer(translationX: number, velocityX: number) {
  return translationX > 40 || velocityX > 500;
}

// O conteúdo recua um pouco junto com o arrasto; com Reduzir movimento fica parado (o escurecido basta).
function DrawerContent({ progress, children }: { progress?: SharedValue<number>; children: ReactNode }) {
  const reduced = useReducedMotion();
  const anim = useAnimatedStyle(() => ({
    transform: [{ translateX: reduced || !progress ? 0 : interpolate(progress.value, [0, 1], [0, 36]) }],
  }));
  return (
    <Animated.View style={[styles.content, anim]}>
      <SafeAreaView style={styles.content}>{children}</SafeAreaView>
    </Animated.View>
  );
}

// A sombra acompanha a abertura: fixa, ela vazaria na borda esquerda com a gaveta fechada. Anima só
// a opacidade de uma sombra pronta; o vidro só existe com a gaveta aberta. A lista nasce na primeira
// abertura e fica (guarda busca, seções recolhidas e rolagem), com as marcas paradas enquanto fechada.
function DrawerPanel({ progress, children }: { progress: SharedValue<number>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  if (open && !opened) setOpened(true);
  const paused = useContext(WorkingMarkPaused);
  useAnimatedReaction(() => progress.value > 0, (now, before) => {
    if (now !== before) scheduleOnRN(setOpen, now);
  });
  const shadow = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <View style={styles.content}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.shadow, shadow]} pointerEvents="none" />
      <View style={styles.panel}>
        {open ? <Glass variant="panel" style={[StyleSheet.absoluteFill, styles.drawer]} pointerEvents="none" /> : null}
        {opened ? <WorkingMarkPaused.Provider value={paused || !open}>{children}</WorkingMarkPaused.Provider> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  content: { flex: 1, backgroundColor: 'transparent' },
  // O recorte fica dentro: a sombra é de fora da caixa.
  panel: { flex: 1, overflow: 'hidden' },
  shadow: { boxShadow: '0px 0px 28px rgba(0,0,0,0.35)' },
  // Altura toda e colada na borda: só o fio do lado que fica sobre a tela.
  drawer: { flex: 1, borderRadius: 0, borderWidth: 0, borderRightWidth: StyleSheet.hairlineWidth },
}));
