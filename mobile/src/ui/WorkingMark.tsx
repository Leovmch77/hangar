import { createContext, useContext, useEffect } from 'react';
import { View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

// A marca "trabalhando" do app de PC (WorkingMark em desktop-native/src/app/chrome.rs), no quadro
// de 24: raio, abertura, atraso de entrada e atraso do giro de cada arco. Mesmos números de lá.
const ARCS = [[9.1, 30, 0, 0], [6.35, 18, 0.09, 0.48], [3.6, 6, 0.18, 0.96]] as const;
const STROKE = 1.55;
const DRAW = 0.72;
const LOOP = 0.9;
const CYCLE = 3.2;
const ease = Easing.bezierFn(0.23, 1, 0.32, 1);

// Marca fora da vista (tela por baixo da pilha, gaveta fechada) para no quadro em que está.
export const WorkingMarkPaused = createContext(false);

const AnimatedPath = Animated.createAnimatedComponent(Path);

function span(c: number, from: number, to: number) {
  'worklet';
  return ease(Math.min(1, Math.max(0, (c - from) / (to - from))));
}

// Só a entrada altera o traço; o giro usa Views para não redesenhar a geometria do SVG.
function arcPath(k: number, t: number) {
  'worklet';
  const [radius, gap, enter] = ARCS[k];
  const drawn = t < enter ? 0 : ease(Math.min(1, (t - enter) / DRAW));
  if (drawn <= 0) return { d: 'M12 12', strokeOpacity: 0, strokeWidth: STROKE };
  const r = radius;
  const start = ((180 - gap) * Math.PI) / 180;
  const sweepDeg = (180 + 2 * gap) * drawn;
  const end = start + (sweepDeg * Math.PI) / 180;
  const x0 = 12 + r * Math.cos(start);
  const y0 = 12 + r * Math.sin(start);
  const x1 = 12 + r * Math.cos(end);
  const y1 = 12 + r * Math.sin(end);
  return {
    d: `M${x0} ${y0}A${r} ${r} 0 ${sweepDeg > 180 ? 1 : 0} 1 ${x1} ${y1}`,
    strokeOpacity: 1,
    strokeWidth: STROKE,
  };
}

function Arc({ k, entry, phase, size, color }: {
  k: number; entry: SharedValue<number>; phase: SharedValue<number>; size: number; color: string;
}) {
  const props = useAnimatedProps(() => arcPath(k, entry.value));
  const style = useAnimatedStyle(() => {
    const whole = (phase.value % CYCLE) / CYCLE;
    let scale = 1;
    if (whole >= 0.63 && whole < 0.78) scale = 1 - 0.56 * span(whole, 0.63, 0.78);
    else if (whole >= 0.78 && whole < 0.9) scale = 0.44 + 0.62 * span(whole, 0.78, 0.9);
    else if (whole >= 0.9) scale = 1.06 - 0.06 * span(whole, 0.9, 1);
    const elapsed = phase.value - ARCS[k][3];
    const p = elapsed >= 0 ? (elapsed % CYCLE) / CYCLE : -1;
    let turn = p >= 0 && p < 0.33 ? 360 * span(p, 0, 0.33) : 0;
    if (whole >= 0.63) turn += 360 * (k + 1) * span(whole, 0.63, 1);
    return { transform: [{ rotate: `${turn}deg` }, { scale }] };
  });
  return (
    <Animated.View style={[{ position: 'absolute', width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeLinecap="round">
        <AnimatedPath animatedProps={props} />
      </Svg>
    </Animated.View>
  );
}

// Relógios e estilos ficam na UI; o JS só inicia e cancela ao mudar a visibilidade.
export function WorkingMark({ size = 16, color }: { size?: number; color: string }) {
  const reduced = useReducedMotion();
  const paused = useContext(WorkingMarkPaused);
  const running = !reduced && !paused;
  const entry = useSharedValue(reduced ? LOOP : 0);
  const phase = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      entry.value = LOOP;
      phase.value = 0;
    }
    if (!running) return;
    const remaining = Math.max(0, LOOP - entry.value) * 1000;
    entry.value = withTiming(LOOP, { duration: remaining, easing: Easing.linear });
    const loop = withRepeat(withTiming(phase.value + CYCLE, { duration: CYCLE * 1000, easing: Easing.linear }), -1, false);
    phase.value = remaining > 0 ? withDelay(remaining, loop) : loop;
    return () => {
      cancelAnimation(entry);
      cancelAnimation(phase);
    };
  }, [running, reduced, entry, phase]);
  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      {ARCS.map((_, k) => <Arc key={k} k={k} entry={entry} phase={phase} size={size} color={color} />)}
    </View>
  );
}
