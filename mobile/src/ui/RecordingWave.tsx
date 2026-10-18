import { memo, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useFrameCallback, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
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
export const RecordingWave = memo(function RecordingWave({ rms, onCancel }: { rms: SharedValue<number>; onCancel?: () => void }) {
  const reduced = useReducedMotion();
  const [slots, setSlots] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const levels = useSharedValue<number[]>([]);
  const lastSample = useSharedValue(0);

  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);

  // A onda avança na UI mesmo quando o nível permanece igual entre as amostras.
  useFrameCallback(({ timestamp }) => {
    if (!slots || timestamp - lastSample.value < 55) return;
    lastSample.value = timestamp;
    const next = [...levels.value, rms.value];
    levels.value = next.length > slots ? next.slice(next.length - slots) : next;
  });

  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.label} accessibilityRole="text" accessibilityLiveRegion="polite">{m.native_dictation_active()}</Text>
        <Text style={styles.time}>{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</Text>
        {onCancel ? (
          <Pressable onPress={onCancel} accessibilityRole="button" style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
            <Text style={styles.cancelTxt}>{m.native_dictation_cancel()}</Text>
          </Pressable>
        ) : null}
      </View>
      <View
        style={styles.wave}
        accessibilityRole="progressbar"
        accessibilityLabel={m.native_dictation_level()}
        accessibilityValue={{ min: 0, max: 100 }}
        onLayout={(e) => setSlots(Math.min(160, Math.floor(e.nativeEvent.layout.width / (BAR + GAP))))}
      >
        {Array.from({ length: slots }, (_, i) => <Bar key={i} index={i} levels={levels} reduced={reduced} />)}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: { gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  label: { fontSize: theme.base.text.sm, fontWeight: '600', color: theme.tokens.text.primary },
  time: { fontSize: theme.base.text.sm, fontFamily: theme.base.fontMono, color: theme.tokens.text.primary, fontVariant: ['tabular-nums'] },
  wave: { width: '100%', minWidth: 0, height: HEIGHT, flexDirection: 'row', alignItems: 'center', gap: GAP, overflow: 'hidden' },
  bar: { width: BAR, borderRadius: BAR, backgroundColor: theme.tokens.accent.base },
  cancel: { minWidth: 44, minHeight: 44, marginLeft: 'auto', paddingHorizontal: 8, borderRadius: 6, justifyContent: 'center' },
  pressed: { backgroundColor: theme.tokens.border.subtle },
  cancelTxt: { fontSize: theme.base.text.sm, color: theme.tokens.text.primary },
}));
