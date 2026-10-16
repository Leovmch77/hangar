import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { formatElapsed, motivoCotaAntiga, resetsIn, type Credencial } from '@hangar/core';
import * as m from '../../paraglide/messages';

export function AccountUsage({ credential }: { credential: Credencial }) {
  const q = credential.cota;
  const windows = q?.estado === 'lida' ? q.janelas.filter(w => Number.isFinite(w.pct)) : [];
  const note = !q ? m.mobile_accounts_quota_absent()
    : q.estado === 'sem_credencial' ? m.mobile_accounts_quota_missing()
    : q.estado === 'expirada' ? m.mobile_accounts_quota_expired()
    : q.estado === 'indisponivel' ? m.mobile_accounts_quota_unavailable()
    : !windows.length ? m.mobile_accounts_quota_empty() : '';
  const age = q?.idade_s ?? (q?.ts != null ? Math.max(0, Date.now() / 1000 - q.ts) : null);
  const cause = motivoCotaAntiga(q);
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
              <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, w.pct))}%` }]} />
            </View>
            {reset ? <Text style={styles.muted}>{m.mobile_accounts_quota_reset({ when: reset })}</Text> : null}
          </View>
        );
      })}
      {age != null && Number.isFinite(age) ? <Text style={styles.muted}>{m.mobile_accounts_quota_age({ age: formatElapsed(age) })}</Text> : null}
      {cause ? <Text style={styles.warning}>{cause}</Text>
        : q?.motivo ? <Text style={styles.muted}>{m.mobile_accounts_quota_reason({ reason: q.motivo })}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  block: { gap: 8 },
  window: { gap: 4 },
  label: { fontSize: 13, color: theme.tokens.text.primary },
  muted: { fontSize: 12, color: theme.tokens.text.muted },
  warning: { fontSize: 12, color: theme.tokens.status.warning },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: theme.tokens.bg.hover },
  fill: { height: 4, borderRadius: 2, backgroundColor: theme.tokens.accent.base },
}));
