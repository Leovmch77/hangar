import { forwardRef, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { Icon, type IconName } from '../../ui/Icon';
import { usePressScale } from '../../ui/pressScale';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = {
  icon?: IconName;
  // Selo à esquerda no lugar do ícone (o logo do provider).
  leading?: ReactNode;
  label: string;
  // Nome da escolha para o leitor de tela: "Máquina: Notebook".
  aria: string;
  disabled?: boolean;
  // Com ações, o toque abre o menu nativo; sem, chama onPress.
  actions?: MenuAction[];
  menuTitle?: string;
  onAction?: (id: string) => void;
  onPress?: () => void;
  strong?: boolean;
  // Estado que a pessoa precisa ver sem abrir o menu (conta sem cota, troca automática).
  tone?: 'warning' | 'accent';
};

// A pílula quieta do app de PC (quiet_pill): 26 de altura, texto 12.5 apagado, ícone 14 e a seta do
// menu. O hitSlop leva o toque aos 44 pt sem engordar o desenho.
export const QuietPill = forwardRef<View, Props>(function QuietPill(
  { icon, leading, label, aria, disabled, actions, menuTitle, onAction, onPress, strong, tone }, ref,
) {
  const { theme } = useUnistyles();
  const ink = tone === 'warning' ? theme.tokens.status.warning : tone === 'accent' ? theme.tokens.accent.base : theme.tokens.text.muted;
  const press = usePressScale();
  const body = (
    <AnimatedPressable
      ref={ref}
      onPress={actions ? undefined : onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      disabled={disabled}
      hitSlop={{ top: 9, bottom: 9, left: 2, right: 2 }}
      accessibilityRole="button"
      accessibilityLabel={`${aria}: ${label}`}
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.pill, press.style, disabled && styles.disabled]}
    >
      {leading ?? (icon ? <Icon name={icon} size={14} color={ink} /> : null)}
      <Text style={[styles.text, strong && styles.strong, tone && { color: ink }]} numberOfLines={1}>{label}</Text>
      <Icon name="ChevronDown" size={12} color={theme.tokens.text.muted} />
    </AnimatedPressable>
  );
  return (
    <Animated.View entering={FadeIn.duration(220)} style={styles.shrink}>
      {actions && !disabled ? (
        <MenuView title={menuTitle} actions={actions} onPressAction={({ nativeEvent }) => onAction?.(nativeEvent.event)}>
          {body}
        </MenuView>
      ) : body}
    </Animated.View>
  );
});

const styles = StyleSheet.create((theme) => ({
  shrink: { flexShrink: 1, minWidth: 0 },
  pill: {
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  text: { flexShrink: 1, maxWidth: 220, fontSize: 13.5, color: theme.tokens.text.muted },
  strong: { fontWeight: '600', color: theme.tokens.text.primary },
  disabled: { opacity: 0.5 },
}));
