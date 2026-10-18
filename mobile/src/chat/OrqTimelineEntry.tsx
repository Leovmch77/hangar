import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { bodyPreview, decidedByBadge, intlLocale, pct, type ChatEvent, type OrqDecidedBy, type OrqLine } from '@hangar/core';
import { mkMarkdownStyle } from './AssistantBubble';
import { onOrqLinkPress, OrqDocument } from '../features/orchestration/OrqDocument';
import { Icon } from '../ui/Icon';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';

const BADGES: Record<string, (input: { p: string; category: string }) => string> = {
  orq_badge_rule_mark: m.orq_badge_rule_mark,
  orq_badge_rule_orchestrator: m.orq_badge_rule_orchestrator,
  orq_badge_alarm: m.orq_badge_alarm,
  orq_badge_jev_woke: m.orq_badge_jev_woke,
  orq_badge_jev_woke_bare: m.orq_badge_jev_woke_bare,
  orq_badge_jev_dropped: m.orq_badge_jev_dropped,
  orq_badge_jev_would_drop: m.orq_badge_jev_would_drop,
  orq_badge_regex_woke: m.orq_badge_regex_woke,
  orq_badge_regex_dropped: m.orq_badge_regex_dropped,
  orq_badge_regex_would_drop: m.orq_badge_regex_would_drop,
};
const CHOICES: Record<string, () => string> = {
  nothing: m.orq_choice_nothing, act: m.orq_choice_act, none: m.orq_choice_none,
};

function detailLines(decided: OrqDecidedBy | null | undefined): string[] {
  if (!decided) return [];
  const out: string[] = [];
  const j = decided.jev;
  if (j?.choice) {
    const p = j.probs?.[j.choice] ?? (j.choice === 'nothing' ? j.p : undefined);
    out.push(m.orq_detail_choice({ choice: CHOICES[j.choice]?.() ?? j.choice, p: p != null ? pct(p) : '' }).trim());
  }
  if (j?.veto && Object.keys(j.veto).length) {
    const number = (key: string) => j.veto[key] != null
      ? j.veto[key]!.toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–';
    out.push(m.orq_detail_vetoes({ context: number('context'), user: number('user'), problem: number('problem'), deviation: number('deviation') }));
  }
  if (decided.regex_agreed != null) out.push(decided.regex_agreed ? m.orq_detail_regex_agreed() : m.orq_detail_regex_disagreed());
  if (j?.error) out.push(m.orq_detail_jev_error({ error: j.error }));
  return out;
}

function lineText(line: OrqLine | null, raw: string): string {
  switch (line?.code) {
    case 'opened': {
      const describe = (session: (typeof line.sessions)[number] | undefined) => {
        if (!session) return '';
        const model = [session.provider, session.model].filter(Boolean).join(' · ');
        return model ? `${session.name} (${model})` : session.name;
      };
      const [executor, reviewer] = line.sessions;
      return reviewer ? m.orq_line_opened({ executor: describe(executor), reviewer: describe(reviewer) })
        : m.orq_line_opened_solo({ executor: describe(executor) });
    }
    case 'integrated': return line.merge ? m.orq_line_integrated() : m.orq_line_integrated_direct();
    case 'delivered': return m.orq_line_delivered({ round: line.round, commit: line.commit ?? '' }).replace(/\s*·\s*$/, '');
    case 'red_back': return m.orq_line_red_back({ executor: line.executor });
    case 'red_retry': return m.orq_line_red_retry();
    default: return raw;
  }
}

const localTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString(intlLocale(), {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function dayLabel(ts: number): string {
  const date = new Date(ts * 1000);
  const time = localTime(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return m.orq_day_today({ time });
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return m.orq_day_yesterday({ time });
  return m.orq_day_date({ date: date.toLocaleDateString(intlLocale(), { day: '2-digit', month: '2-digit' }), time });
}

export const OrqTimelineEntry = memo(function OrqTimelineEntry({ event, serverId, sessionName, dayTs }: {
  event: ChatEvent;
  serverId?: string;
  sessionName?: string;
  dayTs?: number;
}) {
  const { theme } = useUnistyles();
  const orq = event.orq;
  const time = useMemo(() => event.ts != null ? localTime(event.ts) : '', [event.ts]);
  const day = dayTs != null ? <Text style={styles.day}>{dayLabel(dayTs)}</Text> : null;
  const body = orq && ['advance', 'notice', 'woke', 'would_drop', 'dropped', 'failed'].includes(orq.kind)
    ? orq.body : orq?.body || event.text || '';
  const preview = useMemo(() => bodyPreview(body), [body]);
  const md = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const details = useMemo(() => detailLines(orq?.decided_by), [orq?.decided_by]);
  const badge = useMemo(() => {
    if (!orq?.decided_by) return '';
    const b = decidedByBadge(orq.decided_by, orq.kind);
    return (BADGES[b.key]?.({ p: b.p != null ? pct(b.p) : '', category: b.category ?? '' }) ?? '').replace(/\s*·\s*$/, '');
  }, [orq?.decided_by, orq?.kind]);
  const detailDefault = orq?.kind === 'dropped';
  const [detailToggled, setDetailToggled] = useState<boolean | null>(null);
  const detailOpen = detailToggled ?? detailDefault;
  const toggleDetail = useCallback(() => setDetailToggled((value) => !(value ?? detailDefault)), [detailDefault]);
  const [documentOpen, setDocumentOpen] = useState(false);
  const openDocument = useCallback(() => setDocumentOpen(true), []);
  const closeDocument = useCallback(() => setDocumentOpen(false), []);
  if (!orq) return <Text>{event.text}</Text>;
  const questionAndError = <>
    {orq.question ? <View style={styles.question}>
      <Text style={styles.task}>{m.orq_question()}</Text>
      <EnrichedMarkdownText markdown={orq.question} markdownStyle={md} flavor="github" onLinkPress={onOrqLinkPress} />
    </View> : null}
    {orq.error ? <Text style={styles.error} accessibilityRole="alert">{m.orq_failed_reason({ error: orq.error })}</Text> : null}
  </>;
  const fileName = orq.parecer?.split(/[\\/]/).pop();
  const parecer = orq.parecer ? <>
    {serverId && sessionName ? <Pressable onPress={openDocument} accessibilityRole="button" style={styles.file}>
      <Icon name="FileText" size={18} color={theme.tokens.accent.base} />
      <Text style={styles.actionText}>{m.orq_open_parecer()} · {fileName}</Text>
    </Pressable> : <Text style={styles.secondary}>{fileName}</Text>}
    {documentOpen && serverId && sessionName ? <OrqDocument serverId={serverId} name={sessionName} path={orq.parecer} onClose={closeDocument} /> : null}
  </> : null;
  if (orq.kind !== 'advance' && orq.kind !== 'notice') {
    const sender = orq.sender ? m.orq_sender_to_arbiter({ sender: orq.sender }) : m.orq_sender_unknown();
    const label = orq.kind === 'dropped' ? sender : orq.kind === 'failed'
      ? orq.origin === 'notify' ? m.orq_label_not_delivered() : m.orq_label_step_failed()
      : m.orq_label_woke();
    const rejected = orq.rejected_round != null;
    return <View style={styles.entry}>{day}<View style={styles.card}>
      <View style={styles.meta}>
        <Icon name={rejected ? 'X' : orq.kind === 'failed' ? 'CircleAlert' : orq.kind === 'dropped' ? 'CircleDashed' : 'Scale'}
          size={18} color={rejected || orq.kind === 'failed' ? theme.tokens.status.error : theme.tokens.text.secondary} />
        <Text style={styles.task}>{label}</Text>
        {orq.task != null ? <Text style={styles.tag}>{`T${orq.task}`}</Text> : null}
        {orq.mark === 'decisao' ? <Text style={styles.warning}>{m.orq_tag_decision()}</Text> : null}
        {orq.alarm ? <Text style={styles.warning}>{m.orq_tag_alarm()}</Text> : null}
        {rejected ? <Text style={styles.error}>{m.orq_tag_rejected({ round: orq.rejected_round! })}</Text> : null}
        {badge ? details.length ? <Pressable onPress={toggleDetail} accessibilityRole="button" accessibilityState={{ expanded: detailOpen }} style={styles.badge}>
          <Text style={styles.secondary}>{badge}</Text>
        </Pressable> : <Text style={styles.secondary}>{badge}</Text> : null}
        {time ? <Text style={styles.secondary}>{time}</Text> : null}
      </View>
      {orq.sender && orq.kind !== 'dropped' ? <Text style={styles.secondary}>{sender}</Text> : null}
      {body ? <>
        <View style={orq.kind === 'dropped' ? styles.faded : undefined}>
          <EnrichedMarkdownText markdown={expanded ? body : preview.text} markdownStyle={md} flavor="github" onLinkPress={onOrqLinkPress} />
        </View>
        {preview.cut ? <Pressable onPress={toggleExpanded} accessibilityRole="button" accessibilityState={{ expanded }} style={styles.action}>
          <Text style={styles.actionText}>{expanded ? m.orq_see_less() : m.orq_see_all()}</Text>
        </Pressable> : null}
      </> : null}
      {questionAndError}
      {detailOpen && details.length ? <Text style={styles.secondary}>{details.join(' · ')}</Text> : null}
      {parecer}
    </View></View>;
  }
  const code = orq.line?.code;
  const dot = code === 'integrated' ? theme.tokens.status.success
    : code === 'red_back' || code === 'red_retry' ? theme.tokens.status.error
    : orq.kind === 'notice' ? theme.tokens.status.warning : theme.tokens.accent.base;
  return <View style={styles.entry}>{day}<View style={styles.line}>
    <View style={[styles.dot, { backgroundColor: dot }]} />
    {orq.task != null ? <Text style={styles.task}>{`T${orq.task}`}</Text> : null}
    <Text style={styles.phrase}>{lineText(orq.line, orq.task != null ? (event.text ?? '').replace(/^T\d+:\s*/, '') : event.text ?? '')}</Text>
    {time ? <Text style={styles.secondary}>{time}</Text> : null}
  </View>{questionAndError}{parecer}</View>;
});

const styles = StyleSheet.create((theme) => ({
  entry: { gap: theme.base.space[2] },
  day: { color: theme.tokens.text.muted, fontSize: theme.base.text.xs, textAlign: 'center' },
  faded: { opacity: 0.62 },
  badge: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[2],
    borderWidth: 1, borderColor: theme.tokens.border.subtle, borderRadius: theme.base.radius.sm },
  question: { gap: theme.base.space[1] },
  action: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: theme.base.space[1] },
  actionText: { color: theme.tokens.accent.base, fontSize: theme.base.text.xs, flexShrink: 1 },
  file: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], minHeight: 44 },
  card: { padding: theme.base.space[3], gap: theme.base.space[2], borderRadius: theme.base.radius.md,
    borderWidth: 1, borderColor: theme.tokens.border.subtle, backgroundColor: superficie(theme) },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.base.space[2] },
  secondary: { color: theme.tokens.text.secondary, fontSize: theme.base.text.xs },
  tag: { color: theme.tokens.text.primary, fontSize: theme.base.text.xs, backgroundColor: theme.tokens.bg.hover,
    paddingHorizontal: theme.base.space[1], borderRadius: theme.base.radius.sm },
  warning: { color: theme.tokens.status.warning, fontSize: theme.base.text.xs },
  error: { color: theme.tokens.status.error, fontSize: theme.base.text.xs },
  line: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2] },
  dot: { width: 6, height: 6, borderRadius: theme.base.radius.full },
  task: { color: theme.tokens.text.primary, fontSize: theme.base.text.xs, fontWeight: theme.base.weight.semibold },
  phrase: { flex: 1, color: theme.tokens.text.secondary, fontSize: theme.base.text.sm },
}));
