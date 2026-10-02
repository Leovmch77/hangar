import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { CommandInfo } from '@hangar/core';
import { commandDescription } from './CommandSheet';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';

// Sugestões acima do campo enquanto a linha é só `/nome`: no fluxo, nunca atrás do teclado.
export function SlashSuggest({ matches, onPick, error, onRetry }: {
  matches: CommandInfo[];
  onPick: (c: CommandInfo) => void;
  // Lista que não carregou: sem isto o `/` só não sugeria nada, e o erro ficava só na folha.
  error?: string;
  onRetry?: () => void;
}) {
  const { theme } = useUnistyles();
  if (!matches.length && error) {
    return (
      <View style={[styles.list, styles.errorRow, { borderColor: theme.tokens.border.subtle, backgroundColor: superficie(theme, 0.8) }]}>
        <Text style={[styles.desc, { color: theme.tokens.status.error }]} numberOfLines={2} accessibilityRole="alert">
          {m.native_commands_failed({ reason: error })}
        </Text>
        {onRetry ? (
          <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8} style={styles.retry}>
            <Text style={[styles.retryTxt, { color: theme.tokens.accent.base }]}>{m.lista_tentar_novamente()}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  if (!matches.length) return null;
  return (
    <ScrollView
      style={[styles.list, { borderColor: theme.tokens.border.subtle, backgroundColor: superficie(theme, 0.8) }]}
      keyboardShouldPersistTaps="always"
      accessibilityLabel={m.slash_sugestoes()}
    >
      {matches.map((c) => {
        const desc = commandDescription(c);
        return (
          <Pressable
            key={`${c.source}:${c.name}`}
            onPress={() => onPick(c)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.tokens.bg.hover }]}
            accessibilityRole="button"
            accessibilityLabel={c.display}
            accessibilityHint={desc ?? undefined}
          >
            <Text style={[styles.name, { color: theme.tokens.text.primary }]} numberOfLines={1}>{c.display}</Text>
            {desc ? <Text style={[styles.desc, { color: theme.tokens.text.muted }]} numberOfLines={1}>{desc}</Text> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  // ~4 linhas à vista; o resto rola.
  list: {
    maxHeight: 176,
    borderWidth: 1,
    borderRadius: theme.base.radius.md,
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    paddingHorizontal: theme.base.space[2],
  },
  name: { flexShrink: 0, maxWidth: '60%', fontSize: theme.base.text.sm, fontFamily: theme.base.fontMono },
  desc: { flex: 1, fontSize: theme.base.text.xs },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingHorizontal: theme.base.space[2] },
  retry: { minHeight: 44, justifyContent: 'center' },
  retryTxt: { fontSize: theme.base.text.sm, fontWeight: '600' },
}));
