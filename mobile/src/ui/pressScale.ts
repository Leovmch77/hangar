import { useReducedMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

// Toque com encolhida leve (0.96): o retorno visual de botão que não pinta fundo ao apertar.
// Com "Reduzir movimento" ligado, nada se mexe.
export function usePressScale() {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return {
    style,
    onPressIn: () => { if (!reduced) scale.value = withTiming(0.96, { duration: 90 }); },
    onPressOut: () => { scale.value = withTiming(1, { duration: reduced ? 0 : 160 }); },
  };
}
