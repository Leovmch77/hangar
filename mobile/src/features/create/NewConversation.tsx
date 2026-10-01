import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import type { Server } from '@hangar/core';
import { MultilineInput } from '../../ui/MultilineInput';
import { Sheet } from '../../ui/Sheet';
import { Glass } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { HangarMark } from '../../ui/HangarMark';
import { superficie } from '../../theme/superficie';
import {
  adoptCandidate, beginAttempt, discardAttempt, recoverAttempt, restoreAttempt, sendFirstInput,
  useNewConversation, type NewConversationInput,
} from '../../stores/newConversation';
import * as m from '../../paraglide/messages';

type Props = {
  server: Server;
  destination: ReactNode;
  destinationPending: boolean;
  // Chip da pasta: nome curto à vista, máquina e caminho inteiros para o leitor de tela.
  folderLabel: string;
  destinationLabel: string;
  // Chip do provedor: o nome à vista, o resumo das escolhas para o leitor de tela.
  providerLabel: string;
  settingsLabel: string;
  // Linha embaixo da caixa: modelo · nível · permissão (a máquina vai na frente, aqui dentro).
  statusLabel: string;
  notices: ReactNode;
  options: ReactNode;
  // null enquanto falta destino ou conta; o texto continua editável.
  body: NewConversationInput['body'] | null;
  blocked: boolean;
};

export function NewConversation({
  server, destination, destinationPending, folderLabel, destinationLabel, providerLabel, settingsLabel, statusLabel,
  notices, options, body, blocked,
}: Props) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const serverId = server.id;
  const attempt = useNewConversation((s) => s.attempts[serverId] ?? null);
  const issue = useNewConversation((s) => s.issues[serverId] ?? null);
  const busy = useNewConversation((s) => !!s.busy[serverId]);
  const [text, setText] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const destinationRef = useRef<View>(null);
  const settingsRef = useRef<View>(null);
  const closeOptionsRef = useRef<View>(null);
  const optionsOpener = useRef<View | null>(null);
  const openOptions = (opener: View | null) => {
    optionsOpener.current = opener;
    setOptionsOpen(true);
  };
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
  const receivedMessages = issue?.kind === 'unknown' && issue.events
    ? issue.events.filter((event) => event.kind === 'user_msg').slice(-3) : null;
  const canSend = !!body && !blocked && !busy && restored && !pending && !!text.trim();

  // Sem pasta escolhida o seletor ocupa o meio; escolhida, o meio fica com a marca, como no PC.
  const showPicker = destinationPending && !optionsOpen;

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.keyboard}>
      <ScrollView style={styles.states} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {showPicker ? destination : null}
        {!showPicker && !pending ? (
          <View style={styles.hero}>
            <HangarMark size={44} color={theme.tokens.text.muted} />
            <Text style={styles.heroText}>{m.native_empty_chat_hint({ agent: providerLabel })}</Text>
          </View>
        ) : null}
        {notices}

        {pending ? (
          <View style={styles.pending}>
            <Text style={styles.label}>{m.nova_conversa_guardada()}</Text>
            <Text style={styles.pendingText} numberOfLines={3}>{pending.text}</Text>
            {receivedMessages ? (
              <View>
                <Text style={styles.label}>{m.new_conversation_received_messages()}</Text>
                {receivedMessages.length ? receivedMessages.map((event) => (
                  <Text key={event.id} style={styles.pendingText} numberOfLines={3}>{event.text ?? ''}</Text>
                )) : <Text style={styles.hint}>{m.new_conversation_no_received_messages()}</Text>}
              </View>
            ) : null}
            {pending.sessionName && (pending.phase === 'created' || pending.phase === 'sent' || pending.phase === 'send_unknown') ? (
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} onPress={() => open(pending.sessionName!)} disabled={busy} style={[styles.secondary, busy && styles.disabled]}>
                <Text style={styles.secondaryTxt}>{m.nova_conversa_abrir()}</Text>
              </Pressable>
            ) : null}
            {pending.phase === 'created' ? (
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} onPress={() => void advance()} disabled={busy} style={[styles.secondary, busy && styles.disabled]}>
                <Text style={styles.secondaryTxt}>{m.nova_conversa_reenviar()}</Text>
              </Pressable>
            ) : null}
            {pending.phase === 'create_unknown' || pending.phase === 'send_unknown' ? (
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} onPress={() => void recoverAttempt(serverId)} disabled={busy} style={[styles.secondary, busy && styles.disabled]}>
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
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} onPress={() => discardAttempt(serverId, pending.id)} disabled={busy} style={[styles.ghost, busy && styles.disabled]}>
              <Text style={styles.ghostTxt}>{m.nova_conversa_descartar()}</Text>
            </Pressable>
          </View>
        ) : null}

        {issue ? <Text style={styles.error} accessibilityRole="alert">{issue.message}</Text> : null}
        {!body && !blocked && !pending ? <Text style={styles.hint}>{m.nova_conversa_sem_destino()}</Text> : null}
      </ScrollView>

      {/* A mesma caixa do composer do chat: campo em cima, pasta e provedor à esquerda, Enviar à
          direita. Os dois chips abrem a folha de Opções de sempre. */}
      <Glass variant="chrome" style={styles.box}>
        <View style={styles.inputWrap}>
          <MultilineInput
            value={text}
            onChangeText={setText}
            placeholder={m.nova_conversa_placeholder()}
            accessibilityLabel={m.nova_conversa_placeholder()}
            autoFocus
            maxHeight={160}
          />
        </View>
        <View style={styles.row}>
          <Pressable
            ref={destinationRef}
            accessible
            accessibilityRole="button"
            accessibilityLabel={destinationLabel}
            accessibilityHint={m.nova_conversa_destino_hint()}
            accessibilityState={{ expanded: optionsOpen }}
            onPress={() => openOptions(destinationRef.current)}
            hitSlop={6}
            style={({ pressed }) => [styles.chip, { backgroundColor: pressed ? theme.tokens.bg.hover : superficie(theme, 0.6) }]}
          >
            <Icon name="Folder" size={14} color={theme.tokens.text.secondary} />
            <Text style={styles.chipText} numberOfLines={1}>{folderLabel}</Text>
            <Icon name="ChevronDown" size={12} color={theme.tokens.text.muted} />
          </Pressable>
          <Pressable
            ref={settingsRef}
            accessible
            accessibilityRole="button"
            accessibilityLabel={settingsLabel}
            accessibilityHint={m.nova_conversa_config_hint()}
            accessibilityState={{ expanded: optionsOpen }}
            onPress={() => openOptions(settingsRef.current)}
            hitSlop={6}
            style={({ pressed }) => [styles.chip, { backgroundColor: pressed ? theme.tokens.bg.hover : superficie(theme, 0.6) }]}
          >
            <Icon name="Bot" size={14} color={theme.tokens.text.secondary} />
            <Text style={styles.chipText} numberOfLines={1}>{providerLabel}</Text>
            <Icon name="ChevronDown" size={12} color={theme.tokens.text.muted} />
          </Pressable>
          <View style={styles.spacer} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={m.nova_conversa_enviar()}
            accessibilityState={{ disabled: !canSend, busy }}
            onPress={() => void handleSend()}
            disabled={!canSend}
            hitSlop={5}
            style={({ pressed }) => [
              styles.send,
              canSend ? { backgroundColor: theme.tokens.text.primary } : { backgroundColor: superficie(theme, 0.8) },
              pressed && canSend && styles.sendPressed,
            ]}
          >
            {busy
              ? <ActivityIndicator size="small" color={canSend ? theme.tokens.bg.base : theme.tokens.text.muted} />
              : <Icon name="ArrowUp" size={18} color={canSend ? theme.tokens.bg.base : theme.tokens.text.muted} />}
          </Pressable>
        </View>
      </Glass>
      <View style={styles.status}>
        <Text style={styles.statusText} numberOfLines={1}>{server.label}</Text>
        {statusLabel ? <Text style={[styles.statusText, styles.statusRest]} numberOfLines={1}>{statusLabel}</Text> : null}
      </View>
      </KeyboardAvoidingView>
      <Sheet open={optionsOpen} onDidPresent={() => {
        if (mounted.current && closeOptionsRef.current) AccessibilityInfo.sendAccessibilityEvent(closeOptionsRef.current, 'focus');
      }} onDismiss={() => {
        setOptionsOpen(false);
        if (mounted.current && optionsOpener.current) AccessibilityInfo.sendAccessibilityEvent(optionsOpener.current, 'focus');
      }} sizes={['medium', 'large']} scrollable>
        <ScrollView accessibilityViewIsModal onAccessibilityEscape={() => setOptionsOpen(false)} contentContainerStyle={styles.sheetScroll} keyboardShouldPersistTaps="handled">
          <Pressable ref={closeOptionsRef} accessible accessibilityRole="button" onPress={() => setOptionsOpen(false)} style={styles.ghost}>
            <Text style={styles.ghostTxt}>{m.nova_conversa_opcoes_fechar()}</Text>
          </Pressable>
          {optionsOpen ? destination : null}
          {options}
        </ScrollView>
      </Sheet>
    </View>
  );
}

// Fundo transparente: quem pinta é o Background da Screen, então Aparência (Liso, Textura, Luz,
// Imagem, Transparência) vale aqui como no chat.
const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: 'transparent' },
  keyboard: { flex: 1 },
  states: { flex: 1, minHeight: 44 },
  scroll: { flexGrow: 1, padding: theme.base.space[4], gap: theme.base.space[4] },
  sheetScroll: { padding: theme.base.space[4], gap: theme.base.space[4], paddingBottom: 32 },
  hero: { flexGrow: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: theme.base.space[3], paddingHorizontal: theme.base.space[5] },
  heroText: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted, textAlign: 'center' },
  box: {
    marginHorizontal: theme.base.space[2],
    marginBottom: theme.base.space[1],
    paddingHorizontal: theme.base.space[2],
    paddingTop: theme.base.space[2],
    paddingBottom: 6,
    gap: theme.base.space[1],
  },
  // O campo é o próprio vidro, sem caixa dentro da caixa.
  inputWrap: { minHeight: 40, justifyContent: 'center', paddingHorizontal: theme.base.space[1] },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1] },
  chip: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '45%',
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: theme.base.radius.xs,
    paddingHorizontal: theme.base.space[2],
  },
  chipText: { flexShrink: 1, fontSize: theme.base.text.xs, color: theme.tokens.text.secondary },
  spacer: { flex: 1 },
  send: { width: 34, height: 34, borderRadius: theme.base.radius.full, alignItems: 'center', justifyContent: 'center' },
  sendPressed: { opacity: 0.8 },
  status: { flexDirection: 'row', gap: theme.base.space[3], paddingHorizontal: theme.base.space[4], paddingBottom: theme.base.space[2], paddingTop: 2 },
  statusText: { fontFamily: theme.base.fontMono, fontSize: 11, color: theme.tokens.text.muted },
  statusRest: { flexShrink: 1 },
  pending: {
    padding: theme.base.space[3],
    gap: theme.base.space[2],
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
    borderRadius: theme.base.radius.md,
    backgroundColor: superficie(theme),
  },
  pendingText: { fontSize: theme.base.text.sm, color: theme.tokens.text.primary },
  label: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary, fontWeight: '500' },
  hint: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary },
  error: { color: theme.tokens.status.error, fontSize: theme.base.text.sm },
  secondary: { minHeight: 44, padding: theme.base.space[2], borderWidth: 1, borderColor: theme.tokens.border.default, borderRadius: theme.base.radius.md, justifyContent: 'center', alignItems: 'center' },
  secondaryTxt: { color: theme.tokens.text.primary, fontSize: theme.base.text.sm, fontWeight: '500' },
  ghost: { minHeight: 44, padding: theme.base.space[2], justifyContent: 'center', alignItems: 'center' },
  ghostTxt: { color: theme.tokens.text.secondary, fontSize: theme.base.text.sm },
  disabled: { opacity: 0.5 },
}));
