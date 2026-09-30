import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { toolGroupCounts, toolGroupLabel, toolPhase, type ChatEvent } from '@hangar/core';
import { Icon } from '../../ui/Icon';
import { ToolCard } from './ToolCard';
import * as m from '../../paraglide/messages';

// Um grupo inteiro é UMA linha da lista virtualizada: abrir 300 cards de uma vez monta 300 views
// num único item. Mostra as primeiras e deixa o resto atrás de um toque.
const TETO = 40;

// Burst de 3+ chamadas = UMA linha ("Ferramentas: 2 rodando • 3 concluídos"). Aberto, lista os
// ToolCards; a chamada VIVA aparece sob o cabeçalho mesmo fechado, senão o painel escondia o agora.
export const ToolGroup = memo(function ToolGroup({ tools, resultOf, onAbrir }: { tools: ChatEvent[]; resultOf: (t: ChatEvent) => ChatEvent | null; onAbrir: (use: ChatEvent) => void }) {
  const { theme } = useUnistyles();
  const [aberto, setAberto] = useState(false);
  const [tudo, setTudo] = useState(false);
  const fases = tools.map((t) => toolPhase(resultOf(t)));
  const label = toolGroupLabel(tools.map((t) => t.tool_name));
  const mixed = label === m.lista_ferramentas();
  const erro = fases.includes('error');
  const viva = tools.find((_t, i) => fases[i] === 'pending');
  const visiveis = tudo ? tools : tools.slice(0, TETO);
  return (
    <View style={styles.wrap}>
      <Pressable onPress={() => setAberto((v) => !v)} style={({ pressed }) => [styles.head, pressed && { backgroundColor: theme.tokens.bg.hover }]} accessibilityRole="button" accessibilityState={{ expanded: aberto }}>
        <Icon name={aberto ? 'ChevronDown' : 'ChevronRight'} size={14} color={theme.tokens.text.muted} />
        <View style={styles.summary}>
          <Text style={[styles.label, { color: theme.tokens.text.primary }]}>{label}</Text>
          <Text style={[styles.counts, { color: erro ? theme.tokens.status.error : theme.tokens.text.secondary }]}>{toolGroupCounts(fases)}</Text>
        </View>
      </Pressable>
      {!aberto && viva ? <ToolCard use={viva} result={resultOf(viva)} semNome={!mixed} onPress={onAbrir} /> : null}
      {aberto ? visiveis.map((t) => <ToolCard key={t.id} use={t} result={resultOf(t)} semNome={!mixed} onPress={onAbrir} />) : null}
      {aberto && !tudo && tools.length > TETO ? (
        <Pressable onPress={() => setTudo(true)} style={({ pressed }) => [styles.mais, pressed && { backgroundColor: theme.tokens.bg.hover }]} accessibilityRole="button">
          <Text style={[styles.maisTxt, { color: theme.tokens.accent.base }]}>{m.tool_mostrar_todas({ n: tools.length })}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingVertical: theme.base.space[2], paddingHorizontal: theme.base.space[1], minHeight: 44 },
  summary: { flex: 1, gap: theme.base.space[1] },
  label: { fontSize: theme.base.text.sm, fontWeight: '600' },
  counts: { fontSize: theme.base.text.xs },
  mais: { paddingVertical: 8, paddingHorizontal: 10, minHeight: 44, justifyContent: 'center' },
  maisTxt: { fontSize: theme.base.text.xs, fontWeight: '600' },
}));
