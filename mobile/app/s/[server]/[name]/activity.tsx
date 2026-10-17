import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { formatElapsed, getSubagents, getWorkflow, getWorkflowAgent, getWorkflows } from '@hangar/core';
import type { SubagentRun, WorkflowDetail, WorkflowAgentDetail, WorkflowSummary } from '@hangar/core';
import { chatStore } from '../../../../src/stores/chat';
import { useServers } from '../../../../src/stores/servers';
import { useActivity } from '../../../../src/features/activity/useActivity';
import { TaskRows } from '../../../../src/features/activity/TaskRows';
import { WorkflowList } from '../../../../src/features/activity/WorkflowList';
import { WorkflowDetailView } from '../../../../src/features/activity/WorkflowDetailView';
import { AgentDetailView } from '../../../../src/features/activity/AgentDetailView';
import { SubagentLive, subagentProblemText, subagentStatus } from '../../../../src/features/activity/SubagentLive';
import * as m from '../../../../src/paraglide/messages';
import { superficie } from '../../../../src/theme/superficie';
import { HeaderBack, useGlassHeader } from '../../../../src/ui/glassHeader';
import { Icon } from '../../../../src/ui/Icon';

type Level = 'list' | 'workflow' | 'agent' | 'subagent';

export default function ActivitySheet() {
  const { theme } = useUnistyles();
  const header = useGlassHeader();
  const headerHeight = useHeaderHeight();
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : (params.server ?? '');
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? '');
  const listKey = JSON.stringify([serverId, name]);

  const chat = chatStore(serverId, name);
  const events = chat.use((s) => s.events);
  // Processos vivos lidos do sistema pelo backend (vêm no `state` do stream que o chat já mantém).
  const processos = chat.use((s) => s.stateEvent?.shells) ?? [];
  const activity = useActivity(events);
  // Relógio do "há N" dos shells; com a folha aberta só.
  const [agora, setAgora] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now() / 1000), 20_000);
    return () => clearInterval(t);
  }, []);

  const server = useServers((s: any) => s.servers.find((x: any) => x.id === serverId) ?? null);

  const [level, setLevel] = useState<Level>('list');
  const [runId, setRunId] = useState<string | null>(null);
  const [list, setList] = useState<{ key: string; workflows: WorkflowSummary[]; subs: SubagentRun[]; workflowLoading: boolean; subLoading: boolean; workflowError: string; subError: string }>({ key: listKey, workflows: [], subs: [], workflowLoading: true, subLoading: true, workflowError: '', subError: '' });
  const currentList = list.key === listKey;
  const workflows = currentList ? list.workflows : [];
  const subs = currentList ? list.subs : [];
  const listLoading = !currentList || list.workflowLoading || list.subLoading;
  const workflowListError = currentList ? list.workflowError : '';
  const subError = currentList ? list.subError : '';
  const [olderOpen, setOlderOpen] = useState(false);
  const [wfLoading, setWfLoading] = useState(false);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [agentDetail, setAgentDetail] = useState<WorkflowAgentDetail | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  // Separado de `detail === null`: sem isto, "a rede caiu" e "esse run não existe" mostravam a
  // mesma frase, e quem estava com a conexão instável ficava lendo que o run tinha sumido.
  const [wfError, setWfError] = useState('');
  const [agentError, setAgentError] = useState('');
  // Qual agente está aberto: o "tentar de novo" precisa saber o que recarregar, e `subAgentId` é
  // de outro nível da navegação (subagente), não deste.
  const [agentAberto, setAgentAberto] = useState<string | null>(null);
  const [subAgentId, setSubAgentId] = useState<string | null>(null);
  const [subTitle, setSubTitle] = useState('');
  const genWf = useRef(0);
  const genAgent = useRef(0);
  const genList = useRef(0);
  const genSubs = useRef(0);

  const fetchAll = useCallback(async () => {
    // Sem o servidor da rota (lista ainda carregando ou máquina removida) não pergunta ao ativo.
    if (!server) return;
    const generation = ++genList.current;
    const subGeneration = ++genSubs.current;
    setList({ key: listKey, workflows: [], subs: [], workflowLoading: true, subLoading: true, workflowError: '', subError: '' });
    await Promise.all([
      getWorkflows(name, server).then(
        (workflows) => {
          if (generation === genList.current) setList((current) => ({ ...current, workflows, workflowLoading: false }));
        },
        () => {
          if (generation === genList.current) setList((current) => ({ ...current, workflowLoading: false, workflowError: m.atividade_erro_run() }));
        },
      ),
      getSubagents(name, server).then(
        (subs) => {
          if (generation === genList.current && subGeneration === genSubs.current) setList((current) => ({ ...current, subs, subLoading: false }));
        },
        () => {
          if (generation === genList.current && subGeneration === genSubs.current) setList((current) => ({ ...current, subLoading: false, subError: m.atividade_erro_subagentes() }));
        },
      ),
    ]);
  }, [listKey, name, server]);

  const refreshSubs = useCallback(async () => {
    if (!server) return;
    const generation = genList.current;
    const subGeneration = ++genSubs.current;
    setList((current) => current.key === listKey ? { ...current, subLoading: true, subError: '' } : current);
    try {
      const subs = await getSubagents(name, server);
      if (generation !== genList.current || subGeneration !== genSubs.current) return;
      setList((current) => ({ ...current, subs, subLoading: false, subError: '' }));
    } catch {
      if (generation !== genList.current || subGeneration !== genSubs.current) return;
      setList((current) => ({ ...current, subLoading: false, subError: m.atividade_erro_subagentes() }));
    }
  }, [listKey, name, server]);

  useEffect(() => {
    setLevel('list');
    setRunId(null);
    setDetail(null);
    setAgentDetail(null);
    setSubAgentId(null);
    setSubTitle('');
    setOlderOpen(false);
    void fetchAll();
    return () => { genList.current += 1; };
  }, [fetchAll, name, serverId]);

  const agentSignature = JSON.stringify(activity.agents.filter((agent) => agent.kind === 'agent').map((agent) => [agent.id, agent.running]));
  const previousAgents = useRef({ key: listKey, signature: agentSignature });
  useEffect(() => {
    const previous = previousAgents.current;
    previousAgents.current = { key: listKey, signature: agentSignature };
    if (previous.key === listKey && previous.signature !== agentSignature) void refreshSubs();
  }, [agentSignature, listKey, refreshSubs]);

  // helpers de matching (casamento por prompt, como no frontend)
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const matchSub = useCallback(
    (prompt?: string): SubagentRun | null => {
      if (!prompt) return null;
      const full = norm(prompt);
      const exact = subs.find((s) => s.prompt && norm(s.prompt) === full);
      if (exact) return exact;
      const head = full.slice(0, 400);
      return subs.find((s) => s.prompt && norm(s.prompt).startsWith(head)) ?? null;
    },
    [subs],
  );

  function parentRunning(agentId: string): boolean | null {
    const parent = activity.agents.find((a) => matchSub(a.prompt)?.agentId === agentId);
    return parent ? parent.running : null;
  }

  const subRows = subs.map((run) => ({
    run,
    status: subagentStatus(run, parentRunning(run.agentId), agora * 1000),
    at: Date.parse(run.endedAt ?? '') || Date.parse(run.updatedAt) || run.mtime * 1000,
  }));
  const runningAgents = activity.agents.filter((a) => {
    if (a.kind !== 'agent' || !a.running) return false;
    const sub = matchSub(a.prompt);
    return !sub || subRows.find((row) => row.run.agentId === sub.agentId)?.status === 'running';
  });
  const shown = new Set(runningAgents.map((a) => matchSub(a.prompt)?.agentId));
  const runningSubs = subRows.filter((row) => row.status === 'running' && !shown.has(row.run.agentId));
  const uncertainSubs = subRows.filter((row) => row.status === 'silent' || row.status === 'unknown');
  const finishedSubs = subRows.filter((row) => row.status === 'finished' || row.status === 'failed');
  const midnight = new Date(agora * 1000).setHours(0, 0, 0, 0);
  const olderSubs = finishedSubs.filter((row) => row.at < midnight);
  const recentSubs = finishedSubs.filter((row) => !(row.at < midnight));
  const runningCount = runningAgents.length + runningSubs.length;
  const shellsVivos = activity.shells.filter((s2) => s2.running);
  const ha = (desde: number) => m.atividade_shell_ha({ t: formatElapsed(agora - desde) });
  const paiRodando = subAgentId ? parentRunning(subAgentId) : null;

  function tituloDoSub(s2: SubagentRun): string {
    const linhas = (s2.prompt ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const util = linhas.find((l) => !/^base directory for this skill:/i.test(l) && !l.startsWith('#'));
    return (util ?? linhas[0] ?? s2.agentId).slice(0, 90);
  }

  function renderSub({ run, status, at }: (typeof subRows)[number]) {
    const ended = status === 'finished' || status === 'failed';
    const date = new Date(at);
    const clock = Number.isFinite(at) ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : null;
    let endedLabel = '';
    if (status === 'failed') {
      endedLabel = clock ? m.atividade_parou({ h: clock }) : m.formato_tool_falhou();
    } else if (status === 'finished') {
      endedLabel = clock ? m.atividade_terminou({ h: clock }) : m.atividade_sub_concluido();
    }
    return (
      <Pressable key={run.agentId} onPress={() => abrirDoDisco(run)} style={[styles.agentRow, styles.agentOpenable, ended && styles.concluido]} accessibilityRole="button">
        <View style={styles.agentBody}>
          <View style={styles.agentHead}>
            <Text style={[styles.agentDesc, { color: theme.tokens.text.primary }]} numberOfLines={1}>{tituloDoSub(run)}</Text>
            {run.agentType ? <Text style={[styles.tag, { color: theme.tokens.text.secondary, backgroundColor: superficie(theme, 0.8) }]}>{run.agentType}</Text> : null}
          </View>
          <Text style={[styles.agentNow, { color: theme.tokens.text.muted }]} numberOfLines={1}>
            {ended ? `${endedLabel} · ` : ''}
            {status === 'silent' ? `${m.atividade_sem_noticia({ t: formatElapsed(agora - at / 1000) })} · ` : ''}
            {run.ilegivel ? m.atividade_sub_ilegivel() : run.problema ? '' : m.atividade_chamadas({ n: run.toolCalls })}
            {!run.ilegivel && !run.problema && run.recent.length ? ` · ${run.recent[run.recent.length - 1]?.name ?? ''}` : ''}
          </Text>
          {run.problema ? <Text style={[styles.err, { color: theme.tokens.status.warning }]} accessibilityRole="alert">{subagentProblemText(run.problema)}</Text> : null}
        </View>
        <Icon name="ChevronRight" size={18} color={theme.tokens.text.muted} />
      </Pressable>
    );
  }

  async function openWorkflow(rid: string) {
    const g = ++genWf.current;
    setRunId(rid);
    setLevel('workflow');
    setDetail(null);
    setWfLoading(true);
    setWfError('');
    try {
      const d = await getWorkflow(name, rid, server);
      if (g !== genWf.current) return;
      setDetail(d);
    } catch {
      if (g !== genWf.current) return;
      setDetail(null);
      setWfError(m.atividade_erro_run());
    } finally {
      if (g === genWf.current) setWfLoading(false);
    }
  }

  async function openAgent(agentId: string | null) {
    if (!runId || !agentId) return;
    const g = ++genAgent.current;
    setLevel('agent');
    setAgentAberto(agentId);
    setAgentDetail(null);
    setAgentLoading(true);
    setAgentError('');
    try {
      const d = await getWorkflowAgent(name, runId, agentId, server);
      if (g !== genAgent.current) return;
      setAgentDetail(d);
    } catch {
      if (g !== genAgent.current) return;
      setAgentDetail(null);
      setAgentError(m.atividade_erro_run());
    } finally {
      if (g === genAgent.current) setAgentLoading(false);
    }
  }

  function abrirDoDisco(s2: SubagentRun) {
    setSubTitle(tituloDoSub(s2));
    setSubAgentId(s2.agentId);
    setLevel('subagent');
  }

  function openSubagent(prompt: string | undefined, title: string) {
    const match = matchSub(prompt);
    if (!match) return;
    setSubTitle(title);
    setSubAgentId(match.agentId);
    setLevel('subagent');
  }

  const back = useCallback(() => {
    if (level === 'subagent') {
      setSubAgentId(null);
      setSubTitle('');
      setLevel('list');
      void refreshSubs();
      return;
    }
    if (level === 'agent') {
      setLevel('workflow');
      setAgentDetail(null);
      return;
    }
    if (level === 'workflow') {
      setLevel('list');
      setDetail(null);
      setRunId(null);
    }
  }, [level, refreshSubs]);

  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (level === 'list') return false;
      back();
      return true;
    });
    return () => sub.remove();
  }, [back, level]));

  const headerTitle = level === 'list' ? m.ctx_atividade() : level === 'subagent' ? subTitle || m.atividade_subagente() : level === 'workflow' ? (detail?.name ?? m.atividade_workflow()) : (agentDetail?.label ?? m.atividade_agente());
  const countBadge = level === 'list' && activity.total > 0 ? `${activity.done}/${activity.total}` : null;
  const wfBadge = level === 'workflow' && detail ? detail.status : null;
  const headerOptions = {
    ...header,
    headerShown: Platform.OS !== 'android',
    title: headerTitle,
    headerLeft: level === 'list' ? undefined : () => <HeaderBack onPress={back} />,
    headerRight: countBadge ? () => <Text style={[styles.count, { color: theme.tokens.text.secondary }]}>{countBadge}</Text> : wfBadge ? () => (
      <Text style={[styles.wfStatus, wfBadge === 'completed' ? { color: theme.tokens.status.success } : wfBadge === 'running' ? { color: theme.tokens.accent.base } : { color: theme.tokens.text.secondary }]}>{wfBadge}</Text>
    ) : undefined,
    sheetAllowedDetents: [0.92],
    sheetGrabberVisible: true,
    contentStyle: { backgroundColor: 'transparent' },
  };

  const androidHeader = Platform.OS === 'android' ? (
    <View style={styles.header}>
      {headerOptions.headerLeft?.()}
      <Text style={[styles.title, { color: theme.tokens.text.primary }]} numberOfLines={1} accessibilityRole="header">{headerTitle}</Text>
      {headerOptions.headerRight?.()}
    </View>
  ) : null;

  if (!server) {
    return (
      <>
        <Stack.Screen options={headerOptions} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.root, { backgroundColor: theme.tokens.bg.base, paddingTop: Platform.OS === 'android' ? 0 : headerHeight }]}>
          {androidHeader}
          <Text style={[styles.error, { color: theme.tokens.status.error }]}>{m.compare_servidor_nao_encontrado()}</Text>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={headerOptions} />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.root, { backgroundColor: theme.tokens.bg.base, paddingTop: Platform.OS === 'android' || (level === 'list' && Platform.OS === 'ios') ? 0 : headerHeight }]}>
        {androidHeader}
        {level === 'list' ? (
          <ScrollView contentContainerStyle={styles.body} contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
            {workflows.length > 0 ? <WorkflowList workflows={workflows} onSelect={openWorkflow} /> : null}
            {listLoading ? (
              <View style={styles.center}>
                <ActivityIndicator color={theme.tokens.text.muted} />
                <Text style={[styles.muted, { color: theme.tokens.text.muted }]}>{m.comum_carregando()}</Text>
              </View>
            ) : null}

            {runningAgents.length > 0 || runningSubs.length > 0 ? (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.tokens.text.muted }]}>{m.atividade_grupo_rodando({ n: runningCount })}</Text>
                {runningAgents.map((a) => {
                  const sub = matchSub(a.prompt);
                  const isButton = !!sub;
                  const Row = isButton ? Pressable : View;
                  return (
                    // @ts-ignore — Pressable/View condicionais
                    <Row
                      key={a.id}
                      onPress={isButton ? () => openSubagent(a.prompt, a.description) : undefined}
                      style={[styles.agentRow, isButton && styles.agentOpenable]}
                      accessibilityRole={isButton ? 'button' : undefined}
                    >
                      <Text style={[styles.spin, { color: theme.tokens.accent.base }]}>◐</Text>
                      <View style={styles.agentBody}>
                        <View style={styles.agentHead}>
                          <Text style={[styles.agentDesc, { color: theme.tokens.text.primary }]} numberOfLines={1}>
                            {a.description}
                          </Text>
                          {a.subagentType ? <Text style={[styles.tag, { color: theme.tokens.text.secondary, backgroundColor: superficie(theme, 0.8) }]}>{a.subagentType}</Text> : null}
                          {a.model ? <Text style={[styles.tag, styles.tagMuted, { color: theme.tokens.text.muted }]}>{a.model}</Text> : null}
                        </View>
                        {sub ? (
                          <Text style={[styles.agentNow, { color: theme.tokens.text.muted }]} numberOfLines={1}>
                            {sub.ilegivel ? m.atividade_sub_ilegivel() : sub.problema ? '' : m.atividade_chamadas({ n: sub.toolCalls })}
                            {!sub.ilegivel && !sub.problema && sub.recent.length ? ` · ${sub.recent[sub.recent.length - 1]?.name ?? ''}` : ''}
                          </Text>
                        ) : null}
                        {sub?.problema ? <Text style={[styles.err, { color: theme.tokens.status.warning }]} accessibilityRole="alert">{subagentProblemText(sub.problema)}</Text> : null}
                      </View>
                      {sub ? <Icon name="ChevronRight" size={18} color={theme.tokens.text.muted} /> : null}
                    </Row>
                  );
                })}
                {runningSubs.map(renderSub)}
              </View>
            ) : null}

            {uncertainSubs.length > 0 ? (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.tokens.text.muted }]}>{m.atividade_subagentes()}</Text>
                {uncertainSubs.map(renderSub)}
              </View>
            ) : null}

            {finishedSubs.length > 0 ? (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.tokens.text.muted }]}>{m.atividade_grupo_terminados({ n: finishedSubs.length })}</Text>
                {recentSubs.map(renderSub)}
                {olderSubs.length > 0 ? (
                  <>
                    <Pressable onPress={() => setOlderOpen((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: olderOpen }} style={styles.olderToggle}>
                      <Icon name={olderOpen ? 'ChevronDown' : 'ChevronRight'} size={18} color={theme.tokens.text.muted} />
                      <Text style={[styles.label, { color: theme.tokens.text.muted }]}>{m.atividade_grupo_antigos({ n: olderSubs.length })}</Text>
                    </Pressable>
                    {olderOpen ? olderSubs.map(renderSub) : null}
                  </>
                ) : null}
              </View>
            ) : null}

            {/* Shells de fundo que ainda rodam: o terminal diz "N shells still running", aqui diz qual.
                Sem toque: a saída de cada um volta pro chat quando ele termina. */}
            {shellsVivos.length > 0 ? (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.tokens.text.muted }]}>
                  {m.atividade_shells()} <Text style={{ color: theme.tokens.accent.base }}>{m.atividade_shells_rodando({ n: shellsVivos.length })}</Text>
                </Text>
                {shellsVivos.map((s2) => (
                  <View key={s2.id} style={styles.agentRow} accessible accessibilityLabel={s2.command}>
                    <ActivityIndicator size="small" color={theme.tokens.accent.base} />
                    <View style={styles.agentBody}>
                      <Text style={[styles.shellCmd, { color: theme.tokens.text.primary }]} numberOfLines={2}>{s2.rotulo}</Text>
                      {s2.description || s2.ts ? (
                        <Text style={[styles.agentNow, { color: theme.tokens.text.muted }]} numberOfLines={1}>
                          {[s2.description, s2.ts ? ha(s2.ts) : ''].filter(Boolean).join(' · ')}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Processos vivos agora, lidos do sistema: pega o que o transcript não sabe (comando de
                subagente, de antes de um /clear). É o que explica a sessão parada com shell pendurado. */}
            {processos.length > 0 ? (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.tokens.text.muted }]}>
                  {m.atividade_processos()} <Text style={{ color: theme.tokens.accent.base }}>{m.atividade_processos_n({ n: processos.length })}</Text>
                </Text>
                {processos.map((p) => (
                  <View key={p.pid} style={styles.agentRow} accessible accessibilityLabel={p.cmd}>
                    <ActivityIndicator size="small" color={theme.tokens.accent.base} />
                    <View style={styles.agentBody}>
                      <Text style={[styles.shellCmd, { color: theme.tokens.text.primary }]} numberOfLines={2}>{p.cmd}</Text>
                      <Text style={[styles.agentNow, { color: theme.tokens.text.muted }]} numberOfLines={1}>
                        pid {p.pid}{p.desde ? ` · ${ha(p.desde)}` : ''}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {activity.tasks.length > 0 ? <TaskRows tasks={activity.tasks} /> : null}
            {workflowListError ? <Text style={[styles.err, { color: theme.tokens.status.warning }]} accessibilityRole="alert">{workflowListError}</Text> : null}
            {subError ? <Text style={[styles.err, { color: theme.tokens.status.warning }]} accessibilityRole="alert">{subError}</Text> : null}
            {workflowListError || subError ? (
              <Pressable onPress={() => void fetchAll()} style={styles.olderToggle} accessibilityRole="button">
                <Text style={[styles.muted, { color: theme.tokens.accent.base }]}>{m.sync_retry()}</Text>
              </Pressable>
            ) : null}
            {!listLoading && !workflowListError && !subError && workflows.length === 0 && activity.tasks.length === 0 && runningAgents.length === 0 && subs.length === 0 && shellsVivos.length === 0 && processos.length === 0 ? <Text style={[styles.empty, { color: theme.tokens.text.muted }]}>{m.atividade_vazio()}</Text> : null}
          </ScrollView>
        ) : level === 'workflow' ? (
          <WorkflowDetailView
            detail={detail}
            loading={wfLoading}
            onAgent={openAgent}
            erro={wfError}
            onTentar={() => runId && openWorkflow(runId)}
          />
        ) : level === 'agent' ? (
          <AgentDetailView
            detail={agentDetail}
            loading={agentLoading}
            erro={agentError}
            onTentar={() => openAgent(agentAberto)}
          />
        ) : level === 'subagent' && subAgentId ? (
          <View style={styles.subagentDetail}>
            <SubagentLive key={`${serverId}::${name}::${subAgentId}`} server={server} sessionName={name} agentId={subAgentId} paiRodando={paiRodando} />
          </View>
        ) : (
          <View style={styles.center}>
            <Text style={[styles.muted, { color: theme.tokens.text.muted }]}>{m.atividade_sem_transcript()}</Text>
          </View>
        )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: theme.base.space[4], paddingVertical: theme.base.space[2], gap: theme.base.space[2] },
  title: { flex: 1, fontSize: theme.base.text.lg, fontWeight: '600' },
  count: { fontFamily: theme.base.fontMono, fontSize: theme.base.text.sm, fontVariant: ['tabular-nums'] },
  wfStatus: { fontSize: theme.base.text.xs, fontWeight: '600', paddingHorizontal: theme.base.space[2], paddingVertical: 2, borderRadius: theme.base.radius.full, overflow: 'hidden' },
  body: { padding: theme.base.space[4], gap: theme.base.space[4], paddingBottom: theme.base.space[6] },
  subagentDetail: { flex: 1, minHeight: 0, paddingHorizontal: theme.base.space[4] },
  section: { gap: theme.base.space[2] },
  olderToggle: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1], minHeight: 44, minWidth: 44 },
  label: { fontSize: theme.base.text.xs, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '600' },
  center: { alignItems: 'center', gap: theme.base.space[2], paddingVertical: theme.base.space[4] },
  muted: { fontSize: theme.base.text.sm, textAlign: 'center' },
  empty: { fontSize: theme.base.text.sm, textAlign: 'center', paddingVertical: theme.base.space[4] },
  err: { fontSize: theme.base.text.xs, marginTop: theme.base.space[2] },
  agentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.base.space[2], paddingVertical: theme.base.space[1] },
  agentOpenable: { minHeight: 44, paddingHorizontal: theme.base.space[1], marginHorizontal: -theme.base.space[1], borderRadius: theme.base.radius.sm },
  spin: { fontSize: theme.base.text.sm, marginTop: 2 },
  agentBody: { flex: 1, gap: 3, minWidth: 0 },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1], minWidth: 0 },
  agentDesc: { fontSize: theme.base.text.sm, minWidth: 0, flexShrink: 1 },
  tag: { fontFamily: theme.base.fontMono, fontSize: theme.base.text.xxxs, paddingHorizontal: 6, paddingVertical: 1, borderRadius: theme.base.radius.full, overflow: 'hidden' },
  tagMuted: {},
  agentNow: { fontFamily: theme.base.fontMono, fontSize: theme.base.text.xxxs },
  shellCmd: { fontFamily: theme.base.fontMono, fontSize: theme.base.text.xs },
  concluido: { opacity: 0.6 },
  error: { fontSize: theme.base.text.sm, textAlign: 'center', padding: theme.base.space[4] },
}));
