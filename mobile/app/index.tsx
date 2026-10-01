import { useRef, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import Animated, { interpolate, useAnimatedStyle, useReducedMotion, type SharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import ReanimatedDrawerLayout, {
  DrawerKeyboardDismissMode,
  DrawerType,
  type DrawerLayoutMethods,
} from 'react-native-gesture-handler/ReanimatedDrawerLayout';
import { Screen } from '../src/ui/Screen';
import { Glass } from '../src/ui/Glass';
import { Icon } from '../src/ui/Icon';
import { SessionList } from '../src/features/sessions/SessionList';
import { ServerSheet } from '../src/features/sessions/ServerSheet';
import { CreateSessionSheet } from '../src/features/create/CreateSessionSheet';
import * as m from '../src/paraglide/messages';

// Como no app de PC: a tela inicial é a Nova conversa e as sessões moram numa gaveta lateral.
export default function Index() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const drawer = useRef<DrawerLayoutMethods>(null);
  const [serversOpen, setServersOpen] = useState(false);
  const closeDrawer = () => drawer.current?.closeDrawer();
  // O keyboardDismissMode da gaveta só age no arrasto; pelo botão o campo seguiria focado atrás dela.
  const openDrawer = () => {
    Keyboard.dismiss();
    drawer.current?.openDrawer();
  };

  const topButton = (icon: 'PanelLeft' | 'Server' | 'Settings', label: string, onPress: () => void) => (
    <Pressable onPress={onPress} style={styles.icon} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}>
      <Icon name={icon} size={20} color={theme.tokens.text.secondary} />
    </Pressable>
  );

  // A gaveta ocupa a altura toda (passa por baixo da barra de status, como Claude/ChatGPT): a
  // margem segura sai da Screen e fica só no conteúdo de baixo e dentro da lista.
  return (
    <Screen edges={[]}>
      <ReanimatedDrawerLayout
        ref={drawer}
        drawerType={DrawerType.FRONT}
        drawerWidth={Math.min(width * 0.85, 360)}
        edgeWidth={32}
        overlayColor="rgba(0,0,0,0.3)"
        animationSpeed={0.8}
        keyboardDismissMode={DrawerKeyboardDismissMode.ON_DRAG}
        renderNavigationView={(progress) => (
          <DrawerPanel progress={progress}>
            <SessionList onClose={closeDrawer} onOpenServers={() => setServersOpen(true)} />
          </DrawerPanel>
        )}
      >
        {(progress) => (
          <HomeContent progress={progress}>
            <View style={styles.bar}>
              {topButton('PanelLeft', m.native_sessions(), openDrawer)}
              <View style={styles.spacer} />
              {topButton('Server', m.maquinas_este_aparelho(), () => setServersOpen(true))}
              {topButton('Settings', m.config_modal_titulo(), () => router.push('/config' as never))}
            </View>
            <CreateSessionSheet />
          </HomeContent>
        )}
      </ReanimatedDrawerLayout>
      <ServerSheet open={serversOpen} onFechar={() => setServersOpen(false)} />
    </Screen>
  );
}

// O conteúdo recua um pouco junto com o arrasto; com Reduzir movimento fica parado (o escurecido basta).
function HomeContent({ progress, children }: { progress?: SharedValue<number>; children: ReactNode }) {
  const reduced = useReducedMotion();
  const anim = useAnimatedStyle(() => ({
    transform: [{ translateX: reduced || !progress ? 0 : interpolate(progress.value, [0, 1], [0, 36]) }],
  }));
  return (
    <Animated.View style={[styles.home, anim]}>
      <SafeAreaView style={styles.home}>{children}</SafeAreaView>
    </Animated.View>
  );
}

// A sombra acompanha a abertura: fixa, ela vazaria na borda esquerda com a gaveta fechada.
function DrawerPanel({ progress, children }: { progress: SharedValue<number>; children: ReactNode }) {
  const shadow = useAnimatedStyle(() => ({
    boxShadow: `0px 0px 28px rgba(0,0,0,${0.35 * progress.value})`,
  }));
  return (
    <Animated.View style={[styles.drawerShadow, shadow]}>
      <Glass variant="panel" style={styles.drawer}>{children}</Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  home: { flex: 1, backgroundColor: 'transparent' },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.base.space[1] },
  spacer: { flex: 1 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  drawerShadow: { flex: 1 },
  // Altura toda e colada na borda: só o fio do lado que fica sobre a tela.
  drawer: { flex: 1, borderRadius: 0, borderWidth: 0, borderRightWidth: StyleSheet.hairlineWidth },
}));
