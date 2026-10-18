import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { intlLocale, motivoCotaAntiga, motivoLoginIndisponivel, quotaFailureReason, resetsIn, type Credencial } from '@hangar/core';
import { Icon } from '../ui/Icon';
import { superficie } from '../theme/superficie';
import { accountFolder } from './sessionAccountOptions';
import * as m from '../paraglide/messages';

type Props = { label: string; context?: string | null; credential?: Credencial; path?: string; pct?: number | null;
  full?: boolean; unconfirmed?: boolean; current?: boolean; disabled?: boolean; onPress?: () => void };

export function SessionAccountCard({ label, context, credential, path, pct, full, unconfirmed, current, disabled, onPress }: Props) {
  const { theme } = useUnistyles();
  const quota = credential?.cota;
  const windows = quota?.estado === 'lida' ? quota.janelas.filter(w => Number.isFinite(w.pct)) : [];
  const exhausted = full || windows.some(w => !w.por_modelo && w.pct >= 99);
  const tone = (value: number) => value >= 95 ? theme.tokens.status.error : value >= 70 ? theme.tokens.status.warning : theme.tokens.status.success;
  const folder = accountFolder(credential, path);
  const email = credential?.login?.email;
  const plan = credential?.login?.plano;
  const reason = quota?.estado === 'lida' ? motivoCotaAntiga(quota)
    : quota?.motivo === 'sessao-viva' ? m.native_accounts_quota_live_session()
    : quota?.motivo === 'renovacao-falhou' ? m.native_accounts_quota_open_session()
    : quota?.motivo ? quotaFailureReason(quota.motivo) : null;
  const loginReason = credential ? motivoLoginIndisponivel(credential) : null;
  const loginNote = unconfirmed ? m.mobile_account_login_unknown() : '';
  const quotaNote = pct == null ? m.conta_cota_sem_leitura() : full ? m.conta_cota_cheia({ pct }) : m.conta_cota_uso({ pct });
  const windowDetails = windows.map(window => {
    const reset = resetsIn(window.reset_ts);
    const date = window.reset_ts && Number.isFinite(window.reset_ts) ? new Date(window.reset_ts * 1000) : null;
    const when = date ? [reset, date.toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ') : '';
    return { ...window, resetLabel: when ? m.mobile_accounts_quota_reset({ when }) : m.mobile_account_reset_unknown() };
  });
  const spoken = [email, folder, plan, exhausted ? m.mobile_account_exhausted() : '', loginNote,
    ...windowDetails.map(w => `${w.rotulo} ${Math.round(w.pct)}%, ${w.resetLabel}`),
    !windows.length ? quotaNote : '', reason, loginReason].filter(Boolean).join(', ');
  const body = <>
    {current ? <View style={styles.badge}><Icon name="CircleCheck" size={14} color={theme.tokens.accent.base} />
      <Text style={styles.current}>{m.mobile_account_current()}</Text></View> : null}
    <View style={styles.heading}>
      <View style={[styles.avatar, { backgroundColor: current ? theme.tokens.accent.dim : superficie(theme, 0.6) }]}>
        <Icon name="CircleUser" size={22} color={current ? theme.tokens.accent.base : theme.tokens.text.secondary} />
      </View>
      <View style={styles.identity}>
        <Text style={styles.title}>{label}</Text>
        {context ? <Text style={styles.detail}>{context}</Text> : null}
        {email ? <Text selectable={!onPress} style={styles.detail}>{email}</Text> : null}
        {folder ? <Text selectable={!onPress} style={styles.folder}>{folder}</Text> : null}
      </View>
      {!current && onPress ? <Icon name="ChevronRight" size={18} color={theme.tokens.text.muted} /> : null}
    </View>
    {plan || exhausted || unconfirmed ? <View style={styles.tags}>
      {plan ? <Text style={styles.plan}>{plan}</Text> : null}
      {exhausted ? <Text style={[styles.status, { color: theme.tokens.status.error }]}>{m.mobile_account_exhausted()}</Text> : null}
      {unconfirmed ? <Text style={[styles.status, { color: theme.tokens.status.warning }]}>{loginNote}</Text> : null}
    </View> : null}
    {windowDetails.map((window, index) => {
      const value = Math.max(0, Math.min(100, window.pct));
      return <View key={`${window.rotulo}:${index}`} style={styles.window}>
        <View style={styles.quotaHeader}><Text style={styles.windowLabel}>{window.rotulo}</Text>
          <Text style={[styles.percent, { color: tone(window.pct) }]}>{Math.round(window.pct)}%</Text></View>
        <View style={styles.track} accessibilityRole="progressbar" accessibilityLabel={window.rotulo} accessibilityValue={{ min: 0, max: 100, now: value }}>
          <View style={[styles.fill, { width: `${value}%`, backgroundColor: tone(window.pct) }]} />
        </View>
        <Text style={styles.reset}>{window.resetLabel}</Text>
      </View>;
    })}
    {!windows.length ? <Text style={styles.detail}>{quotaNote}</Text> : null}
    {!windows.length && (!quota || quota.estado === 'lida') ? <Text style={styles.reset}>{m.mobile_account_windows_unknown()}</Text> : null}
    {quota?.estado === 'expirada' || quota?.estado === 'sem_credencial' ? <Text style={styles.warning}>{m.native_accounts_quota_sign_in()}</Text> : null}
    {reason ? <Text style={styles.warning}>{reason}</Text> : null}
    {loginReason ? <Text style={styles.warning}>{loginReason}</Text> : null}
  </>;
  const card = [styles.card, { backgroundColor: superficie(theme, 0.4) }, current && styles.active, exhausted && !current && styles.exhausted];
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={[email, folder].filter(Boolean).join(', ')}
    accessibilityValue={{ text: spoken }} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [...card, pressed && styles.pressed]}>{body}</Pressable> : <View style={card}>{body}</View>;
}

const styles = StyleSheet.create(theme => ({
  card: { borderRadius: theme.base.radius.lg, borderWidth: 1, borderColor: theme.tokens.border.subtle, padding: 16, gap: 12, minHeight: 44 },
  active: { borderColor: theme.tokens.accent.base },
  exhausted: { opacity: 0.65 },
  pressed: { opacity: 0.75 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  identity: { flex: 1, minWidth: 0, gap: 3 },
  title: { fontSize: theme.base.text.base, fontWeight: '600', color: theme.tokens.text.primary },
  detail: { fontSize: theme.base.text.xs, color: theme.tokens.text.secondary },
  folder: { fontSize: theme.base.text.xxs, fontFamily: theme.base.fontMono, color: theme.tokens.text.muted },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  current: { fontSize: theme.base.text.xs, color: theme.tokens.accent.base, fontWeight: '600' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  plan: { fontSize: theme.base.text.xxs, color: theme.tokens.text.secondary, backgroundColor: theme.tokens.fillSubtle, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  status: { fontSize: theme.base.text.xs, fontWeight: '500' },
  window: { gap: 5 },
  quotaHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  windowLabel: { fontSize: theme.base.text.xs, color: theme.tokens.text.secondary },
  percent: { fontSize: theme.base.text.xs, fontWeight: '600', fontVariant: ['tabular-nums'] },
  track: { height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.tokens.bg.hover },
  fill: { height: '100%', borderRadius: 3 },
  reset: { fontSize: theme.base.text.xxs, color: theme.tokens.text.muted },
  warning: { fontSize: theme.base.text.xxs, color: theme.tokens.status.warning },
}));
