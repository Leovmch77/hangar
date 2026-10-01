import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { toolPhase, type ChatEvent } from '@hangar/core';
import { Icon } from '../../ui/Icon';
import { ToolCard } from './ToolCard';
import { ThinkingBlock } from '../ThinkingBlock';
import { failedLabel, foldCalls, foldTitle } from './fold';
import * as m from '../../paraglide/messages';

// Um trecho inteiro é UMA linha da lista virtualizada: abrir 300 linhas de uma vez monta 300 views
// num único item. Mostra as primeiras e deixa o resto atrás de um toque.
const TETO = 40;

// Trecho de trabalho dobrado como no nativo: "› 3 raciocínios · rodou 2 comandos · 1 falhou".
// Aberto, as linhas ficam num fio vertical à esquerda. A chamada VIVA aparece sob o cabeçalho mesmo
// fechado, senão o resumo escondia o que está acontecendo agora. Trecho de uma linha só não ganha
// cabeçalho: dobrar uma linha numa linha não resume nada.
export const ToolGroup = memo(function ToolGroup({ parts, resultOf, onAbrir }: { parts: ChatEvent[]; resultOf: (t: ChatEvent) => ChatEvent | null; onAbrir: (use: ChatEvent) => void }) {
  const { theme } = useUnistyles();
  const [aberto, setAberto] = useState(false);
  const [tudo, setTudo] = useState(false);
  const linhas = parts.filter((p) => p.kind === 'thinking' || (p.kind === 'tool_use' && p.tool_name !== 'ToolSearch'));
  const calls = foldCalls(parts);
  const fases = calls.map((c) => toolPhase(resultOf(c)));
  const vivas = calls.filter((_c, i) => fases[i] === 'pending');
  const falhas = failedLabel(fases.filter((f) => f === 'error').length);

  const linha = (p: ChatEvent) =>
    p.kind === 'thinking'
      ? <ThinkingBlock key={p.id} ev={p} />
      : <ToolCard key={p.id} use={p} result={resultOf(p)} onPress={onAbrir} />;

  if (linhas.length === 1) return linha(linhas[0]);
  if (linhas.length === 0) return null;

  const titulo = foldTitle(parts);
  const visiveis = tudo ? linhas : linhas.slice(0, TETO);
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setAberto((v) => !v)}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: theme.tokens.bg.hover }]}
        accessibilityRole="button"
        accessibilityLabel={[titulo, falhas].filter(Boolean).join(', ')}
        accessibilityState={{ expanded: aberto }}
      >
        <Icon name={aberto ? 'ChevronDown' : 'ChevronRight'} size={14} color={theme.tokens.text.muted} />
        <Text style={styles.titulo} numberOfLines={1}>
          <Text style={{ color: theme.tokens.text.muted }}>{titulo}</Text>
          {falhas ? <Text style={{ color: theme.tokens.status.warning }}>{` · ${falhas}`}</Text> : null}
        </Text>
      </Pressable>
      {!aberto && vivas.length ? (
        <View style={styles.vivas}>{vivas.map(linha)}</View>
      ) : null}
      {aberto ? (
        <View style={[styles.fio, { borderLeftColor: theme.tokens.border.default }]}>
          {visiveis.map(linha)}
          {!tudo && linhas.length > TETO ? (
            <Pressable onPress={() => setTudo(true)} style={({ pressed }) => [styles.mais, pressed && { backgroundColor: theme.tokens.bg.hover }]} accessibilityRole="button">
              <Text style={[styles.maisTxt, { color: theme.tokens.text.secondary }]}>{m.tool_mostrar_todas({ n: linhas.length })}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: 2 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: theme.base.space[1],
    borderRadius: theme.base.radius.sm,
  },
  titulo: { flex: 1, minWidth: 0, fontSize: theme.base.text.sm },
  vivas: { paddingLeft: theme.base.space[1] },
  // Fio à esquerda em vez de caixa: o trabalho é aparte da conversa, não um cartão — superfície
  // própria aqui viraria retângulo chapado por cima do papel de parede.
  fio: { marginLeft: 10, paddingLeft: theme.base.space[2], borderLeftWidth: 1 },
  mais: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[1] },
  maisTxt: { fontSize: theme.base.text.xs, fontWeight: '600' },
}));
