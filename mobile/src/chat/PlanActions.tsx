import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { planTitle } from '@hangar/core';
import * as m from '../paraglide/messages';
import { superficie } from '../theme/superficie';

// Decisão sobre o plano proposto (Codex, ou Claude sem terminal em modo plano), como o cartão do
// PWA: "Continuar planejando" só tira a decisão da tela; responder no campo segue valendo.
// A tela monta com `key` = plano: plano novo começa sem erro e sem dispensa.
export function PlanActions({ plan, disabled, onImplement }: {
  plan: string;
  disabled: boolean;
  onImplement: (plan: string) => Promise<void>;
}) {
  const { theme } = useUnistyles();
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  if (dismissed) return null;

  const implement = async () => {
    if (disabled || sending) return;
    setSending(true);
    setError('');
    try {
      await onImplement(plan);
      setDismissed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : m.chat_plan_erro());
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={[styles.wrap, { backgroundColor: superficie(theme, 0.8) }]} accessibilityLabel={m.chat_plan_proposto()}>
      <Text style={[styles.title, { color: theme.tokens.text.primary }]} numberOfLines={2}>
        {planTitle(plan) ?? m.chat_plan_proposto()}
      </Text>
      <View style={styles.row}>
        <Pressable
          onPress={() => void implement()}
          disabled={disabled || sending}
          accessibilityRole="button"
          accessibilityState={{ disabled: disabled || sending, busy: sending }}
          style={[styles.btn, { backgroundColor: theme.tokens.accent.base }, (disabled || sending) && styles.off]}
        >
          {sending ? <ActivityIndicator size="small" color={theme.tokens.text.inverse} /> : null}
          <Text style={[styles.btnText, { color: theme.tokens.text.inverse }]}>
            {sending ? m.chat_plan_iniciando() : m.chat_plan_implementar()}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setDismissed(true)}
          disabled={sending}
          accessibilityRole="button"
          style={[styles.btn, styles.ghost, { borderColor: theme.tokens.border.subtle }]}
        >
          <Text style={[styles.btnText, { color: theme.tokens.text.secondary }]}>{m.chat_plan_continuar()}</Text>
        </Pressable>
      </View>
      {error ? <Text style={[styles.error, { color: theme.tokens.status.error }]} accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    borderRadius: theme.base.radius.lg,
    padding: theme.base.space[3],
    gap: theme.base.space[2],
  },
  title: { fontSize: theme.base.text.sm, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2] },
  btn: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[1],
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[3],
  },
  ghost: { borderWidth: 1 },
  btnText: { fontSize: theme.base.text.sm, fontWeight: '600' },
  off: { opacity: 0.5 },
  error: { fontSize: theme.base.text.xs },
}));
