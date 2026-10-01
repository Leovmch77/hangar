import { Stack, useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { Icon } from '../../src/ui/Icon';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Glass } from '../../src/ui/Glass';
import * as m from '../../src/paraglide/messages';

// Cabeçalho de vidro do próprio app, não o material cinza do sistema: o papel de parede atravessa
// e a cor acompanha o tema. O recuo do conteúdo vem da `Pagina`. As páginas internas não repetem
// o título na barra: quem o mostra é o PageHeader, como no desktop.
export default function ConfigLayout() {
  const { theme } = useUnistyles();
  const router = useRouter();
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerBackground: () => <Glass style={[StyleSheet.absoluteFill, styles.bar]} />,
        headerTintColor: theme.tokens.accent.base,
        headerTitleStyle: { color: theme.tokens.text.primary },
        title: '',
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: m.config_modal_titulo(),
          // Raiz da pilha das configurações não ganha "voltar" sozinha: sai para a tela de onde veio.
          headerLeft: () => (
            <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={m.comum_voltar()}>
              <Icon name="ChevronLeft" size={26} color={theme.tokens.accent.base} />
            </Pressable>
          ),
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({ bar: { borderRadius: 0, borderWidth: 0 } });
