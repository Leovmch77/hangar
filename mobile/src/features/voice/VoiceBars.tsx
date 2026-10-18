import { useContext, useEffect } from 'react';
import { View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { WorkingMarkPaused } from '../../ui/WorkingMark';
import { SPACE } from '../../theme/scale';

// `level`: segue o nível medido (você ou a voz). `wave`: onda contínua (ouvindo, pensando, botão ligado).
// `rest`: barras baixas paradas (silenciado, conectando).
export type VoiceBarsMode = { kind: 'level'; value: number } | { kind: 'wave'; fast: boolean } | { kind: 'rest' };

const MIN = 0.18;
const TAU = Math.PI * 2;
// Centro mais alto que as pontas: lê como onda mesmo com o nível baixo.
const shape = (count: number, i: number) => 0.55 + 0.45 * Math.sin(((i + 0.5) / count) * Math.PI);

function Bar({ i, count, height, width, color, mode, level, phase }: {
  i: number; count: number; height: number; width: number; color: string; mode: VoiceBarsMode;
  level: SharedValue<number>; phase: SharedValue<number>;
}) {
  const kind = mode.kind;
  const fast = mode.kind === 'wave' && mode.fast;
  const weight = shape(count, i);
  const style = useAnimatedStyle(() => {
    let s = MIN;
    if (kind === 'level') s = MIN + (1 - MIN) * level.value * weight * (0.65 + 0.35 * Math.abs(Math.sin(phase.value * 3 + i * 1.3)));
    else if (kind === 'wave') s = MIN + (fast ? 0.7 : 0.45) * weight * (0.5 + 0.5 * Math.sin(phase.value * (fast ? 2 : 1) - i * 0.9));
    return { transform: [{ scaleY: s }] };
  });
  return <Animated.View style={[styles.bar, { width, height, backgroundColor: color }, style]} />;
}

// Relógio na thread de UI; o JS só liga, desliga e passa o nível novo (que chega a 10 Hz).
export function VoiceBars({ mode, color, count = 5, height = 16, width = 3, gap = SPACE[0.5] }: {
  mode: VoiceBarsMode; color: string; count?: number; height?: number; width?: number; gap?: number;
}) {
  const reduced = useReducedMotion();
  const paused = useContext(WorkingMarkPaused);
  const running = !reduced && !paused && mode.kind !== 'rest';
  const phase = useSharedValue(0);
  const level = useSharedValue(0);
  const target = mode.kind === 'level' ? Math.max(0, Math.min(1, Number.isFinite(mode.value) ? mode.value : 0)) : 0;
  useEffect(() => {
    level.value = reduced ? target : withTiming(target, { duration: 100, easing: Easing.out(Easing.quad) });
  }, [target, reduced, level]);
  useEffect(() => {
    if (!running) return;
    phase.value = withRepeat(withTiming(phase.value + TAU, { duration: 1400, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(phase);
  }, [running, phase]);
  return (
    <View testID="voice-bars" style={[styles.row, { height, gap }]} pointerEvents="none"
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <Bar key={i} i={i} count={count} height={height} width={width} color={color} mode={mode} level={level} phase={phase} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'center' },
  bar: { borderRadius: theme.base.radius.full },
}));
