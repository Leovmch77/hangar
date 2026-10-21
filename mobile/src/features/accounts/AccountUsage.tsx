import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { formatElapsed, motivoCotaAntiga, quotaFailureReason, resetsIn, type Credencial } from '@hangar/core';
import * as m from '../../paraglide/messages';

const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);

// `grow`: nasce vazia e cresce até o valor (primeira pintura); leitura nova anima de onde estava.
function Fill({ pct, animate, grow, delay }: { pct: number; animate: boolean; grow: boolean; delay: number }) {
  const width = useSharedValue(animate && grow ? 0 : pct);
  const first = useRef(true);
  useEffect(() => {
    const wait = first.current ? delay : 0;
    first.current = false;
    width.value = animate ? withDelay(wait, withTiming(pct, { duration: 700, easing: EASE_OUT })) : pct;
  }, [pct, animate]);
  const style = useAnimatedStyle(() => ({ width: `${width.value}%` as `${number}%` }));
  return <Animated.View style={[styles.fill, style]} />;
}

export function AccountUsage({ credential, animate = false, grow = false }: { credential: Credencial; animate?: boolean; grow?: boolean }) {
  const q = credential.cota;
  const windows = q?.estado === 'lida' ? q.janelas.filter(w => Number.isFinite(w.pct)) : [];
  const note = !q ? m.mobile_accounts_quota_absent()
    : q.estado === 'sem_credencial' || q.estado === 'expirada'
      ? q.motivo === 'sessao-viva' ? m.native_accounts_quota_live_session()
      : q.motivo === 'renovacao-falhou' ? m.native_accounts_quota_open_session() : m.native_accounts_quota_sign_in()
    : q.estado === 'indisponivel' ? m.mobile_accounts_quota_unavailable()
    : !windows.length ? m.mobile_accounts_quota_empty() : '';
  const age = q?.idade_s ?? (q?.ts != null ? Math.max(0, Date.now() / 1000 - q.ts) : null);
  const cause = q?.estado === 'lida' ? motivoCotaAntiga(q)
    : q?.estado === 'indisponivel' && q.motivo ? quotaFailureReason(q.motivo) : null;
  return (
    <View style={styles.block}>
      {note ? <Text style={styles.muted}>{note}</Text> : null}
      {windows.map((w, index) => {
        const reset = resetsIn(w.reset_ts);
        return (
          <View key={`${w.rotulo}:${index}`} style={styles.window}>
            <Text style={styles.label}>{w.rotulo} · {Math.round(w.pct)}%</Text>
            <View style={styles.track} accessibilityRole="progressbar"
              accessibilityLabel={w.rotulo} accessibilityValue={{ min: 0, max: 100, now: Math.max(0, Math.min(100, w.pct)) }}>
              <Fill pct={Math.max(0, Math.min(100, w.pct))} animate={animate} grow={grow} delay={120 + 18 * index} />
            </View>
            {reset ? <Text style={styles.muted}>{m.mobile_accounts_quota_reset({ when: reset })}</Text> : null}
          </View>
        );
      })}
      {age != null && Number.isFinite(age) ? <Text style={styles.muted}>{m.mobile_accounts_quota_age({ age: formatElapsed(age) })}</Text> : null}
      {cause ? <Text style={styles.warning}>{cause}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  block: { gap: theme.base.space[2] },
  window: { gap: theme.base.space[1] },
  label: { fontSize: theme.base.text.xs, color: theme.tokens.text.primary },
  muted: { fontSize: theme.base.text.xxs, color: theme.tokens.text.muted },
  warning: { fontSize: theme.base.text.xxs, color: theme.tokens.status.warning },
  track: { height: 4, borderRadius: theme.base.radius.full, overflow: 'hidden', backgroundColor: theme.tokens.bg.hover },
  fill: { height: 4, borderRadius: theme.base.radius.full, backgroundColor: theme.tokens.accent.base },
}));
