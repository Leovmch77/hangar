import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { fetchSessionsForServer, formataErro, getCredentialsForServer, getEnginesForServer, listAccountTargets, setSessionAccount, setSessionEngineAccount, type AccountTarget, type Server, type SessionInfo } from '@hangar/core';
import { chatStore } from '../stores/chat';
import { useServers } from '../stores/servers';
import { useSessions } from '../stores/sessions';
import { sessionAccountLabel } from './sessionAccountLabel';
import * as m from '../paraglide/messages';

type AccountSession = SessionInfo & { config_dir?: string | null; engine_account?: string | null; lifecycle_id?: string | null };
type SwitchTarget = AccountTarget & { engineAccount?: string; unavailable?: boolean };
type Catalog = { identity: string; loading: boolean; error: string; targets: SwitchTarget[]; restricted?: boolean };
type AccountTransition = { scope: string; source: AccountSession; destination: AccountSession };
type Feedback = { identity: string; error: string; success: string; transition?: AccountTransition };
const normalizedPath = (path?: string | null) => path?.replace(/\\/g, '/');
function movedTranscript(jsonl: string | null | undefined, configDir: string) {
  const parts = normalizedPath(jsonl)?.match(/\/projects\/([^/]+)\/([^/]+\.jsonl)$/);
  return parts ? `${normalizedPath(configDir)?.replace(/\/$/, '')}/projects/${parts[1]}/${parts[2]}` : jsonl;
}
function matchesTransition(transition: AccountTransition, scope: string, session: AccountSession | null) {
  if (scope !== transition.scope || !session) return false;
  const matches = (expected: AccountSession) => session.provider === expected.provider
    && session.engine === expected.engine && session.guest_kind === expected.guest_kind
    && session.conta === expected.conta && normalizedPath(session.jsonl) === normalizedPath(expected.jsonl)
    && (session.config_dir == null || normalizedPath(session.config_dir) === normalizedPath(expected.config_dir ?? expected.conta?.replace(/^claude:/, '')))
    && (session.engine_account == null || session.engine_account === expected.engine_account);
  return matches(transition.source) || matches(transition.destination)
    || matches({ ...transition.destination, jsonl: transition.source.jsonl });
}
const readableError = (error: unknown) => (error instanceof Error ? error.message : formataErro(error)) || m.native_invalid_response();
const serverIdentity = (serverId: string, name: string, server?: Server) => JSON.stringify([
  serverId, name, server?.baseUrl, server?.token, server?.removed, server?.invite, server?.inviteEnded,
]);
const sessionIdentity = (scope: string, session: AccountSession | null) => JSON.stringify([
  scope, session?.jsonl, session?.provider, session?.engine, session?.conta,
  session?.config_dir, session?.engine_account, session?.guest_kind, session?.lifecycle_id,
]);

export function SessionAccount({ serverId, name }: { serverId: string; name: string }) {
  const { theme } = useUnistyles();
  const headerHeight = useHeaderHeight();
  const ready = useServers(s => s.ready);
  const server = useServers(s => s.servers.find(x => x.id === serverId));
  const row = useSessions(s => s.rows.find(x => x.serverId === serverId && x.name === name));
  const bucket = useSessions(s => s.byServer.find(x => x.server.id === serverId));
  const listed = !!bucket?.loaded && !bucket.error;
  const scope = serverIdentity(serverId, name, server);
  const [fallback, setFallback] = useState<{ scope: string; session: AccountSession | null } | null>(null);
  const [sessionFailure, setSessionFailure] = useState({ scope: '', error: '' });
  const sessionError = sessionFailure.scope === scope ? sessionFailure.error : '';
  const [retry, setRetry] = useState(0);
  const session: AccountSession | null = row ?? (!listed && fallback?.scope === scope ? fallback.session : null);
  const refused = !server || !!(server.removed || server.invite || server.inviteEnded);
  const identity = sessionIdentity(scope, session);
  const mounted = useRef(false);
  const liveContext = () => {
    const liveServer = useServers.getState().servers.find(x => x.id === serverId);
    const liveScope = serverIdentity(serverId, name, liveServer);
    const sessions = useSessions.getState();
    const liveBucket = sessions.byServer.find(x => x.server.id === serverId);
    const liveListed = !!liveBucket?.loaded && !liveBucket.error;
    const liveSession: AccountSession | null = sessions.rows.find(x => x.serverId === serverId && x.name === name)
      ?? (!liveListed && fallback?.scope === liveScope ? fallback.session : null);
    return { scope: liveScope, session: liveSession, identity: sessionIdentity(liveScope, liveSession) };
  };
  const isCurrent = () => mounted.current && useServers.getState().ready && liveContext().identity === identity;
  const [catalog, setCatalog] = useState<Catalog>({ identity: '', loading: true, error: '', targets: [] });
  const current = catalog.identity === identity ? catalog : { identity, loading: true, error: '', targets: [] };

  useEffect(() => {
    mounted.current = true;
    const release = useSessions.getState().retain();
    return () => { mounted.current = false; release(); };
  }, []);
  useEffect(() => {
    if (!ready || refused || !server || row || listed) return;
    let active = true;
    const valid = () => active && mounted.current && liveContext().scope === scope;
    setFallback(null);
    setSessionFailure({ scope, error: '' });
    void fetchSessionsForServer(server).then(rows => {
      if (!valid()) return;
      const found = rows.find(x => x.name === name) ?? null;
      setFallback({ scope, session: found });
      if (!found) setSessionFailure({ scope, error: m.chat_sessao_encerrada() });
    }).catch(error => { if (valid()) setSessionFailure({ scope, error: readableError(error) }); });
    return () => { active = false; };
  }, [ready, refused, scope, !!row, listed, bucket?.error, retry]);

  useEffect(() => {
    if (!ready || refused || !server || !session || session.provider !== 'claude' || session.guest_kind === 'pair') return;
    let active = true;
    setCatalog({ identity, loading: true, error: '', targets: [] });
    const load = async (): Promise<Pick<Catalog, 'targets' | 'restricted'>> => {
      if (!session.engine) return { targets: await listAccountTargets(name, server) };
      const engines = await getEnginesForServer(server);
      const engine = engines.motores[session.engine];
      if (engines.arquivo_corrompido || !engine) throw new Error(m.native_invalid_response());
      if (engine.cliproxy_error) throw new Error(engine.cliproxy_error);
      if (!engine.cliproxy_accounts?.length) return { targets: [], restricted: true };
      const credentials = await getCredentialsForServer(server);
      const targets: SwitchTarget[] = [];
      for (const account of engine.cliproxy_accounts) {
        if (!account.account.trim() || !/^codex:./.test(account.credential_id)) continue;
        const credential = credentials.find(c => c.id === account.credential_id && c.tipo === 'codex');
        if (!credential) continue;
        const windows = credential.cota?.estado === 'lida' ? credential.cota.janelas.filter(w => Number.isFinite(w.pct)).map(w => w.pct) : [];
        const pct = windows.length ? Math.max(...windows) : null;
        targets.push({ path: account.credential_id, engineAccount: account.account,
          label: account.label || account.email || account.account, pct, full: pct !== null && pct >= 99, low: pct !== null && pct >= 95,
          unavailable: credential.login?.loggedIn === false || credential.login?.estado === 'indisponivel' });
      }
      return { targets };
    };
    void load().then(result => {
      if (active && isCurrent()) setCatalog({ identity, loading: false, error: '', ...result });
    }).catch(error => {
      if (active && isCurrent()) setCatalog({ identity, loading: false, error: readableError(error), targets: [] });
    });
    return () => { active = false; };
  }, [ready, identity, !!session, retry]);

  const chat = chatStore(serverId, name);
  const stateEvent = chat.use(s => s.stateEvent);
  const idle = (stateEvent?.state ?? session?.state) === 'idle';
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const operation = useRef<{ phase: 'confirm' | 'post' } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({ identity: '', error: '', success: '' });
  const feedbackMatches = feedback.transition ? matchesTransition(feedback.transition, scope, session) : feedback.identity === identity;
  const actionError = feedbackMatches ? feedback.error : '';
  const success = feedbackMatches ? feedback.success : '';
  const displayedSession = success && feedback.transition ? feedback.transition.destination : session;
  const label = displayedSession ? sessionAccountLabel(displayedSession) : null;
  const shownTargets = current.targets.filter(target => target.engineAccount
    ? target.path !== displayedSession?.conta && target.engineAccount !== displayedSession?.engine_account
    : `claude:${target.path}` !== displayedSession?.conta && target.path !== displayedSession?.config_dir);
  const requestSwitch = (target: SwitchTarget) => {
    if (!server || refused || !session || session.provider !== 'claude' || session.guest_kind === 'pair'
      || !idle || operation.current || target.full || target.unavailable || !isCurrent()) return;
    const pending = { phase: 'confirm' as 'confirm' | 'post' };
    operation.current = pending;
    setConfirming(true);
    const release = () => {
      if (operation.current !== pending) return;
      operation.current = null;
      if (mounted.current) { setConfirming(false); setApplying(false); }
    };
    const cancel = () => { if (pending.phase === 'confirm') release(); };
    const execute = async () => {
      if (operation.current !== pending || pending.phase !== 'confirm') return;
      pending.phase = 'post';
      if (!isCurrent()) {
        if (mounted.current) setFeedback({ identity: liveContext().identity, error: m.mobile_session_account_changed(), success: '' });
        release(); return;
      }
      if ((chat.use.getState().stateEvent?.state ?? liveContext().session?.state) !== 'idle') {
        setFeedback({ identity, error: m.native_usage_card_move_busy(), success: '' });
        release(); return;
      }
      const next: AccountSession = target.engineAccount
        ? { ...session, conta: target.path, engine_account: target.engineAccount }
        : { ...session, conta: `claude:${target.path}`, config_dir: target.path, jsonl: movedTranscript(session.jsonl, target.path) };
      const transition: AccountTransition = { scope, source: session, destination: next };
      const resultIsCurrent = () => {
        const live = liveContext();
        return mounted.current && useServers.getState().ready && matchesTransition(transition, live.scope, live.session);
      };
      setConfirming(false); setApplying(true);
      setFeedback({ identity, error: '', success: '' });
      try {
        if (target.engineAccount) {
          const result = await setSessionEngineAccount(name, target.engineAccount, server);
          if (!result.ok) throw new Error(m.native_invalid_response());
        } else {
          const result = await setSessionAccount(name, target.path, server);
          if (!result.ok || result.config_dir !== target.path) throw new Error(m.native_invalid_response());
        }
        if (!resultIsCurrent()) return;
        setFeedback({ identity, transition, error: '', success: m.mobile_session_account_success({ conta: sessionAccountLabel(next) || target.label }) });
      } catch (error) {
        if (resultIsCurrent()) setFeedback({ identity, transition, error: readableError(error), success: '' });
      } finally { release(); }
    };
    const warning = target.low && target.pct !== null ? `\n\n${m.conta_confirmar_acabando({ conta: target.label, pct: target.pct })}` : '';
    Alert.alert(m.conta_confirmar_titulo({ conta: target.label }), m.conta_confirmar_msg({ conta: target.label }) + warning,
      [{ text: m.comum_cancelar(), style: 'cancel', onPress: cancel }, { text: m.comum_confirmar(), onPress: () => { void execute(); } }],
      { cancelable: true, onDismiss: cancel });
  };
  const loading = <View style={styles.notice}><ActivityIndicator color={theme.tokens.text.muted} /><Text style={styles.text}>{m.comum_carregando()}</Text></View>;
  const failure = (text: string) => <View style={styles.notice}>
    <Text accessibilityRole="alert" style={styles.error}>{text}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={m.native_retry()} onPress={() => setRetry(n => n + 1)} style={styles.button}>
      <Text style={styles.action}>{m.native_retry()}</Text>
    </Pressable>
  </View>;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, Platform.OS !== 'ios' && { paddingTop: headerHeight }]}>
    {!ready ? loading : refused ? <Text accessibilityRole="alert" style={styles.error}>{m.chat_servidor_removido()}</Text> : <>
      <View style={styles.notice}>
        <Text style={styles.caption}>{m.cota_conta_ativa()}</Text>
        <Text selectable style={styles.title}>{label || m.native_invalid_response()}</Text>
      </View>
      {!session ? sessionError ? failure(sessionError) : listed ? <Text style={styles.error}>{m.chat_sessao_encerrada()}</Text> : bucket?.error ? failure(bucket.error) : loading
        : session.provider !== 'claude' || session.guest_kind === 'pair' ? <Text style={styles.text}>{m.conta_mesma_so_claude()}</Text>
          : <>
            <Text style={styles.text}>{m.conta_mesma_conversa_sub()}</Text>
            {!idle ? <Text style={styles.text}>{m.native_usage_card_move_busy()}</Text> : null}
            {applying ? loading : null}
            {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
            {success ? <Text accessibilityRole="alert" style={styles.text}>{success}</Text> : null}
            {current.loading ? loading : current.error ? failure(m.conta_erro_listar({ erro: current.error }))
              : current.restricted ? <Text style={styles.text}>{m.mobile_session_engine_account_unavailable()}</Text>
                : shownTargets.length === 0 ? <Text style={styles.text}>{session.engine ? m.accounts_none() : m.conta_nenhuma_outra()}</Text>
                : shownTargets.map(target => <Pressable key={target.path} accessibilityRole="button" accessibilityLabel={target.label} disabled={target.full || target.unavailable || !idle || applying || confirming} onPress={() => requestSwitch(target)} style={styles.button}>
                  <Text style={styles.title}>{target.label}</Text>
                  <Text style={styles.text}>{quotaLabel(target)}</Text>
                  {target.unavailable ? <Text style={styles.error}>{m.contas_login_nao_conferido()}</Text> : null}
                </Pressable>)}
          </>}
    </>}
  </ScrollView>;
}

function quotaLabel(target: AccountTarget): string {
  const pct = target.pct;
  return pct === null ? m.conta_cota_sem_leitura() : target.full ? m.conta_cota_cheia({ pct })
    : target.low ? m.conta_cota_acabando({ pct }) : m.conta_cota_uso({ pct });
}

const styles = StyleSheet.create(theme => ({
  content: { padding: theme.base.space[4], paddingBottom: theme.base.space[8], gap: theme.base.space[3] },
  notice: { gap: theme.base.space[2] },
  title: { fontSize: theme.base.text.base, color: theme.tokens.text.primary, fontWeight: '600' },
  caption: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted },
  text: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.error },
  action: { fontSize: theme.base.text.base, color: theme.tokens.accent.base },
  button: { minHeight: 44, paddingVertical: theme.base.space[3], gap: theme.base.space[1] },
}));
