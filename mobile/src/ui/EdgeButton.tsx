import type { ReactNode } from 'react';
import { View, type AccessibilityValue, type Insets, type StyleProp, type ViewStyle } from 'react-native';
import { BaseButton } from 'react-native-gesture-handler';

// Botão para a faixa de arrasto da gaveta (borda esquerda). Fechada, a gaveta ativa o arrasto no
// primeiro movimento (minDistance 0 no gesture-handler) e cancelava qualquer toque com o tremor
// normal do dedo. Este botão ativa ao encostar e não deixa o arrasto interrompê-lo.
// A acessibilidade fica no filho: no BaseButton o leitor de tela não opera o botão.
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
      onPress={(pointerInside) => { if (pointerInside) onPress(); }}
      shouldActivateOnStart
      disallowInterruption
      hitSlop={hitSlop}
    >
      <View
        style={style}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={accessibilityValue}
      >
        {children}
      </View>
    </BaseButton>
  );
}
