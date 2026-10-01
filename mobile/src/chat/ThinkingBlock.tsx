import { memo, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { resumoPensamento, type ChatEvent } from '@hangar/core';
import * as m from '../paraglide/messages';
import { mkMarkdownStyle } from './AssistantBubble';

// Um raciocínio como linha do trecho dobrado: "Raciocínio  <primeira frase>", e o toque abre o texto
// inteiro embaixo, em markdown (o resumo do raciocínio traz **título**). Vive dentro do fio do
// trecho, então não tem caixa própria.
export const ThinkingBlock = memo(function ThinkingBlock({ ev }: { ev: ChatEvent }) {
  const { theme } = useUnistyles();
  const [aberto, setAberto] = useState(false);
  const texto = ev.text ?? '';
  const md = useMemo(() => {
    const base = mkMarkdownStyle(theme);
    return { ...base, paragraph: { ...base.paragraph, color: theme.tokens.text.secondary, fontSize: theme.base.text.sm } };
  }, [theme]);
  return (
    <View>
      <Pressable
        onPress={() => setAberto((v) => !v)}
        style={({ pressed }) => [styles.line, pressed && { backgroundColor: theme.tokens.bg.hover }]}
        accessibilityRole="button"
        accessibilityLabel={m.pensamento_abrir()}
        accessibilityState={{ expanded: aberto }}
      >
        <Text style={[styles.rotulo, { color: theme.tokens.text.secondary }]}>{m.native_thinking()}</Text>
        {!aberto ? (
          <Text style={[styles.resumo, { color: theme.tokens.text.muted }]} numberOfLines={1}>
            {resumoPensamento(texto.replace(/\*\*/g, ''))}
          </Text>
        ) : null}
      </Pressable>
      {aberto ? (
        <View style={styles.texto}>
          <EnrichedMarkdownText markdown={texto} markdownStyle={md} flavor="github" />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    minHeight: 36,
    paddingHorizontal: theme.base.space[1],
    borderRadius: theme.base.radius.sm,
  },
  rotulo: { flexShrink: 0, fontSize: theme.base.text.xs, fontWeight: '500' },
  resumo: { flex: 1, minWidth: 0, fontSize: theme.base.text.xs, fontStyle: 'italic' },
  texto: {
    paddingHorizontal: theme.base.space[1],
    paddingBottom: theme.base.space[2],
  },
}));
