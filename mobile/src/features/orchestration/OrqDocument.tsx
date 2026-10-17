import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { formataErro, readCitedFile, retentarAgora, type FileContent } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { mkMarkdownStyle } from '../../chat/AssistantBubble';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import * as m from '../../paraglide/messages';
import { toast } from '../../ui/Toast';

export function onOrqLinkPress({ url }: { url: string }) {
  if (!/^(https?|mailto):/i.test(url)) return;
  Linking.openURL(url).catch((error: unknown) => toast.erro(error instanceof Error ? error.message : String(error)));
}

export function OrqDocument({ serverId, name, path, onClose }: { serverId: string; name: string; path: string; onClose: () => void }) {
  const { theme } = useUnistyles();
  const ready = useServers(s => s.ready);
  const server = useServers(s => s.servers.find(item => item.id === serverId && !item.removed) ?? null);
  const markdownStyle = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ content: FileContent | null; error: string | null }>({ content: null, error: null });
  useEffect(() => {
    let current = true;
    setResult({ content: null, error: null });
    if (ready && server && !server.invite) {
      readCitedFile(name, path, server).then(
        content => { if (current) setResult({ content, error: null }); },
        error => { if (current) setResult({ content: null, error: formataErro(error) ?? String(error) }); },
      );
    }
    return () => { current = false; };
  }, [ready, server, name, path, attempt]);
  const error = ready && !server ? m.chat_servidor_removido() : server?.invite ? m.lista_acesso_recusado() : result.error;
  return (
    <Sheet open sizes={['large']} scrollable onDismiss={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={2}>{path}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={m.arq_fechar()}>
            <Icon name="X" size={theme.base.text.xl} color={theme.tokens.text.secondary} />
          </Pressable>
        </View>
        {error ? <View style={styles.content}>
          <Text style={styles.error} accessibilityRole="alert">{error}</Text>
          {server && !server.invite ? <Pressable accessibilityRole="button" accessibilityLabel={m.orq_panel_retry()} onPress={() => { retentarAgora(serverId); setAttempt(n => n + 1); }}>
            <Text style={styles.action}>{m.orq_panel_retry()}</Text>
          </Pressable> : null}
        </View> : result.content ? <ScrollView contentContainerStyle={styles.content}>
          {result.content.truncated ? <Text style={styles.error}>{m.arq_arquivo_cortado()}</Text> : null}
          {result.content.text.trim() ? <EnrichedMarkdownText markdown={result.content.text} markdownStyle={markdownStyle} flavor="github" onLinkPress={onOrqLinkPress} /> : <Text style={styles.note}>{m.native_file_empty()}</Text>}
        </ScrollView> : <View style={styles.content}>
          <ActivityIndicator color={theme.tokens.text.muted} />
          <Text style={styles.note}>{m.comum_carregando()}</Text>
        </View>}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create(theme => ({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3], padding: theme.base.space[4] },
  title: { flex: 1, fontSize: theme.base.text.sm, fontWeight: '600', color: theme.tokens.text.primary },
  content: { padding: theme.base.space[4], gap: theme.base.space[3] },
  note: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.warning },
  action: { fontSize: theme.base.text.sm, color: theme.tokens.accent.base },
}));
