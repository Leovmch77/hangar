import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { summarizeToolInput, summarizeToolResult, toolPhase, type ChatEvent } from '@hangar/core';
import { Icon } from '../../ui/Icon';
import { toolIcon } from './toolIcon';
import { superficie } from '../../theme/superficie';
import * as m from '../../paraglide/messages';

// ChatEvent.ts é epoch em SEGUNDOS (backend/app/transcript.py:_ts).
function duracao(use: ChatEvent, result?: ChatEvent | null): string | null {
  if (!use.ts || !result?.ts) return null;
  const s = Math.max(0, result.ts - use.ts);
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

// Card curto: ícone do verbo + resumo + duração/estado. Toque abre o detalhe.
// `semNome`: dentro de um grupo do mesmo tipo o nome já está no cabeçalho.
// `onPress` recebe o próprio evento em vez de ser fechado sobre ele por quem monta o card: assim a
// prop é a MESMA referência em toda a lista, e o `memo` daqui não é anulado por uma arrow nova a
// cada render do pai — que, durante o streaming, é a cada token.
export const ToolCard = memo(function ToolCard({ use, result, onPress, semNome }: { use: ChatEvent; result?: ChatEvent | null; onPress: (use: ChatEvent) => void; semNome?: boolean }) {
  const { theme } = useUnistyles();
  const fase = toolPhase(result ?? null);
  const resumo = summarizeToolInput(use.tool_name, use.tool_input);
  const cor = fase === 'error' ? theme.tokens.status.error : fase === 'pending' ? theme.tokens.accent.base : theme.tokens.text.secondary;
  const outcome = summarizeToolResult(result, use.tool_name);
  const estado = fase === 'pending' ? m.formato_rodando({ n: 1 })
    : fase === 'error' && outcome !== m.formato_tool_falhou() ? `${m.formato_tool_falhou()}: ${outcome}` : outcome;
  const duration = fase === 'done' ? duracao(use, result) : null;
  return (
    <Pressable
      onPress={() => onPress(use)}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: theme.tokens.bg.hover }]}
      accessibilityRole="button"
      accessibilityLabel={`${use.tool_name ?? m.formato_tool_generico()}: ${resumo} — ${estado}`}
    >
      <Icon name={toolIcon(use.tool_name)} size={15} color={cor} />
      <View style={styles.content}>
        {!semNome ? <Text style={[styles.nome, { color: theme.tokens.text.secondary }]}>{use.tool_name ?? m.formato_tool_generico()}</Text> : null}
        <Text style={[styles.resumo, { color: theme.tokens.text.primary }]} numberOfLines={2}>{resumo}</Text>
        <Text style={[styles.outcome, { color: cor }]}>{estado}</Text>
      </View>
      {duration ? <Text style={[styles.dir, { color: theme.tokens.text.secondary }]}>{duration}</Text> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  // Conteúdo: rgba com o alpha das caixas, nunca vidro com blur.
  card: {
    flexDirection: 'row', alignItems: 'flex-start', gap: theme.base.space[2], paddingHorizontal: theme.base.space[3], paddingVertical: theme.base.space[2], minHeight: 44,
    borderRadius: theme.base.radius.sm,
    backgroundColor: superficie(theme),
  },
  content: { flex: 1, gap: theme.base.space[1] },
  nome: { fontSize: theme.base.text.xs, fontWeight: '600' },
  resumo: { fontSize: theme.base.text.sm, fontFamily: theme.base.fontMono },
  outcome: { fontSize: theme.base.text.xs },
  dir: { fontSize: theme.base.text.xs, fontFamily: theme.base.fontMono, flexShrink: 1, maxWidth: '38%', textAlign: 'right' },
}));
