import { memo } from 'react';
import { Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { nomeFerramenta, summarizeToolInput, summarizeToolResult, toolPhase, toolVerbo, type ChatEvent } from '@hangar/core';
import { callTarget } from './fold';
import * as m from '../../paraglide/messages';

// Uma chamada como linha do nativo: verbo apagado + alvo em mono. Rodando, o nome cru da ferramenta
// vem em destaque com "· em execução", que é o que diz o que está acontecendo agora; falhou, a linha
// inteira vai para a cor de aviso com a primeira linha do erro. Toque abre o detalhe.
// `onPress` recebe o próprio evento: a prop é a MESMA referência em toda a lista e o `memo` daqui não
// é anulado por uma arrow nova a cada token do streaming.
export const ToolCard = memo(function ToolCard({ use, result, onPress }: { use: ChatEvent; result?: ChatEvent | null; onPress: (use: ChatEvent) => void }) {
  const { theme } = useUnistyles();
  const fase = toolPhase(result ?? null);
  const alvo = callTarget(use.tool_name, summarizeToolInput(use.tool_name, use.tool_input));
  const vivo = fase === 'pending';
  const falhou = fase === 'error';
  const cor = falhou ? theme.tokens.status.warning : theme.tokens.text.muted;
  const rotulo = vivo ? nomeFerramenta(use.tool_name) : toolVerbo(use.tool_name);
  const erro = falhou ? summarizeToolResult(result, use.tool_name) : '';
  const fim = vivo ? `· ${m.estado_em_execucao()}` : erro && erro !== alvo ? `· ${erro}` : '';
  return (
    <Pressable
      onPress={() => onPress(use)}
      style={({ pressed }) => [styles.line, pressed && { backgroundColor: theme.tokens.bg.hover }]}
      accessibilityRole="button"
      accessibilityLabel={[rotulo, alvo, vivo ? m.estado_em_execucao() : falhou ? erro || m.formato_tool_falhou() : ''].filter(Boolean).join(', ')}
    >
      <Text style={[styles.verbo, { color: vivo ? theme.tokens.text.primary : falhou ? cor : theme.tokens.text.secondary }, vivo && styles.vivo]} numberOfLines={1}>
        {rotulo}
      </Text>
      <Text style={[styles.alvo, { color: cor }]} numberOfLines={1}>{alvo}</Text>
      {fim ? <Text style={[styles.fim, { color: cor }]} numberOfLines={1}>{fim}</Text> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  // Sem fundo e sem borda: a linha é texto apagado sobre o papel de parede, como no nativo.
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    minHeight: 36,
    paddingHorizontal: theme.base.space[1],
    borderRadius: theme.base.radius.sm,
  },
  verbo: { flexShrink: 0, maxWidth: '40%', fontSize: theme.base.text.xs, fontWeight: '500' },
  vivo: { fontWeight: '600' },
  alvo: { flexShrink: 1, minWidth: 0, fontSize: theme.base.text.xs, fontFamily: theme.base.fontMono },
  fim: { flexShrink: 0, maxWidth: '45%', fontSize: theme.base.text.xs },
}));
