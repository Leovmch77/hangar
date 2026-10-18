import type { ReactNode } from 'react';
import type { AccessibilityValue, Insets, StyleProp, ViewStyle } from 'react-native';
import { BaseButton } from 'react-native-gesture-handler';

// Botão para a faixa de arrasto da gaveta (borda esquerda). Fechada, a gaveta ativa o arrasto no
// primeiro movimento (minDistance 0 no gesture-handler) e cancelava qualquer toque com o tremor
// normal do dedo. Este botão ativa ao encostar e não deixa o arrasto interrompê-lo.
export function EdgeButton({ onPress, style, hitSlop, accessibilityLabel, accessibilityValue, children }: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number | Insets;
  accessibilityLabel: string;
  accessibilityValue?: AccessibilityValue;
  children: ReactNode;
}) {
  return (
    <BaseButton
      onPress={onPress}
      shouldActivateOnStart
      disallowInterruption
      hitSlop={hitSlop}
      style={style}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue}
    >
      {children}
    </BaseButton>
  );
}
