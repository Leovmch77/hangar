import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import type { Server } from '@hangar/core';
import { MultilineInput } from '../../ui/MultilineInput';
import { Sheet } from '../../ui/Sheet';
import {
  adoptCandidate, beginAttempt, discardAttempt, recoverAttempt, restoreAttempt, sendFirstInput,
  useNewConversation, type NewConversationInput,
} from '../../stores/newConversation';
import * as m from '../../paraglide/messages';

type Props = {
  server: Server;
  destination: ReactNode;
  options: ReactNode;
  // null enquanto falta destino ou conta; o texto continua editável.
  body: NewConversationInput['body'] | null;
  blocked: boolean;
};

export function NewConversation({ server, destination, options, body, blocked }: Props) {
  const router = useRouter();
  const serverId = server.id;
  const attempt = useNewConversation((s) => s.attempts[serverId] ?? null);
  const issue = useNewConversation((s) => s.issues[serverId] ?? null);
  const busy = useNewConversation((s) => !!s.busy[serverId]);
  const [text, setText] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Enviar só depois de ler a tentativa gravada: antes disso um toque poderia seguir a antiga.
  const [restored, setRestored] = useState(false);
  const mounted = useRef(true);
  const submitting = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const saved = restoreAttempt(serverId);
    // Texto com ACK não volta ao campo: descartar e enviar criaria outra conversa com ele.
    if (saved && saved.phase !== 'sent') setText((current) => current || saved.text);
    setRestored(true);
  }, [serverId]);

  const open = (name: string) => router.replace((`/s/${serverId}/${name}` as never) as never);

  // Cria e envia em passos separados; o chat abre mesmo com input recusado ou incerto.
  const advance = async () => {
    if (submitting.current) return;
    submitting.current = true;
    try { await advanceOnce(); } finally { submitting.current = false; }
  };

  const advanceOnce = async () => {
    let current = useNewConversation.getState().attempts[serverId];
    if (current?.phase === 'created') {
      await sendFirstInput(serverId, current.id);
      current = useNewConversation.getState().attempts[serverId];
    }
    if (!mounted.current || !current?.sessionName) return;
    if (current.phase === 'created' || current.phase === 'sent' || current.phase === 'send_unknown') open(current.sessionName);
  };

  const handleSend = async () => {
    if (!body || blocked || busy || !restored || !text.trim() || submitting.current) return;
    submitting.current = true;
    try {
      await beginAttempt(serverId, { body, text });
      await advanceOnce();
    } finally { submitting.current = false; }
  };

  const pending = attempt && attempt.phase !== 'draft' ? attempt : null;
  const canSend = !!body && !blocked && !busy && restored && !pending && !!text.trim();

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{m.sessao_nova()}</Text>
        <View style={styles.inputWrap}>
          <MultilineInput
            value={text}
            onChangeText={setText}
            placeholder={m.nova_conversa_placeholder()}
            accessibilityLabel={m.nova_conversa_placeholder()}
            autoFocus
            maxHeight={200}
          />
        </View>

        {destination}

        {pending ? (
          <View style={styles.pending}>
            <Text style={styles.label}>{m.nova_conversa_guardada()}</Text>
            <Text style={styles.pendingText} numberOfLines={3}>{pending.text}</Text>
            {pending.sessionName && (pending.phase === 'created' || pending.phase === 'sent' || pending.phase === 'send_unknown') ? (
              <Pressable accessibilityRole="button" onPress={() => open(pending.sessionName!)} disabled={busy} style={[styles.secondary, busy && styles.disabled]}>
                <Text style={styles.secondaryTxt}>{m.nova_conversa_abrir()}</Text>
              </Pressable>
            ) : null}
            {pending.phase === 'created' ? (
              <Pressable accessibilityRole="button" onPress={() => void advance()} disabled={busy} style={[styles.secondary, busy && styles.disabled]}>
                <Text style={styles.secondaryTxt}>{m.nova_conversa_reenviar()}</Text>
              </Pressable>
            ) : null}
            {pending.phase === 'create_unknown' || pending.phase === 'send_unknown' ? (
              <Pressable accessibilityRole="button" onPress={() => void recoverAttempt(serverId)} disabled={busy} style={[styles.secondary, busy && styles.disabled]}>
                <Text style={styles.secondaryTxt}>{m.nova_conversa_conferir()}</Text>
              </Pressable>
            ) : null}
            {issue?.kind === 'candidate' ? (
              <>
                <Pressable accessibilityRole="button" onPress={() => open(issue.session.name)} style={styles.secondary}>
                  <Text style={styles.secondaryTxt}>{m.nova_conversa_abrir()}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => adoptCandidate(serverId, pending.id)} style={styles.secondary}>
                  <Text style={styles.secondaryTxt}>{m.nova_conversa_adotar()}</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => discardAttempt(serverId, pending.id)} disabled={busy} style={[styles.ghost, busy && styles.disabled]}>
              <Text style={styles.ghostTxt}>{m.nova_conversa_descartar()}</Text>
            </Pressable>
          </View>
        ) : null}

        {issue ? <Text style={styles.error} accessibilityRole="alert">{issue.message}</Text> : null}
        {!body && !blocked && !pending ? <Text style={styles.hint}>{m.nova_conversa_sem_destino()}</Text> : null}

        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={() => setOptionsOpen(true)} style={styles.options}>
            <Text style={styles.secondaryTxt}>{m.nova_conversa_opcoes()}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => void handleSend()} disabled={!canSend} style={[styles.primary, !canSend && styles.disabled]}>
            <Text style={styles.primaryTxt}>{busy ? m.criar_criando() : m.nova_conversa_enviar()}</Text>
          </Pressable>
        </View>
      </ScrollView>
      <Sheet open={optionsOpen} onDismiss={() => setOptionsOpen(false)} sizes={['medium', 'large']} scrollable>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">{options}</ScrollView>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.tokens.bg.base },
  scroll: { padding: theme.base.space[4], gap: theme.base.space[4], paddingBottom: 32 },
  title: { fontSize: 20, fontWeight: '600', color: theme.tokens.text.primary },
  inputWrap: {
    minHeight: 96,
    backgroundColor: theme.tokens.bg.surface,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    borderRadius: theme.base.radius.md,
  },
  pending: {
    padding: theme.base.space[3],
    gap: theme.base.space[2],
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
    borderRadius: theme.base.radius.md,
  },
  pendingText: { fontSize: theme.base.text.sm, color: theme.tokens.text.primary },
  label: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary, fontWeight: '500' },
  hint: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary },
  error: { color: theme.tokens.status.error, fontSize: theme.base.text.sm },
  actions: { flexDirection: 'row', gap: theme.base.space[2] },
  options: {
    height: 50,
    paddingHorizontal: theme.base.space[4],
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    borderRadius: theme.base.radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primary: {
    flex: 1,
    height: 50,
    backgroundColor: theme.tokens.accent.base,
    borderRadius: theme.base.radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryTxt: { color: '#fff', fontWeight: '600', fontSize: theme.base.text.base },
  secondary: { height: 44, borderWidth: 1, borderColor: theme.tokens.border.default, borderRadius: theme.base.radius.md, justifyContent: 'center', alignItems: 'center' },
  secondaryTxt: { color: theme.tokens.text.primary, fontSize: theme.base.text.sm, fontWeight: '500' },
  ghost: { height: 44, justifyContent: 'center', alignItems: 'center' },
  ghostTxt: { color: theme.tokens.text.secondary, fontSize: theme.base.text.sm },
  disabled: { opacity: 0.5 },
}));
