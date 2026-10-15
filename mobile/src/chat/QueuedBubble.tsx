import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { waitsInQueue, type ChatEvent, type SessionInfo } from '@hangar/core';
import { chatStore } from '../stores/chat';
import { UserBubble } from './UserBubble';
import * as m from '../paraglide/messages';

// A ação vive separada: listas só de leitura não criam um store sem identidade de conversa.
function DiscardQueued({ id, sessionName, serverId }: { id: string; sessionName: string; serverId: string }) {
  const chat = chatStore(serverId, sessionName);
  const busy = chat.use((s) => s.queueBusy);
  const [{ sending, error }, setAction] = useState({ sending: false, error: null as string | null });
  const { theme } = useUnistyles();
  const discard = async () => {
    if (chat.use.getState().queueBusy) return;
    setAction({ sending: true, error: null });
    await chat.discardQueued(id);
    setAction({ sending: false, error: chat.use.getState().queueError });
  };
  return (
    <View style={styles.action}>
      <Pressable accessibilityRole="button" accessibilityLabel={m.native_queue_discard()}
        accessibilityState={{ disabled: busy, busy: sending }} disabled={busy}
        onPress={() => void discard()} style={[styles.button, busy && styles.dim]}>
        {sending ? <ActivityIndicator size="small" color={theme.tokens.text.secondary} /> : null}
        <Text style={styles.label}>{m.native_queue_discard()}</Text>
      </Pressable>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export const QueuedBubble = memo(function QueuedBubble({ event, working, problem, session, sessionName, serverId }: {
  event: ChatEvent;
  working: boolean;
  problem?: string | null;
  session?: SessionInfo | null;
  sessionName?: string;
  serverId?: string;
}) {
  const queued = event.id.startsWith('queued-');
  const failed = event.desistiu === true;
  const holdsQueue = queued && problem === 'terminal_input_delivery_unproved' && event.queued_delivered === true && !failed;
  const notes: string[] = [];
  if (failed || event.id.startsWith('held:') || event.hook_error != null) {
    notes.push(event.hook_error ?? m.native_delivery_failed());
  }
  if (failed) notes.push(m.msg_nao_chegou_reenvie());
  else if (holdsQueue) notes.push(m.native_delivery_unproved());
  else if (queued && event.queued_delivered !== true && problem === 'terminal_input_delivery_unproved') notes.push(m.native_queue_held());
  else if (queued && event.queued_delivered !== true && problem === 'terminal_input_no_safe_delivery') notes.push(m.native_no_safe_delivery());
  else if (queued && !event.queued_consumed) notes.push(event.queued_delivered === true ? m.native_delivering() : m.native_queued());

  return (
    <View>
      <View style={working && waitsInQueue(event, session?.provider, session?.headless) ? styles.dim : undefined}>
        <UserBubble text={event.text ?? ''} sessionName={sessionName} serverId={serverId} ts={event.ts}
          eventId={event.id} imageCount={event.image_count ?? 0} />
      </View>
      {notes.length ? <Text style={styles.note}>{notes.join(' · ')}</Text> : null}
      {queued && (failed || holdsQueue) && sessionName && serverId
        ? <DiscardQueued id={event.id.slice('queued-'.length)} sessionName={sessionName} serverId={serverId} /> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  dim: { opacity: 0.5 },
  note: { fontSize: theme.base.text.xs, color: theme.tokens.status.warning, textAlign: 'right', marginTop: theme.base.space[1] },
  action: { alignItems: 'flex-end' },
  button: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingHorizontal: theme.base.space[2] },
  label: { fontSize: theme.base.text.xs, color: theme.tokens.text.secondary },
  error: { fontSize: theme.base.text.xs, color: theme.tokens.status.error, textAlign: 'right' },
}));
