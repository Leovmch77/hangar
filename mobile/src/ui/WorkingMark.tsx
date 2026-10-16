import { createContext, useContext, useEffect } from 'react';
import Animated, { Easing, useAnimatedProps, useFrameCallback, useReducedMotion, useSharedValue, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

// A marca "trabalhando" do app de PC (WorkingMark em desktop-native/src/app/chrome.rs), no quadro
// de 24: raio, abertura, atraso de entrada e atraso do giro de cada arco. Mesmos números de lá.
const ARCS = [[9.1, 30, 0, 0], [6.35, 18, 0.09, 0.48], [3.6, 6, 0.18, 0.96]] as const;
const STROKE = 1.55;
const DRAW = 0.72;
const LOOP = 0.9;
const CYCLE = 3.2;
const ease = Easing.bezierFn(0.23, 1, 0.32, 1);
// Cada quadro redesenha o SVG; 20 por segundo bastam para o giro e esquentam bem menos o aparelho.
const FRAME_S = 0.05;

// Marca fora da vista (tela por baixo da pilha, gaveta fechada) para no quadro em que está.
export const WorkingMarkPaused = createContext(false);

const AnimatedPath = Animated.createAnimatedComponent(Path);

function span(c: number, from: number, to: number) {
  'worklet';
  return ease(Math.min(1, Math.max(0, (c - from) / (to - from))));
}

// Fração do ciclo desde `start`, ou -1 antes dele.
function cycle(t: number, start: number) {
  'worklet';
  return t >= start ? ((t - start) % CYCLE) / CYCLE : -1;
}

// `t` negativo é a marca completa e parada (Reduzir movimento).
function arco(k: number, t: number) {
  'worklet';
  const [radius, gap, enter, phase] = ARCS[k];
  let scale = 1;
  let drawn = 1;
  let turn = 0;
  if (t >= 0) {
    const whole = cycle(t, LOOP);
    if (whole >= 0.63 && whole < 0.78) scale = 1 - 0.56 * span(whole, 0.63, 0.78);
    else if (whole >= 0.78 && whole < 0.9) scale = 0.44 + 0.62 * span(whole, 0.78, 0.9);
    else if (whole >= 0.9) scale = 1.06 - 0.06 * span(whole, 0.9, 1);
    drawn = t < enter ? 0 : ease(Math.min(1, (t - enter) / DRAW));
    const p = cycle(t, LOOP + phase);
    if (p >= 0 && p < 0.33) turn = 360 * span(p, 0, 0.33);
    if (whole >= 0.63) turn += 360 * (k + 1) * span(whole, 0.63, 1);
  }
  if (drawn <= 0) return { d: 'M12 12', strokeOpacity: 0, strokeWidth: STROKE };
  const r = radius * scale;
  const start = ((180 - gap + turn) * Math.PI) / 180;
  const sweepDeg = (180 + 2 * gap) * drawn;
  const end = start + (sweepDeg * Math.PI) / 180;
  const x0 = 12 + r * Math.cos(start);
  const y0 = 12 + r * Math.sin(start);
  const x1 = 12 + r * Math.cos(end);
  const y1 = 12 + r * Math.sin(end);
  return {
    d: `M${x0} ${y0}A${r} ${r} 0 ${sweepDeg > 180 ? 1 : 0} 1 ${x1} ${y1}`,
    strokeOpacity: 1,
    strokeWidth: STROKE * scale,
  };
}

function Arco({ k, t }: { k: number; t: SharedValue<number> }) {
  const props = useAnimatedProps(() => arco(k, t.value));
  return <AnimatedPath animatedProps={props} />;
}

// Escala desenhada na geometria, não em transform: o quadro inteiro roda na thread de UI.
export function WorkingMark({ size = 16, color }: { size?: number; color: string }) {
  const reduced = useReducedMotion();
  const paused = useContext(WorkingMarkPaused);
  const running = !reduced && !paused;
  const t = useSharedValue(reduced ? -1 : 0);
  // O relógio do quadro zera a cada religada: a base faz a marca seguir de onde parou.
  const base = useSharedValue(0);
  const frame = useFrameCallback((f) => {
    const now = base.value + f.timeSinceFirstFrame / 1000;
    if (now >= t.value && now - t.value < FRAME_S) return;
    t.value = now;
  }, running);
  // O autostart só vale na montagem: ligar "Reduzir movimento" ou sair da vista também a para.
  useEffect(() => {
    if (!running) base.value = Math.max(0, t.value);
    frame.setActive(running);
    if (reduced) t.value = -1;
  }, [running, reduced, frame, t, base]);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeLinecap="round" pointerEvents="none">
      {ARCS.map((_, k) => <Arco key={k} k={k} t={t} />)}
    </Svg>
  );
}
