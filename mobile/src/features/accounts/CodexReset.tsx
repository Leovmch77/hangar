import { useEffect, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { consumeCodexRateLimitResetForServer, resetsIn, type CodexResetOutcome, type Credencial, type Server } from '@hangar/core';
import { Pill } from '../config/PageHeader';
import * as m from '../../paraglide/messages';

type Attempt = { credentialId: string; account: string; credit: string | null; uuid: string; busy: boolean; pending: boolean; error: string };
type ResetState = { attempt: Attempt | null; outcome: CodexResetOutcome | null; needsRefresh: boolean };
const empty: ResetState = { attempt: null, outcome: null, needsRefresh: false };
// Só em memória: sair da tela não pode perder a chave de um consumo sem resposta.
const states = new Map<string, ResetState>();
const listeners = new Set<() => void>();
const targets = new Map<string, string>();
const serverKey = (s: Server) => s.id;
const targetIdentity = (s: Server) => JSON.stringify([s.id, s.baseUrl, s.token]);
const read = (key: string) => states.get(key) ?? empty;
function write(key: string, next: ResetState) {
  states.set(key, next);
  for (const listener of listeners) listener();
}
function useReset(server: Server) {
  const key = serverKey(server);
  const identity = targetIdentity(server);
  useEffect(() => { targets.set(key, identity); }, [key, identity]);
  const state = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => read(key));
  return { key, state };
}
function uuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const n = Math.floor(Math.random() * 16);
    return (char === 'x' ? n : (n & 3) | 8).toString(16);
  });
}
async function consume(server: Server, key: string) {
  const state = read(key);
  const identity = targetIdentity(server);
  const attempt = state.attempt;
  if (!attempt || attempt.busy) return;
  write(key, { ...state, attempt: { ...attempt, busy: true, error: '' } });
  try {
    const { outcome } = await consumeCodexRateLimitResetForServer(server, attempt.account, attempt.credit, attempt.uuid);
    if (targets.get(key) !== identity) throw new Error(m.mobile_accounts_reset_unknown());
    if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(outcome)) throw new Error(m.mobile_accounts_reset_unknown());
    write(key, { attempt: null, outcome, needsRefresh: true });
  } catch (cause) {
    const status = (cause as { status?: unknown } | null)?.status;
    const definitive = status === 409 || status === 422;
    write(key, { ...read(key), attempt: { ...attempt, busy: false, pending: attempt.pending || !definitive,
      error: cause instanceof Error ? cause.message : m.mobile_accounts_reset_unknown() } });
  }
}
function PendingAttempt({ server, attempt }: { server: Server; attempt: Attempt }) {
  const key = serverKey(server);
  return (
    <View style={styles.block}>
      <Text style={styles.text}>{attempt.account} · {m.mobile_accounts_reset_confirm()}</Text>
      {attempt.pending ? <Text style={styles.text}>{m.mobile_accounts_reset_pending()}</Text> : null}
      {attempt.error ? <Text accessibilityRole="alert" style={styles.error}>{attempt.error}</Text> : null}
      <View style={styles.actions}>
        <Pill label={attempt.busy ? m.mobile_accounts_reset_working() : attempt.pending ? m.mobile_accounts_reset_retry() : m.mobile_accounts_reset_confirm_action()}
          disabled={attempt.busy} onPress={() => { void consume(server, key); }} />
        {!attempt.pending ? <Pill label={m.comum_cancelar()} disabled={attempt.busy} onPress={() => {
          const current = read(key);
          if (current.attempt && !current.attempt.busy && !current.attempt.pending) write(key, { ...current, attempt: null });
        }} /> : null}
      </View>
    </View>
  );
}

export function AccountReset({ server, credential }: { server: Server; credential: Credencial }) {
  const { key, state } = useReset(server);
  const attempt = state.attempt?.credentialId === credential.id ? state.attempt : null;
  const quota = credential.cota;
  const credits = credential.tipo === 'codex' && credential.codex_account && quota?.estado === 'lida' ? quota.reset_credits : null;
  const credit = credits?.credits?.find(c => c.status === 'available');
  const offered = !!credits && credits.available_count > 0 && (credits.credits == null || !!credit);
  const weekly = quota?.janelas.find(w => w.rotulo === '7d' && !w.por_modelo);
  const allowed = quota?.estado === 'lida' && weekly && Number.isFinite(weekly.pct) && weekly.pct >= 100;
  const expires = resetsIn(credit?.expires_at);
  if (!offered && !attempt) return null;
  return (
    <View style={styles.block}>
      {offered ? <>
        <Text style={styles.text}>{m.mobile_accounts_reset_count({ count: credits!.available_count })}</Text>
        {credit?.title ? <Text style={styles.text}>{credit.title}</Text> : null}
        {credit?.description ? <Text style={styles.text}>{credit.description}</Text> : null}
        {expires ? <Text style={styles.text}>{m.mobile_accounts_reset_expires({ when: expires })}</Text> : null}
        {!allowed ? <Text style={styles.text}>{m.mobile_accounts_reset_blocked()}</Text> : null}
        <View style={styles.actions}><Pill label={m.mobile_accounts_reset_use()} disabled={!allowed || !!state.attempt}
          onPress={() => {
            if (!allowed || read(key).attempt) return;
            write(key, { attempt: { credentialId: credential.id, account: credential.codex_account!, credit: credit?.id ?? null,
              uuid: uuidV4(), busy: false, pending: false, error: '' }, outcome: null, needsRefresh: false });
          }} /></View>
      </> : null}
      {attempt ? <PendingAttempt server={server} attempt={attempt} /> : null}
    </View>
  );
}

export function ResetFeedback({ server, credentialIds, onDefinitive }: {
  server: Server; credentialIds: string[]; onDefinitive: () => void;
}) {
  const { key, state } = useReset(server);
  useEffect(() => {
    const current = read(key);
    if (current.needsRefresh) {
      write(key, { ...current, needsRefresh: false });
      onDefinitive();
    }
  }, [key, state.needsRefresh, onDefinitive]);
  const text = state.outcome === 'reset' ? m.mobile_accounts_reset_success()
    : state.outcome === 'nothingToReset' ? m.mobile_accounts_reset_nothing()
    : state.outcome === 'noCredit' ? m.mobile_accounts_reset_no_credit()
    : state.outcome === 'alreadyRedeemed' ? m.mobile_accounts_reset_already() : '';
  return <>
    {text ? <Text accessibilityLiveRegion="polite" style={styles.text}>{text}</Text> : null}
    {state.attempt && !credentialIds.includes(state.attempt.credentialId) ? <PendingAttempt server={server} attempt={state.attempt} /> : null}
  </>;
}

const styles = StyleSheet.create(theme => ({
  block: { gap: theme.base.space[2], marginTop: theme.base.space[2] },
  text: { fontSize: theme.base.text.xs, color: theme.tokens.text.secondary },
  error: { fontSize: theme.base.text.xs, color: theme.tokens.status.error },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2] },
}));
