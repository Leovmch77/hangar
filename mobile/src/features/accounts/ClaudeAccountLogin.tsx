import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import {
  startClaudeAccountLoginForServer, getClaudeAccountLoginStepForServer,
  submitClaudeAccountLoginCodeForServer, cancelClaudeAccountLoginForServer,
  type ClaudeLoginStep, type Server,
} from '@hangar/core';
import { Sheet, type SheetRef } from '../../ui/Sheet';
import { Pill } from '../config/PageHeader';
import { SectionCard } from '../config/SectionCard';
import { SettingsRow } from '../config/SettingsRow';
import * as m from '../../paraglide/messages';

export type ClaudeAccountLoginProps = {
  server: Server;
  label: string;
  onComplete: () => void | Promise<void>;
  onClose: () => void;
};

// Sem identificador de tentativa no servidor, a limpeza anterior precisa terminar antes da próxima abertura.
const writes = new Map<string, Promise<void>>();
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const result = (writes.get(key) ?? Promise.resolve()).then(task);
  const tail = result.then(() => {}, () => {});
  writes.set(key, tail);
  void tail.then(() => { if (writes.get(key) === tail) writes.delete(key); });
  return result;
}
const cause = (e: unknown) => e instanceof Error ? e.message : m.contas_login_nao_confirmado();
const conflict = (e: unknown) => (e as { status?: number } | null)?.status === 409 || (e instanceof Error && /^409\b/.test(e.message));

export function ClaudeAccountLogin({ server, label, onComplete, onClose }: ClaudeAccountLoginProps) {
  const key = JSON.stringify([server.id, server.baseUrl, server.token, label]);
  const writeKey = JSON.stringify([server.id, label]);
  const identity = useRef(key); identity.current = key;
  const callbacks = useRef({ onComplete, onClose }); callbacks.current = { onComplete, onClose };
  const sheet = useRef<SheetRef>(null);
  const [step, setStep] = useState<ClaudeLoginStep | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'start' | 'code' | 'cancel' | null>('start');
  const [error, setError] = useState('');
  const [terminal, setTerminal] = useState(false);
  const handlers = useRef<{
    read: () => void; submit: (value: string) => void; cancel: (restart?: boolean, dismissed?: boolean) => void;
    external: (copy: boolean, url: string) => void;
  } | null>(null);

  useEffect(() => {
    const target = { ...server };
    let disposed = false, writing = false, needed = false, confirmed = false, halted = false, version = 0;
    let reader: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !disposed && identity.current === key;
    const stopReading = () => { clearTimeout(timer); reader?.abort(); reader = undefined; ++version; };
    const report = (e: unknown) => {
      if (!active()) return;
      if (conflict(e)) { halted = true; setTerminal(true); }
      setError(cause(e));
    };
    const reopen = () => {
      void sheet.current?.present().catch(e => {
        Alert.alert(m.contas_login_titulo({ nome: label }), `${m.contas_login_servidor({ nome: target.label })}\n${cause(e)}`);
      });
    };
    function finish(next: ClaudeLoginStep) {
      if (confirmed && !active()) return;
      confirmed = true; needed = false; halted = true; stopReading();
      if (!active()) return;
      setStep(next); setTerminal(true); setError('');
      void (async () => {
        try { await callbacks.current.onComplete(); }
        catch (e) { if (active()) setError(`${m.contas_login_atualizar_erro()}\n${cause(e)}`); }
      })();
    }
    async function read(manual = false) {
      if (!active() || writing || halted || reader) return;
      clearTimeout(timer);
      if (manual) setError('');
      const controller = new AbortController(), generation = version;
      reader = controller;
      try {
        const next = await getClaudeAccountLoginStepForServer(target, label, controller.signal);
        if (!active() || generation !== version) return;
        if (next.etapa === 'concluido') { finish(next); return; }
        setStep(next);
        if (next.etapa === 'idle') {
          halted = true; setTerminal(true); setError(m.erro_login_sem_tentativa());
        } else timer = setTimeout(() => void read(), 2000);
      } catch (e) { if (active() && generation === version) report(e); }
      finally { if (reader === controller) reader = undefined; }
    }
    async function start() {
      if (writing || !active()) return;
      writing = true; stopReading(); setBusy('start'); setError('');
      let started = false;
      try {
        await enqueue(writeKey, async () => {
          if (!active()) return;
          needed = true;
          const result = await startClaudeAccountLoginForServer(target, label);
          if (result.ok !== true) throw new Error(m.contas_login_nao_confirmado());
          started = true;
        });
      } catch (e) { report(e); }
      finally { writing = false; if (active()) setBusy(null); }
      if (started && active()) void read();
    }
    async function submit(value: string) {
      if (writing || halted || !active()) return;
      if (!value.trim() || value.length > 4096 || /[\r\n\0]/.test(value)) {
        setError(m.mobile_accounts_claude_invalid_code()); return;
      }
      writing = true; stopReading(); setBusy('code'); setError('');
      try {
        const result = await enqueue(writeKey, async () => {
          const result = await submitClaudeAccountLoginCodeForServer(target, label, value.trim());
          if (result.ok !== true) throw new Error(m.contas_login_nao_confirmado());
          // A limpeza enfileirada pelo unmount já precisa saber que a conta entrou.
          confirmed = true; needed = false;
          return result;
        });
        if (active()) finish({ etapa: 'concluido', url: null, email: result.email ?? null, plano: result.plano ?? null });
      } catch (e) { report(e); }
      finally { writing = false; if (active()) setBusy(null); }
    }
    async function cancel(restart = false, dismissed = false) {
      if (!active()) return;
      if (writing) { if (dismissed) reopen(); return; }
      if (confirmed) { callbacks.current.onClose(); return; }
      writing = true; stopReading(); setBusy('cancel'); setError('');
      let restarted = false;
      try {
        await enqueue(writeKey, async () => {
          if (needed) {
            const result = await cancelClaudeAccountLoginForServer(target, label);
            if (result.ok !== true) throw new Error(m.contas_login_nao_confirmado());
            needed = false;
          }
          if (!active()) return;
          halted = false; setTerminal(false); setStep(null); setCode('');
          if (restart) {
            setBusy('start'); needed = true;
            const result = await startClaudeAccountLoginForServer(target, label);
            if (result.ok !== true) throw new Error(m.contas_login_nao_confirmado());
            restarted = true;
          }
        });
        if (active() && !restart) callbacks.current.onClose();
      } catch (e) { report(e); if (active() && dismissed) reopen(); }
      finally { writing = false; if (active()) setBusy(null); }
      if (restarted && active()) void read();
    }
    async function external(copy: boolean, url: string) {
      const generation = version;
      try {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error(m.mobile_accounts_claude_invalid_url()); }
        if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
          throw new Error(m.mobile_accounts_claude_invalid_url());
        }
        if (copy) await Clipboard.setStringAsync(url);
        else await Linking.openURL(url);
      } catch (e) {
        if (active() && generation === version) setError(copy ? `${m.contas_login_copiar_erro()}\n${cause(e)}` : cause(e));
      }
    }
    handlers.current = { read: () => void read(true), submit: value => void submit(value),
      cancel: (restart, dismissed) => void cancel(restart, dismissed), external: (copy, url) => void external(copy, url) };
    setStep(null); setCode(''); setError(''); setTerminal(false);
    void start();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void read(true); });
    return () => {
      disposed = true; stopReading(); listener.remove();
      void enqueue(writeKey, async () => {
        if (!needed || confirmed) return;
        const result = await cancelClaudeAccountLoginForServer(target, label);
        if (result.ok !== true) throw new Error(m.contas_login_nao_confirmado());
        needed = false;
      }).catch(e => {
        Alert.alert(m.contas_login_titulo({ nome: label }), `${m.contas_login_servidor({ nome: target.label })}\n${cause(e)}`);
      });
    };
  }, [server.id, server.baseUrl, server.token, label]);

  const done = step?.etapa === 'concluido';
  return <Sheet ref={sheet} open dismissible={!busy} onDismiss={() => handlers.current?.cancel(false, true)}>
    <View style={styles.root}>
      <Text accessibilityRole="header" style={styles.title}>{m.contas_login_titulo({ nome: label })}</Text>
      <Text style={styles.text}>{m.contas_login_servidor({ nome: server.label })}</Text>
      {done ? <SectionCard>
        <SettingsRow title={m.contas_login_conectada()} description={m.contas_login_pronta()} />
        {step.email ? <SettingsRow title={m.contas_login_email()} description={step.email} /> : null}
        {step.plano ? <SettingsRow title={m.contas_login_plano()} description={step.plano} /> : null}
      </SectionCard> : <>
        {busy ? <Text style={styles.text} accessibilityLiveRegion="polite">{busy === 'code' ? m.contas_login_confirmando() : m.contas_login_preparando()}</Text> : null}
        {step?.etapa === 'aguardando' ? <SectionCard>
          <SettingsRow title={m.contas_login_autorizar()} description={m.contas_login_autorizar_ajuda()}>
            {step.url ? <>
              <Text selectable style={styles.text}>{step.url}</Text>
              <View style={styles.actions}>
                <Pill label={m.contas_login_abrir()} disabled={!!busy || terminal} onPress={() => handlers.current?.external(false, step.url!)} />
                <Pill label={m.contas_login_copiar_link()} disabled={!!busy || terminal} onPress={() => handlers.current?.external(true, step.url!)} />
              </View>
            </> : null}
          </SettingsRow>
          <SettingsRow title={m.contas_login_codigo()}>
            <TextInput accessibilityLabel={m.contas_login_codigo()} placeholder={m.contas_codigo_placeholder()} value={code}
              onChangeText={setCode} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!busy && !terminal} style={styles.input} />
            <Pill label={m.contas_confirmar_codigo()} disabled={!!busy || terminal} onPress={() => handlers.current?.submit(code)} />
          </SettingsRow>
        </SectionCard> : null}
        <View style={styles.actions}>
          <Pill label={m.comum_cancelar()} disabled={!!busy} onPress={() => handlers.current?.cancel()} />
          {error || terminal ? <Pill label={m.novacred_codex_tentar()} disabled={!!busy} onPress={() => handlers.current?.cancel(true)} /> : null}
          {error && !terminal ? <Pill label={m.contas_atualizar()} disabled={!!busy} onPress={() => handlers.current?.read()} /> : null}
        </View>
      </>}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {done ? <Pill label={m.contas_login_concluir()} onPress={onClose} /> : null}
    </View>
  </Sheet>;
}
const styles = StyleSheet.create(theme => ({
  root: { padding: theme.base.space[4], gap: theme.base.space[3] },
  title: { color: theme.tokens.text.primary, fontSize: theme.base.text.lg, fontWeight: '600' },
  text: { color: theme.tokens.text.primary },
  error: { color: theme.tokens.status.error },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2], marginTop: theme.base.space[2] },
  input: { minHeight: 44, color: theme.tokens.text.primary, borderColor: theme.tokens.border.default,
    borderWidth: 1, borderRadius: theme.base.radius.md, paddingHorizontal: theme.base.space[3], marginBottom: theme.base.space[2] },
}));
