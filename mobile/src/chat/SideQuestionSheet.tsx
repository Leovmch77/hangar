import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { fmtWhen, formataErro, historicoLateral, perguntaLateral } from '@hangar/core';
import type { PerguntaLateral } from '@hangar/core';
import { Sheet } from '../ui/Sheet';
import { mkMarkdownStyle } from './AssistantBubble';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';

// Pergunta lateral (`/btw`): responde com o contexto da conversa sem entrar nela nem interromper.
// `question` vem do composer e dispara sozinha ao abrir; vazia, só abre o campo.
export function SideQuestionSheet({ open, name, question, onClose }: {
  open: boolean;
  name: string;
  question: string;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const markdownStyle = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const [items, setItems] = useState<PerguntaLateral[] | null>(null);
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const scroll = useRef<ScrollView>(null);
  // Uma época por abertura: a resposta de uma pergunta feita antes de fechar não cai na abertura seguinte.
  const epoch = useRef(0);
  const inFlightRef = useRef(false);

  const ask = async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    if (inFlightRef.current) {
      setError(m.btw_em_andamento());
      setText(q);
      return;
    }
    const my = epoch.current;
    inFlightRef.current = true;
    setInFlight(q);
    setError('');
    setText('');
    try {
      const r = await perguntaLateral(name, q);
      if (my === epoch.current) setItems((cur) => [...(cur ?? []), r]);
    } catch (e) {
      if (my !== epoch.current) return;
      setError(m.btw_nao_deu({ erro: formataErro(e) ?? String(e) }));
      setText(q);
    } finally {
      if (my === epoch.current) {
        inFlightRef.current = false;
        setInFlight(null);
      }
    }
  };

  useEffect(() => {
    if (!open) return;
    const my = ++epoch.current;
    inFlightRef.current = false;
    setInFlight(null);
    setError('');
    setItems(null);
    historicoLateral(name)
      .then((h) => { if (my === epoch.current) setItems(h); })
      .catch((e) => {
        if (my !== epoch.current) return;
        setItems((cur) => cur ?? []);
        setError(m.btw_historico_falhou({ erro: formataErro(e) ?? String(e) }));
      });
    if (question.trim()) void ask(question);
    // Só ao abrir: `ask` lê estado que muda a cada resposta e repetiria a pergunta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name, question]);

  return (
    <Sheet open={open} sizes={['large']} onDismiss={onClose} scrollable>
      <View style={styles.wrap}>
        <Text style={[styles.title, { color: theme.tokens.text.primary }]} accessibilityRole="header">{m.btw_titulo()}</Text>
        <Text style={[styles.hint, { color: theme.tokens.text.muted }]}>{m.btw_dica()}</Text>
        <ScrollView ref={scroll} style={styles.list} contentContainerStyle={styles.listContent}
                    onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
                    keyboardShouldPersistTaps="handled">
          {items === null ? (
            <ActivityIndicator color={theme.tokens.text.secondary} />
          ) : items.length === 0 && !inFlight ? (
            <Text style={[styles.hint, { color: theme.tokens.text.muted }]}>{m.btw_vazio()}</Text>
          ) : null}
          {(items ?? []).map((it) => (
            <View key={it.ts} style={[styles.item, { backgroundColor: superficie(theme, 0.6) }]}>
              <View style={styles.questionRow}>
                <Text style={[styles.question, { color: theme.tokens.text.primary }]}>{it.question}</Text>
                <Text style={[styles.time, { color: theme.tokens.text.muted }]}>{fmtWhen(it.ts)}</Text>
              </View>
              <EnrichedMarkdownText markdown={it.answer} markdownStyle={markdownStyle} flavor="github" />
              {it.fonte === 'pane' ? <Text style={[styles.warn, { color: theme.tokens.text.muted }]}>{m.btw_talvez_cortada()}</Text> : null}
              {it.salvo === false ? <Text style={[styles.warn, { color: theme.tokens.text.muted }]}>{m.btw_nao_guardada()}</Text> : null}
            </View>
          ))}
          {inFlight ? (
            <View style={[styles.item, { backgroundColor: superficie(theme, 0.6) }]} accessibilityLiveRegion="polite">
              <Text style={[styles.question, { color: theme.tokens.text.primary }]}>{inFlight}</Text>
              <View style={styles.questionRow}>
                <ActivityIndicator size="small" color={theme.tokens.text.secondary} />
                <Text style={[styles.hint, { color: theme.tokens.text.muted }]}>{m.btw_respondendo()}</Text>
              </View>
            </View>
          ) : null}
        </ScrollView>
        {error ? <Text style={[styles.warn, { color: theme.tokens.status.error }]} accessibilityRole="alert">{error}</Text> : null}
        <View style={styles.field}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={m.btw_placeholder()}
            placeholderTextColor={theme.tokens.text.muted}
            accessibilityLabel={m.btw_titulo()}
            multiline
            editable={!inFlight}
            style={[styles.input, { color: theme.tokens.text.primary, borderColor: theme.tokens.border.subtle }]}
          />
          <Pressable
            onPress={() => void ask(text)}
            disabled={!!inFlight || !text.trim()}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!inFlight || !text.trim() }}
            style={[styles.send, { borderColor: theme.tokens.accent.base }, (!!inFlight || !text.trim()) && styles.disabled]}
          >
            <Text style={[styles.sendText, { color: theme.tokens.accent.base }]}>{m.btw_perguntar()}</Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { padding: theme.base.space[3], gap: theme.base.space[2] },
  title: { fontSize: theme.base.text.base, fontWeight: '600' },
  hint: { fontSize: theme.base.text.sm },
  list: { maxHeight: 420 },
  listContent: { gap: theme.base.space[2] },
  item: { borderRadius: theme.base.radius.md, padding: theme.base.space[2], gap: theme.base.space[1] },
  questionRow: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2] },
  question: { flex: 1, fontSize: theme.base.text.sm, fontWeight: '600' },
  time: { fontSize: theme.base.text.xs },
  warn: { fontSize: theme.base.text.xs },
  field: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.base.space[2] },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: theme.base.radius.md,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: theme.base.space[2],
    fontSize: theme.base.text.base,
  },
  send: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[3],
  },
  sendText: { fontSize: theme.base.text.sm, fontWeight: '600' },
  disabled: { opacity: 0.5 },
}));
