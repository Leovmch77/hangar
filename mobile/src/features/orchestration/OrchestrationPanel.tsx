import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, Text, View, type ListRenderItemInfo } from 'react-native';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { mkMarkdownStyle } from '../../chat/AssistantBubble';
import { formatElapsed, formataErro, getOrqHistoryPanelForServer, getOrqPanelForServer, intlLocale, pct, retentarAgora, taskRows, teamView, type AggSession, type OrqPanel, type OrqPanelTask, type OrqTeamRow, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { useSessions } from '../../stores/sessions';
import { Screen } from '../../ui/Screen';
import { onOrqLinkPress, OrqDocument } from './OrqDocument';
import { Icon } from '../../ui/Icon';
import * as m from '../../paraglide/messages';

export function useOrchestrationPanel(serverId: string, name: string, history = false) {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const ready = useServers(state => state.ready);
  const server = useServers(state => state.servers.find(item => item.id === serverId && !item.removed) ?? null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ server: Server | null; name: string; panel: OrqPanel | null; error: string | null }>({ server: null, name: '', panel: null, error: null });
  useEffect(() => { const subscription = AppState.addEventListener('change', state => setForeground(state === 'active')); return () => subscription.remove(); }, []);
  useEffect(() => {
    if (!ready || !server || server.invite || !focused || !foreground) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult(previous => previous.server === server && previous.name === name ? { ...previous, error: null } : { server, name, panel: null, error: null });
    async function load() {
      let poll = true;
      try {
        const panel = await (history ? getOrqHistoryPanelForServer(server!, name) : getOrqPanelForServer(server!, name));
        if (current) setResult({ server, name, panel, error: null });
        poll = !history || !panel.timing?.finished_at || (panel.consumption === null && !panel.errors.some(error => error.file === 'consumption'));
      } catch (error) {
        if (current) setResult(previous => ({ server, name, panel: previous.server === server && previous.name === name ? previous.panel : null, error: formataErro(error) ?? String(error) }));
      }
      if (current && poll) timer = setTimeout(load, history ? 5_000 : 10_000);
    }
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [ready, server, name, history, focused, foreground, attempt]);
  const matches = result.server === server && result.name === name;
  const error = ready && !server ? m.chat_servidor_removido() : server?.invite ? m.lista_acesso_recusado() : matches ? result.error : null;
  return { server, focused, panel: !server || server.invite || !matches ? null : result.panel, error, refresh: useCallback(() => { retentarAgora(serverId); setAttempt(value => value + 1); }, [serverId]) };
}

export function OrchestrationHeader({ title, serverLabel, onClose, historyAction }: { title: string; serverLabel?: string; onClose: () => void; historyAction?: () => void }) {
  const { theme } = useUnistyles();
  return <View style={styles.header}>
    <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={m.comum_voltar()} hitSlop={12}><Icon name="ChevronLeft" size={theme.base.text.xl} color={theme.tokens.text.secondary} /></Pressable>
    <View style={styles.rowBody}><Text style={styles.heading}>{title}</Text>{serverLabel ? <Text style={styles.note}>{serverLabel}</Text> : null}</View>
    {historyAction ? <Pressable onPress={historyAction} accessibilityRole="button" accessibilityLabel={m.orq_history_title()} hitSlop={12}><Icon name="History" size={theme.base.text.xl} color={theme.tokens.text.secondary} /></Pressable> : null}
  </View>;
}
export function OrchestrationStatus({ error, retry }: { error: string | null; retry?: () => void }) {
  const { theme } = useUnistyles();
  return <View style={styles.status}>{error ? <><Text style={styles.warning} accessibilityRole="alert">{m.orq_mobile_load_error()}</Text><Text style={styles.note}>{error}</Text>{retry ? <Pressable onPress={retry} accessibilityRole="button" accessibilityLabel={m.orq_panel_retry()}><Text style={[styles.text, styles.action]}>{m.orq_panel_retry()}</Text></Pressable> : null}</> : <><ActivityIndicator color={theme.tokens.text.muted} /><Text style={styles.note}>{m.orq_panel_loading()}</Text></>}</View>;
}
export function OrchestrationPanel() {
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : (params.server ?? '');
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? '');
  const router = useRouter();
  const { server, focused, panel, error, refresh } = useOrchestrationPanel(serverId, name);
  const live = useSessions(state => state.byServerRecord[serverId] ?? NO_LIVE);
  const retain = useSessions(state => state.retain);
  const [document, setDocument] = useState<string | null>(null);
  useEffect(() => { if (focused && server && !server.invite) return retain(); }, [focused, server, retain]);
  useEffect(() => setDocument(null), [serverId, name]);
  const openSession = useCallback((target: string) => router.push({ pathname: '/s/[server]/[name]', params: { server: serverId, name: target } } as never), [router, serverId]);
  const openArbiter = useCallback(() => {
    const rows = useSessions.getState().byServerRecord[serverId] ?? NO_LIVE;
    const arbiter = rows.find(session => session.name === name)?.orq_arbiter;
    if (arbiter) openSession(arbiter);
  }, [serverId, name, openSession]);
  const hasArbiter = Boolean(live.find(session => session.name === name)?.orq_arbiter);
  return <Screen><OrchestrationHeader title={m.orq_tab_title()} serverLabel={server?.label} onClose={() => router.back()} historyAction={server && !server.invite ? () => router.push({ pathname: '/config/orchestration-history', params: { server: serverId } } as never) : undefined} />
    {error || !panel ? <OrchestrationStatus error={error} retry={server && !server.invite ? refresh : undefined} /> : null}
    {panel ? <OrchestrationContent key={`${serverId}:${name}:${panel.run}`} panel={panel} live={live} onOpenSession={openSession} onOpenDocument={setDocument} onOpenArbiter={hasArbiter ? openArbiter : undefined} /> : null}
    {document && server && !server.invite ? <OrqDocument serverId={serverId} name={name} path={document} onClose={() => setDocument(null)} /> : null}
  </Screen>;
}

type Section = 'time' | 'tasks' | 'team' | 'decisions' | 'automation' | 'consumption' | 'integration';
const SECTIONS: Section[] = ['time', 'tasks', 'team', 'decisions', 'automation', 'consumption', 'integration'];
const NO_LIVE: AggSession[] = [];
type Row = { key: string; text: string; detail?: string; markdown?: true; warning?: boolean; heading?: boolean; onPress?: () => void; expanded?: boolean };
const keyOf = (row: Row) => row.key;
const PanelRow = memo(function PanelRow(item: Omit<Row, 'key'>) {
  const { theme } = useUnistyles();
  const markdownStyle = useMemo(() => item.markdown ? mkMarkdownStyle(theme) : undefined, [item.markdown, theme]);
  const body = <View style={styles.rowBody}>
    {item.markdown ? <EnrichedMarkdownText markdown={item.text} markdownStyle={markdownStyle} flavor="github" onLinkPress={onOrqLinkPress} /> : <Text style={[styles.text, item.heading && styles.heading, item.warning && styles.warning, item.onPress && !item.heading && styles.action]}>{item.text}</Text>}
    {item.detail ? <Text style={styles.note}>{item.detail}</Text> : null}
  </View>;
  return item.onPress ? <Pressable style={styles.row} accessibilityRole="button" accessibilityLabel={[item.text, item.detail].filter(Boolean).join(', ')} accessibilityState={item.expanded === undefined ? undefined : { expanded: item.expanded }} onPress={item.onPress}>
    {body}{item.expanded === undefined ? null : <Icon name={item.expanded ? 'ChevronDown' : 'ChevronRight'} size={theme.base.text.base} color={theme.tokens.text.muted} />}
  </Pressable> : <View style={styles.row}>{body}</View>;
});
const renderRow = ({ item: { key: _key, ...props } }: ListRenderItemInfo<Row>) => <PanelRow {...props} />;
export function orqWhen(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }) : value;
}
const number = (value: number) => value.toLocaleString(intlLocale());
const money = (value: number | null) => value == null ? '—' : `US$ ${value.toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function taskState(task: OrqPanelTask): string {
  const round = task.round ?? '—';
  switch (task.state) {
    case 'queued': return m.orq_state_queued();
    case 'executing': return m.orq_state_executing();
    case 'in_review': return m.orq_state_in_review({ round });
    case 'rejected': return m.orq_state_rejected({ round });
    case 'approved': return m.orq_state_approved({ round });
    case 'integrated': return m.orq_state_integrated();
    case 'integration_red': return m.orq_state_integration_red();
    default: return task.state;
  }
}
function teamStatus(row: OrqTeamRow): string {
  const round = row.status.round ?? '—';
  switch (row.status.key) {
    case 'orq_live_working': return m.orq_live_working();
    case 'orq_live_waiting': return m.orq_live_waiting();
    case 'orq_live_ended': return m.orq_live_ended();
    case 'orq_last_started': return m.orq_last_started();
    case 'orq_last_delivered': return m.orq_last_delivered({ round });
    case 'orq_last_approved': return m.orq_last_approved({ round });
    case 'orq_last_rejected': return m.orq_last_rejected({ round });
    case 'orq_last_swapped_in': return m.orq_last_swapped_in();
    default: return m.orq_live_idle();
  }
}
const mode = (value: string) => value === 'on' ? m.orq_mode_on() : value === 'shadow' ? m.orq_mode_shadow() : value === 'off' ? m.orq_mode_off() : value;

export function OrchestrationContent({ panel, history = false, live = NO_LIVE, onOpenSession, onOpenDocument, onOpenArbiter }: {
  panel: OrqPanel; serverId?: string; name?: string; history?: boolean; live?: AggSession[];
  onOpenSession?: (name: string) => void; onOpenDocument?: (path: string) => void; onOpenArbiter?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<Section>>(() => new Set());
  const [onlyPending, setOnlyPending] = useState(false);
  const [queuedOpen, setQueuedOpen] = useState(false);
  const [endedOpen, setEndedOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const rows = useMemo(() => {
    const out: Row[] = [];
    const text = (key: string, value: string, detail?: string, warning = false) => out.push({ key, text: value, detail, warning });
    const action = (key: string, label: string, onPress: () => void, expanded?: boolean) => out.push({ key, text: label, onPress, expanded });
    const section = (id: Section, title: string, summary?: string) => {
      out.push({ key: id, text: title, detail: summary, heading: true, expanded: !collapsed.has(id), onPress: () => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }) });
      return !collapsed.has(id);
    };
    if (panel.metadata) {
      out.push({ key: 'metadata', text: panel.metadata.title, detail: panel.metadata.repo, heading: true });
      text('plan', m.orq_history_plan({ path: panel.metadata.plan.trim() ? panel.metadata.plan : '—' }));
      if (panel.metadata.error) text('metadata-error', m.orq_mobile_metadata_read_error(), panel.metadata.error, true);
    }
    panel.errors.forEach((error, index) => text(`error-${index}`, m.orq_mobile_file_read_error({ file: error.file }), error.error, true));
    if (panel.empty) { text('empty', m.orq_panel_empty()); return out; }
    const allCollapsed = collapsed.size === SECTIONS.length;
    action('collapse', allCollapsed ? m.orq_expand_all() : m.orq_collapse_all(), () => setCollapsed(allCollapsed ? new Set() : new Set(SECTIONS)));
    if (section('time', m.orq_time_title(), formatElapsed(panel.timing?.elapsed_seconds))) {
      text('started', m.orq_time_started({ time: orqWhen(panel.timing?.started_at) }));
      if (panel.timing?.finished_at) text('finished', m.orq_time_finished({ time: orqWhen(panel.timing.finished_at) }));
      text('time-method', m.orq_time_method());
    }
    if (section('tasks', m.orq_tasks_title(), panel.tasks.total_known ? m.orq_tasks_count({ n: panel.tasks.integrated, total: panel.tasks.total }) : m.orq_tasks_count_unknown({ n: panel.tasks.integrated }))) {
      action('pending', onlyPending ? m.orq_show_all_tasks() : m.orq_show_pending_tasks(), () => setOnlyPending(value => !value));
      const pending = panel.tasks.rows.filter(task => !onlyPending || task.state !== 'integrated');
      const tasks = taskRows(pending);
      const addTask = (task: OrqPanelTask) => text(`task-${task.n}`, `T${task.n}${task.title.trim() ? ` · ${task.title}` : ''}`, `${taskState(task)} · ${m.orq_rodada()} ${task.round ?? '—'} · ${m.orq_task_elapsed({ time: formatElapsed(task.timing?.elapsed_seconds) })}`);
      if (!pending.length) text('no-pending', m.orq_no_pending_tasks());
      tasks.visible.forEach(addTask);
      if (onlyPending) tasks.queued.forEach(addTask);
      else if (tasks.queuedCount) {
        action('queued', m.orq_tasks_queued({ n: tasks.queuedCount }), () => setQueuedOpen(value => !value), queuedOpen);
        if (queuedOpen) tasks.queued.forEach(addTask);
      }
    }
    if (section('team', m.orq_team_title())) {
      const team = teamView(panel.team, new Map(live.map(session => [session.name, session.state])));
      const addMember = (row: OrqTeamRow, ended: boolean) => {
        const role = row.role === 'arbiter' ? m.orq_role_arbiter() : row.role === 'executor' ? m.orq_role_executor({ task: row.task ?? '—' }) : m.orq_role_reviewer({ task: row.task ?? '—' });
        out.push({ key: `member-${row.name}`, text: row.name, detail: `${role} · ${teamStatus(row)}`, onPress: history || ended ? undefined : row.role === 'arbiter' && row.current ? onOpenArbiter : onOpenSession ? () => onOpenSession(row.name) : undefined });
      };
      team.shown.forEach(row => addMember(row, false));
      if (team.ended.length) {
        action('ended', endedOpen ? m.orq_team_hide_ended() : m.orq_team_show_ended({ n: team.ended.length }), () => setEndedOpen(value => !value), endedOpen);
        if (endedOpen) team.ended.forEach(row => addMember(row, true));
      }
    }
    if (section('decisions', m.orq_decisions_title(), panel.decisions.length ? number(panel.decisions.length) : undefined)) {
      if (!panel.decisions.length) text('no-decisions', m.orq_decisions_none());
      panel.decisions.forEach((decision, index) => {
        out.push({ key: `decision-${index}`, text: decision.question, markdown: true, detail: `${decision.task == null ? '' : `T${decision.task} · `}${m.orq_decision_unanswered({ time: orqWhen(decision.ts) })}` });
        if (!history) {
          if (decision.parecer && onOpenDocument) action(`review-${index}`, m.orq_open_parecer(), () => onOpenDocument(decision.parecer!));
          if (onOpenArbiter) action(`arbiter-${index}`, m.orq_talk_to_arbiter(), onOpenArbiter);
        }
      });
    }
    const auto = panel.automation;
    if (section('automation', m.orq_auto_title(), m.orq_auto_mode({ jev: mode(auto.mode.jev), regex: mode(auto.mode.regex) }))) {
      text('woke', `${m.orq_auto_woke()}: ${number(auto.woke.total)}`, m.orq_auto_woke_detail(auto.woke));
      text('alone', `${m.orq_auto_alone()}: ${number(auto.alone.total)}`, m.orq_auto_alone_detail(auto.alone));
      text('dropped', `${m.orq_auto_dropped()}: ${number(auto.dropped_by_jev)}`);
      action('advanced', m.orq_adv_title(), () => setAdvancedOpen(value => !value), advancedOpen);
      if (advancedOpen) {
        const advanced = auto.advanced;
        text('would-drop', `${m.orq_adv_false_positive()}: ${number(advanced.would_drop)}`, m.orq_adv_false_positive_hint());
        text('disagree', `${m.orq_adv_disagree()}: ${m.orq_adv_disagree_value({ n: advanced.disagree, m: advanced.judged })}`, m.orq_adv_disagree_hint());
        const min = advanced.min_confidence;
        text('confidence', `${m.orq_adv_min_conf()}: ${min ? pct(min.p) : '—'}`, min ? `${min.choice} · ${orqWhen(min.ts)} · ${min.text}` : m.orq_adv_min_conf_hint());
        text('by-rule', `${m.orq_adv_by_rule()}: ${number(advanced.by_rule)}`, m.orq_adv_by_rule_hint());
      }
    }
    const usage = panel.consumption;
    if (section('consumption', m.orq_use_title(), usage ? m.orq_use_sessions(usage.sessions) : undefined)) {
      if (!usage) { if (!panel.errors.some(error => error.file === 'consumption')) text('computing', m.orq_use_computing()); }
      else {
        text('new', `${m.orq_use_new()}: ${number(usage.totals.new)}`);
        text('cache', `${m.orq_use_cache()}: ${number(usage.totals.cache_read)}`);
        text('cost', `${m.orq_use_cost()}: ${money(usage.totals.usd)}${usage.totals.usd_partial ? '*' : ''}`);
        const usageDetail = (value: { new: number; cache_read: number; usd: number | null }) => `${m.orq_use_col_new()}: ${number(value.new)} · ${m.orq_use_col_cache()}: ${number(value.cache_read)} · ${m.orq_use_col_cost()}: ${money(value.usd)}`;
        usage.providers.forEach((provider, index) => {
          text(`provider-${index}`, provider.provider, usageDetail(provider));
          provider.models.forEach((model, modelIndex) => text(`model-${index}-${modelIndex}`, m.orq_use_model_sessions({ model: model.model, n: model.sessions }), usageDetail(model)));
        });
        text('use-method', usage.until ? m.orq_use_method_completed({ since: orqWhen(usage.since), until: orqWhen(usage.until) }) : m.orq_use_method({ since: orqWhen(usage.since) }));
        if (usage.sessions.missing.length) text('missing', m.orq_use_missing({ names: usage.sessions.missing.join(', ') }), undefined, true);
        if (usage.missing_prices.length) text('prices', m.orq_use_no_price({ models: usage.missing_prices.join(', ') }), undefined, true);
      }
    }
    if (section('integration', m.orq_int_title())) {
      const integration = panel.integration;
      text('branch', `${m.orq_int_branch()}: ${integration.branch ?? '—'}`);
      text('last', `${m.orq_int_last()}: ${integration.last ? `T${integration.last.task} · ${integration.last.commit} · ${orqWhen(integration.last.ts)}` : m.orq_int_none()}`);
      const outcome = integration.outcome;
      if (outcome) text('outcome', outcome === 'green' ? m.orq_int_green() : outcome === 'red' ? m.orq_int_red() : outcome === 'conflict' ? m.orq_int_conflict() : outcome === 'failed' ? m.orq_int_failed() : outcome, undefined, outcome !== 'green');
      const checks = integration.delivery_checks;
      if (checks.total) text('checks', checks.ok >= checks.total ? m.orq_int_checks_green(checks) : m.orq_int_checks_red({ ...checks, tasks: checks.failing.map(task => `T${task}`).join(', ') }), undefined, checks.ok < checks.total);
      if (integration.red_log) text('red-log', integration.red_log, undefined, true);
    }
    return out;
  }, [panel, history, live, collapsed, onlyPending, queuedOpen, endedOpen, advancedOpen, onOpenSession, onOpenDocument, onOpenArbiter]);
  return <FlatList style={styles.list} contentContainerStyle={styles.content} data={rows} renderItem={renderRow} keyExtractor={keyOf} />;
}

const styles = StyleSheet.create(theme => ({
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3], padding: theme.base.space[4] },
  status: { padding: theme.base.space[4], gap: theme.base.space[3] },
  list: { flex: 1, backgroundColor: 'transparent' },
  content: { paddingBottom: theme.base.space[6] },
  row: { paddingHorizontal: theme.base.space[4], paddingVertical: theme.base.space[2], flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2] },
  rowBody: { flex: 1, gap: theme.base.space[1] },
  text: { color: theme.tokens.text.primary, fontSize: theme.base.text.sm },
  heading: { fontWeight: '600', fontSize: theme.base.text.base, color: theme.tokens.text.primary },
  note: { color: theme.tokens.text.muted, fontSize: theme.base.text.xs },
  warning: { color: theme.tokens.status.warning, fontSize: theme.base.text.sm },
  action: { color: theme.tokens.accent.base },
}));
