import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import * as m from '../paraglide/messages';

const BAR = 3;
const GAP = 2;
const MIN = 6;
const HEIGHT = 40;

function Bar({ index, levels, reduced }: { index: number; levels: SharedValue<number[]>; reduced: boolean }) {
  const style = useAnimatedStyle(() => {
    const level = levels.value[index];
    // Posição ainda sem amostra fica vazia: a onda cresce da esquerda, como no PC.
    const height = level === undefined ? 0 : MIN + Math.min(1, Math.max(0, level)) * (HEIGHT - MIN);
    return { height: reduced ? height : withTiming(height, { duration: 90 }) };
  });
  return <Animated.View style={[styles.bar, style]} />;
}

// A faixa de gravação do app de PC (dictation.rs render_dictation): "Gravando", o tempo em m:ss,
// a onda de barras que anda da direita para a esquerda e o Cancelar, que descarta o áudio.
export function RecordingWave({ rms, onCancel }: { rms: number; onCancel?: () => void }) {
  const reduced = useReducedMotion();
  const [slots, setSlots] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const levels = useSharedValue<number[]>([]);

  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(tick);
  }, []);

  // Cada leitura do microfone (a cada 55 ms) vira uma barra nova na ponta direita.
  useEffect(() => {
    if (!slots) return;
    const next = [...levels.value, rms];
    levels.value = next.length > slots ? next.slice(next.length - slots) : next;
  }, [rms, slots, levels]);

  return (
    <View style={styles.row}>
      <Text style={styles.label} accessibilityRole="text" accessibilityLiveRegion="polite">{m.native_dictation_active()}</Text>
      <Text style={styles.time}>{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</Text>
      <View
        style={styles.wave}
        accessibilityRole="progressbar"
        accessibilityLabel={m.native_dictation_level()}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.min(1, rms) * 100) }}
        onLayout={(e) => setSlots(Math.min(160, Math.floor(e.nativeEvent.layout.width / (BAR + GAP))))}
      >
        {Array.from({ length: slots }, (_, i) => <Bar key={i} index={i} levels={levels} reduced={reduced} />)}
      </View>
      {onCancel ? (
        <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={8} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelTxt}>{m.native_dictation_cancel()}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 14, color: theme.tokens.text.muted },
  time: { fontSize: 14, fontFamily: theme.base.fontMono, color: theme.tokens.text.muted, fontVariant: ['tabular-nums'] },
  wave: { flex: 1, minWidth: 0, height: HEIGHT, flexDirection: 'row', alignItems: 'center', gap: GAP, overflow: 'hidden' },
  bar: { width: BAR, borderRadius: BAR, backgroundColor: theme.tokens.accent.base },
  cancel: { minHeight: 32, paddingHorizontal: 8, borderRadius: 6, justifyContent: 'center' },
  pressed: { backgroundColor: theme.tokens.border.subtle },
  cancelTxt: { fontSize: 14, color: theme.tokens.text.secondary },
}));
