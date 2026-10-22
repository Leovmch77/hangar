import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { getConfigForServer, getProjectShortcuts, mergeProjectShortcuts, resolveShortcuts, sendInputForServer, sendsDirect, shortcutMissingSecret, type ProjectShortcut, type Shortcut } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { chatStore } from '../../stores/chat';
import { readDraft, writeDraft } from '../../stores/drafts';
import { haptic } from '../../ui/haptics';
import { toast } from '../../ui/Toast';
import { useSettingsColors } from '../config/colors';
import { panelShortcuts } from '../shortcuts/panelShortcuts';
import { ShortcutIcon, NATIVE_ICON, NATIVE_LABEL } from '../shortcuts/ShortcutIcon';
import * as m from '../../paraglide/messages';

export function ActionsGrid({ serverId, name }: { serverId: string; name: string }) {
  const router = useRouter();
  const server = useServers((s) => s.servers.find((s) => s.id === serverId));
  const c = useSettingsColors();
  const [items, setItems] = useState<Shortcut[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [projectItems, setProjectItems] = useState<ProjectShortcut[] | null>(null);
  const [projectError, setProjectError] = useState('');
  const [projectRetry, setProjectRetry] = useState(0);
  const inFlight = useRef(new Set<string>());
  const confirming = useRef(new Set<string>());
  const [sending, setSending] = useState(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setLoadError('');
    const target = useServers.getState().servers.find((s) => s.id === serverId);
    if (!target) {
      setLoadError(m.chat_servidor_removido());
      return;
    }
    getConfigForServer(target).then((config) => {
      if (cancelled) return;
      if (!config || typeof config.campos !== 'object' || config.campos === null) throw new Error(m.native_invalid_response());
      const raw = config.campos.shortcuts?.valor;
      setItems(panelShortcuts(resolveShortcuts(typeof raw === 'string' ? raw : '')));
    }).catch((e: unknown) => {
      if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [serverId, retry]);

  useEffect(() => {
    let cancelled = false;
    setProjectItems(null);
    setProjectError('');
    const target = useServers.getState().servers.find((s) => s.id === serverId);
    if (!target) {
      setProjectItems([]);
      setProjectError(m.chat_servidor_removido());
      return;
    }
    getProjectShortcuts(name, target).then((project) => {
      if (cancelled) return;
      if (!project || !Array.isArray(project.items)) throw new Error(m.native_invalid_response());
      setProjectItems(project.items);
    }).catch((e: unknown) => {
      if (cancelled) return;
      setProjectItems([]);
      setProjectError(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [serverId, name, projectRetry]);

  function fillDraft(text: string) {
    try {
      const current = readDraft(serverId, name) ?? {
        version: 1 as const, text: '', revision: 0, transcript: null, attachments: [], submission: null,
      };
      writeDraft(serverId, name, { ...current, text, revision: current.revision + 1 });
      chatStore(serverId, name).use.setState((s) => ({ draftUpdate: s.draftUpdate + 1 }));
    } catch (e) {
      toast.erro(e instanceof Error ? e.message : String(e));
    }
  }

  async function run(shortcut: Shortcut, key: string) {
    if (shortcut.type === 'internal') {
      router.push(`/s/${serverId}/${name}/${shortcut.action === 'anexos' ? 'attachments' : 'terminal'}`);
      return;
    }
    if (shortcut.type !== 'send_text') return;
    const direct = sendsDirect(shortcut);
    if (direct) {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setSending(new Set(inFlight.current));
    }
    try {
      if (direct) {
        if (!server) throw new Error(m.chat_servidor_removido());
        await sendInputForServer(server, name, shortcut.text);
        haptic.success();
      } else {
        const current = readDraft(serverId, name);
        if (current?.text.trim() && current.text !== shortcut.text) {
          Alert.alert(m.composer_trocar_rascunho({ cmd: shortcut.text }), undefined, [
            { text: m.native_cancel(), style: 'cancel' },
            { text: m.comum_confirmar(), onPress: () => fillDraft(shortcut.text) },
          ]);
        } else fillDraft(shortcut.text);
      }
    } catch (e) {
      toast.erro(e instanceof Error ? e.message : String(e));
    } finally {
      if (direct) {
        inFlight.current.delete(key);
        setSending(new Set(inFlight.current));
      }
    }
  }

  if (loadError) return (
    <View style={styles.feedback}>
      <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={m.native_retry()} onPress={() => setRetry((n) => n + 1)} style={styles.retry}>
        <Text style={[styles.label, { color: c.accentText }]}>{m.native_retry()}</Text>
      </Pressable>
    </View>
  );
  if (items === null) return <ActivityIndicator color={c.accent} />;
  const shortcuts = mergeProjectShortcuts(items, projectItems).filter(({ shortcut }) => shortcut.type !== 'shell');
  if (shortcuts.length === 0 && projectItems !== null && !projectError) return null;
  return (
    <View style={styles.feedback}>
      <View style={styles.grid}>
        {shortcuts.map(({ shortcut, key }) => {
          const label = shortcut.type === 'internal' ? NATIVE_LABEL[shortcut.action]() : shortcut.label;
          const actionKey = `${serverId}::${name}::${key}`;
          const busy = sending.has(actionKey);
          return (
            <Pressable key={key} accessibilityRole="button" accessibilityLabel={label}
              disabled={busy} accessibilityState={{ disabled: busy, busy }}
              onPress={() => {
                if (inFlight.current.has(actionKey) || confirming.current.has(actionKey)) return;
                if (shortcut.type !== 'internal') {
                  const missing = shortcutMissingSecret(shortcut);
                  if (missing) {
                    toast.erro(m.atalhos_segredo_falta({ nome: missing }));
                    return;
                  }
                }
                if (shortcut.confirm) {
                  confirming.current.add(actionKey);
                  Alert.alert(m.native_shortcut_confirm({ label }), undefined, [
                    { text: m.native_cancel(), style: 'cancel', onPress: () => { confirming.current.delete(actionKey); } },
                    { text: m.comum_confirmar(), onPress: () => {
                      confirming.current.delete(actionKey);
                      void run(shortcut, actionKey);
                    } },
                  ], { onDismiss: () => { confirming.current.delete(actionKey); } });
                } else void run(shortcut, actionKey);
              }}
              style={({ pressed }) => [styles.action, { borderColor: c.border, backgroundColor: pressed ? c.hover : c.inset }]}>
              <ShortcutIcon icon={shortcut.type === 'internal' ? NATIVE_ICON[shortcut.action] : shortcut.icon} size={22} color={c.accentText} />
              <Text style={[styles.label, { color: c.text }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {projectItems === null ? <ActivityIndicator color={c.accent} /> : null}
      {projectError ? (
        <View style={styles.feedback}>
          <Text accessibilityRole="alert" style={styles.error}>{projectError}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={m.native_retry()} onPress={() => setProjectRetry((n) => n + 1)} style={styles.retry}>
            <Text style={[styles.label, { color: c.accentText }]}>{m.native_retry()}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2] },
  feedback: { gap: theme.base.space[2] },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[2] },
  action: { width: '48%', minHeight: 70, borderWidth: 1, borderRadius: theme.base.radius.md,
    alignItems: 'center', justifyContent: 'center', padding: theme.base.space[2], gap: theme.base.space[1] },
  label: { fontSize: theme.base.text.xs, textAlign: 'center' },
  error: { color: theme.tokens.status.error, fontSize: theme.base.text.xs },
}));
