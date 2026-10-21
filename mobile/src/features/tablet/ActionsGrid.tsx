import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { getConfigForServer, resolveShortcuts, sendInputForServer, sendsDirect, shortcutMissingSecret, type Shortcut } from '@hangar/core';
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

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setLoadError('');
    if (!server) {
      setLoadError(m.chat_servidor_removido());
      return;
    }
    getConfigForServer(server).then((config) => {
      if (cancelled) return;
      if (!config || typeof config.campos !== 'object' || config.campos === null) throw new Error(m.native_invalid_response());
      const raw = config.campos.shortcuts?.valor;
      setItems(panelShortcuts(resolveShortcuts(typeof raw === 'string' ? raw : '')));
    }).catch((e: unknown) => {
      if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [server, retry]);

  async function run(shortcut: Shortcut) {
    if (shortcut.type === 'internal') {
      router.push(`/s/${serverId}/${name}/${shortcut.action === 'anexos' ? 'attachments' : 'terminal'}`);
      return;
    }
    if (shortcut.type !== 'send_text') return;
    try {
      const missing = shortcutMissingSecret(shortcut);
      if (missing) throw new Error(m.atalhos_segredo_falta({ nome: missing }));
      if (sendsDirect(shortcut)) {
        if (!server) throw new Error(m.chat_servidor_removido());
        await sendInputForServer(server, name, shortcut.text);
        haptic.success();
      } else {
        const current = readDraft(serverId, name) ?? {
          version: 1 as const, text: '', revision: 0, transcript: null, attachments: [], submission: null,
        };
        writeDraft(serverId, name, { ...current, text: shortcut.text, revision: current.revision + 1 });
        chatStore(serverId, name).use.setState((s) => ({ draftUpdate: s.draftUpdate + 1 }));
      }
    } catch (e) {
      toast.erro(e instanceof Error ? e.message : String(e));
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
  if (items.length === 0) return null;
  return (
    <View style={styles.feedback}>
      <View style={styles.grid}>
        {items.map((shortcut) => {
          const label = shortcut.type === 'internal' ? NATIVE_LABEL[shortcut.action]() : shortcut.label;
          return (
            <Pressable key={shortcut.id} accessibilityRole="button" accessibilityLabel={label}
              onPress={() => {
                if (shortcut.confirm) {
                  Alert.alert(m.native_shortcut_confirm({ label }), undefined, [
                    { text: m.native_cancel(), style: 'cancel' },
                    { text: m.comum_confirmar(), onPress: () => { void run(shortcut); } },
                  ]);
                } else void run(shortcut);
              }}
              style={({ pressed }) => [styles.action, { borderColor: c.border, backgroundColor: pressed ? c.hover : c.inset }]}>
              <ShortcutIcon icon={shortcut.type === 'internal' ? NATIVE_ICON[shortcut.action] : shortcut.icon} size={22} color={c.accentText} />
              <Text style={[styles.label, { color: c.text }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
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
