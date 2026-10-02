import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getCommands } from '@hangar/core';
import type { CommandInfo } from '@hangar/core';
import { Sheet } from '../ui/Sheet';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';

// Uma busca por sessão: a lista vale para a folha e para as sugestões em linha, e não muda entre
// aberturas. No Codex ela não fica guardada, como no PWA.
const cache = new Map<string, CommandInfo[]>();

export function useSessionCommands(name: string, provider: string | null, wanted: boolean) {
  const key = `${provider ?? 'claude'}|${name}`;
  const [commands, setCommands] = useState<CommandInfo[] | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!wanted || commands) return;
    let alive = true;
    setError('');
    getCommands(name)
      .then((c) => {
        if (provider !== 'codex') cache.set(key, c);
        if (alive) setCommands(c);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [wanted, commands, name, provider, key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { commands, error, retry };
}

// Descrições dos built-ins são interface (o catálogo fixo do Claude Code), então são traduzidas
// aqui; as de skills e plugins vêm do frontmatter do usuário e passam cruas.
const BUILTIN_DESCRIPTION: Record<string, () => string> = {
  clear: m.cmd_clear,
  compact: m.cmd_compact,
  context: m.cmd_context,
  model: m.cmd_model,
  effort: m.cmd_effort,
  resume: m.cmd_resume,
  rewind: m.cmd_rewind,
  'release-notes': m.cmd_release_notes,
  help: m.cmd_help,
  status: m.cmd_status,
  cost: m.cmd_cost,
  export: m.cmd_export,
  init: m.cmd_init,
  agents: m.cmd_agents,
  mcp: m.cmd_mcp,
  memory: m.cmd_memory,
  vim: m.cmd_vim,
  config: m.cmd_config,
  doctor: m.cmd_doctor,
  quit: m.cmd_quit,
};

export function commandDescription(c: CommandInfo): string | null {
  return (c.source === 'builtin' ? BUILTIN_DESCRIPTION[c.name]?.() : undefined) ?? c.description ?? null;
}

export function confirmDestructive(c: CommandInfo, run: () => void) {
  Alert.alert(m.comandos_confirmar({ n: c.display }), commandDescription(c) ?? undefined, [
    { text: m.comandos_nao(), style: 'cancel' },
    { text: m.comandos_sim(), style: 'destructive', onPress: run },
  ]);
}

const sourceBadge = (source: CommandInfo['source']) => (source === 'builtin' ? 'base' : source);

// Folha de comandos: busca, grupos e a ação de cada um — `/model` e `/effort` abrem o seletor,
// destrutivo pergunta antes, com argumento preenche o campo, o resto envia na hora.
export function CommandSheet({
  open,
  onClose,
  commands,
  error,
  onRetry,
  fillOnly,
  onCommand,
  onFill,
  onOpenModelEffort,
}: {
  open: boolean;
  onClose: () => void;
  commands: CommandInfo[] | null;
  error: string;
  onRetry: () => void;
  // Codex: tocar só preenche, a pessoa revisa e envia.
  fillOnly: boolean;
  onCommand: (cmd: string) => void;
  onFill: (name: string) => void;
  onOpenModelEffort: (which: 'model' | 'effort') => void;
}) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = (commands ?? []).filter((c) => !q || c.name.toLowerCase().includes(q)
    || (commandDescription(c)?.toLowerCase().includes(q) ?? false));
  const groups = ([
    { key: 'builtin', label: m.comandos_builtins() },
    { key: 'skill', label: m.comandos_suas_skills() },
    { key: 'plugin', label: m.comandos_plugins() },
  ] as const)
    .map((g) => ({ ...g, items: filtered.filter((c) => c.source === g.key) }))
    .filter((g) => g.items.length > 0);

  // A ação roda depois que a folha some: outra folha (seletor, pergunta lateral) apresentada no
  // meio do fechamento desta não abre.
  const afterClose = useRef<(() => void) | null>(null);
  const finish = (action: () => void) => {
    afterClose.current = action;
    onClose();
  };
  const tap = (c: CommandInfo) => {
    if (fillOnly) { finish(() => onFill(c.name)); return; }
    if (c.name === 'model' || c.name === 'effort') { finish(() => onOpenModelEffort(c.name as 'model' | 'effort')); return; }
    if (c.destructive) { confirmDestructive(c, () => finish(() => onCommand('/' + c.name))); return; }
    if (c.argumentHint) { finish(() => onFill(c.name)); return; }
    finish(() => onCommand('/' + c.name));
  };

  return (
    <Sheet
      open={open}
      sizes={['large']}
      onDismiss={() => {
        onClose();
        const action = afterClose.current;
        afterClose.current = null;
        action?.();
      }}
      scrollable
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.tokens.text.primary }]} accessibilityRole="header">{m.comandos_titulo()}</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={m.comandos_buscar()}
          placeholderTextColor={theme.tokens.text.muted}
          accessibilityLabel={m.comandos_buscar()}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.search, { color: theme.tokens.text.primary, backgroundColor: superficie(theme, 0.6), borderColor: theme.tokens.border.subtle }]}
        />
        {error ? (
          <View style={styles.centro}>
            <Text style={[styles.muted, { color: theme.tokens.status.error }]}>{error}</Text>
            <Pressable onPress={onRetry} accessibilityRole="button" style={styles.retry}>
              <Text style={[styles.retryTxt, { color: theme.tokens.accent.base }]}>{m.lista_tentar_novamente()}</Text>
            </Pressable>
          </View>
        ) : !commands ? (
          <ActivityIndicator color={theme.tokens.text.secondary} />
        ) : groups.length === 0 ? (
          <Text style={[styles.muted, { color: theme.tokens.text.muted }]}>{m.comandos_vazio()}</Text>
        ) : (
          groups.map((g) => (
            <View key={g.key} style={styles.group}>
              <Text style={[styles.groupLabel, { color: theme.tokens.text.muted }]} accessibilityRole="header">{g.label}</Text>
              {g.items.map((c) => {
                const desc = commandDescription(c);
                return (
                  <Pressable
                    key={`${c.source}:${c.name}`}
                    onPress={() => tap(c)}
                    style={({ pressed }) => [styles.item, pressed && { backgroundColor: theme.tokens.bg.hover }]}
                    accessibilityRole="button"
                    accessibilityLabel={c.display}
                    accessibilityHint={desc ?? undefined}
                  >
                    <View style={styles.txt}>
                      <Text style={[styles.nome, { color: theme.tokens.text.primary }]} numberOfLines={1}>
                        {c.display}
                        {c.argumentHint ? <Text style={{ color: theme.tokens.text.muted }}> {c.argumentHint}</Text> : null}
                      </Text>
                      {desc ? (
                        <Text style={[styles.desc, { color: theme.tokens.text.muted }]} numberOfLines={2}>{desc}</Text>
                      ) : null}
                    </View>
                    <Text style={[styles.badge, { color: theme.tokens.text.muted, borderColor: theme.tokens.border.subtle }]}>{sourceBadge(c.source)}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  inner: { gap: theme.base.space[1], padding: theme.base.space[3] },
  title: { fontSize: theme.base.text.base, fontWeight: '600', marginBottom: theme.base.space[1] },
  search: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: theme.base.radius.md,
    paddingHorizontal: theme.base.space[3],
    fontSize: theme.base.text.base,
    marginBottom: theme.base.space[2],
  },
  muted: { fontSize: theme.base.text.sm, textAlign: 'center', paddingVertical: theme.base.space[3] },
  centro: { alignItems: 'center', gap: theme.base.space[1] },
  retry: { minHeight: 44, justifyContent: 'center' },
  retryTxt: { fontSize: theme.base.text.sm, fontWeight: '600' },
  group: { gap: 2, marginBottom: theme.base.space[2] },
  groupLabel: { fontSize: theme.base.text.xs, fontWeight: '600', textTransform: 'uppercase', paddingHorizontal: theme.base.space[2] },
  item: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    paddingHorizontal: theme.base.space[2],
    paddingVertical: theme.base.space[1],
    borderRadius: theme.base.radius.md,
  },
  txt: { flex: 1, gap: 1 },
  nome: { fontSize: theme.base.text.base, fontFamily: theme.base.fontMono },
  desc: { fontSize: theme.base.text.xs },
  badge: {
    fontSize: theme.base.text.xxs,
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
}));
