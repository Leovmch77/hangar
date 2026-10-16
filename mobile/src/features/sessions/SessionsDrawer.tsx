import { useContext, useState, type ReactNode, type Ref } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Animated, { interpolate, useAnimatedReaction, useAnimatedStyle, useReducedMotion, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SafeAreaView } from 'react-native-safe-area-context';
import ReanimatedDrawerLayout, {
  DrawerKeyboardDismissMode,
  DrawerType,
  type DrawerLayoutMethods,
} from 'react-native-gesture-handler/ReanimatedDrawerLayout';
import { Glass } from '../../ui/Glass';
import { WorkingMarkPaused } from '../../ui/WorkingMark';
import { SessionList } from './SessionList';

// Gaveta de sessões da tela inicial e do chat. Ocupa a altura toda (passa por baixo da barra de
// status, como Claude/ChatGPT): quem usa monta numa `Screen edges={[]}`, e a margem segura fica só
// no conteúdo, aqui dentro. `onClose` roda antes de toda navegação que a lista faz.
export function SessionsDrawer({ ref, onClose, onNewConversation, onOpenServers, children }: {
  ref?: Ref<DrawerLayoutMethods>;
  onClose: () => void;
  onNewConversation?: () => void;
  onOpenServers: () => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  return (
    <ReanimatedDrawerLayout
      ref={ref}
      drawerType={DrawerType.FRONT}
      drawerWidth={Math.min(width * 0.85, 360)}
      edgeWidth={32}
      overlayColor="rgba(0,0,0,0.3)"
      animationSpeed={0.8}
      keyboardDismissMode={DrawerKeyboardDismissMode.ON_DRAG}
      renderNavigationView={(progress) => (
        <DrawerPanel progress={progress}>
          <SessionList onClose={onClose} onNewConversation={onNewConversation} onOpenServers={onOpenServers} />
        </DrawerPanel>
      )}
    >
      {(progress) => <DrawerContent progress={progress}>{children}</DrawerContent>}
    </ReanimatedDrawerLayout>
  );
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
