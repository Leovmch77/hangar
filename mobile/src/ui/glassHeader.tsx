import type { ComponentProps } from 'react';
import { Pressable } from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as m from '../paraglide/messages';
import { Glass } from './Glass';
import { Icon } from './Icon';

type Options = Exclude<ComponentProps<typeof Stack.Screen>['options'], ((...args: never[]) => unknown) | undefined>;

// Cabeçalho nativo da pilha com o vidro do próprio app: o papel de parede passa por trás e a cor
// acompanha o tema. Voltar só com o chevron: as telas anteriores não têm título de navegação.
export function useGlassHeader(): Options {
  const { theme } = useUnistyles();
  return {
    headerShown: true,
    headerTransparent: true,
    headerShadowVisible: false,
    headerBackground: () => <Glass style={[StyleSheet.absoluteFill, styles.bar]} />,
    headerTintColor: theme.tokens.accent.base,
    headerTitleStyle: { color: theme.tokens.text.primary },
    headerBackButtonDisplayMode: 'minimal',
    title: '',
  };
}

/** Voltar para quando a tela abriu sem histórico (link direto): a pilha não desenha o dela. */
export function HeaderBack({ onPress }: { onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Pressable onPress={onPress} hitSlop={12} accessibilityRole="button" accessibilityLabel={m.comum_voltar()}>
      <Icon name="ChevronLeft" size={26} color={theme.tokens.accent.base} />
    </Pressable>
  );
}

const styles = StyleSheet.create({ bar: { borderRadius: 0, borderWidth: 0 } });
