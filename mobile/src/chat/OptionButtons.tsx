import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { kindOf, isPermission } from '@hangar/core';
import * as m from '../paraglide/messages';
import { superficie } from '../theme/superficie';
import { Icon } from '../ui/Icon';
import { semEmoji } from '../ui/semEmoji';

interface Props {
  question: string;
  options: string[];
  onSelect: (n: number) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export function OptionButtons({ question, options, onSelect, onCancel }: Props) {
  const { theme } = useUnistyles();
  const permission = isPermission(options);
  const kinds = options.map((o) => kindOf(o));
  const locked = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function run(action: () => void | Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : m.comum_falha_envio_opcao());
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      {permission ? (
        <View style={[styles.permChip, { backgroundColor: theme.tokens.accent.dim }]}>
          <Icon name="ShieldAlert" size={13} color={theme.tokens.accent.base} />
          <Text style={[styles.permTxt, { color: theme.tokens.accent.base }]}>{semEmoji(m.permissao_pedido())}</Text>
        </View>
      ) : null}
      <Text style={[styles.question, { color: theme.tokens.text.primary }]}>
        {question.split('`').map((part, i) =>
          i % 2 === 1 ? (
            <Text key={i} style={[styles.qCode, { backgroundColor: superficie(theme, 0.8), color: theme.tokens.text.primary }]}>
              {part}
            </Text>
          ) : (
            part
          ),
        )}
      </Text>
      <View style={styles.list}>
        {options.map((opt, i) => {
          const kind = kinds[i];
          const isAllow = permission && kind === 'allow';
          const isAlways = permission && kind === 'always';
          const isDeny = permission && kind === 'deny';
          return (
            <Pressable
              key={i}
              onPress={() => void run(() => onSelect(i + 1))}
              disabled={busy}
              accessibilityState={{ disabled: busy, busy }}
              style={[
                styles.btn,
                { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.default },
                isAllow && { backgroundColor: theme.tokens.accent.base, borderColor: theme.tokens.accent.base },
                isAlways && { backgroundColor: theme.tokens.accent.dim, borderColor: theme.tokens.accent.base },
                isDeny && { borderColor: theme.tokens.status.error },
              ]}
              accessibilityRole="button"
            >
              <Text
                style={[
                  styles.num,
                  { color: theme.tokens.text.secondary },
                  isAllow && { color: '#fff' },
                  isAlways && { color: theme.tokens.accent.base },
                  isDeny && { color: theme.tokens.status.error },
                ]}
              >
                {i + 1}.
              </Text>
              <Text
                style={[
                  styles.optTxt,
                  { color: theme.tokens.text.primary },
                  isAllow && { color: '#fff' },
                  isAlways && { color: theme.tokens.accent.base },
                  isDeny && { color: theme.tokens.status.error },
                ]}
              >
                {opt}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => void run(onCancel)}
          disabled={busy}
          accessibilityState={{ disabled: busy, busy }}
          style={[styles.btn, styles.btnCancel, { borderColor: theme.tokens.status.error }]}
          accessibilityRole="button"
        >
          <Text style={[styles.num, { color: theme.tokens.status.error }]}>✕</Text>
          <Text style={[styles.optTxt, { color: theme.tokens.status.error }]}>{m.comum_cancelar()}</Text>
        </Pressable>
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: theme.tokens.status.error }}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    padding: theme.base.space[3],
    gap: theme.base.space[3],
  },
  permChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 4,
  },
  permTxt: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  question: {
    fontSize: theme.base.text.base,
    fontWeight: '500',
    lineHeight: 22,
  },
  qCode: {
    fontFamily: theme.base.fontMono,
    fontSize: 13,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  list: {
    gap: theme.base.space[2],
  },
  btn: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[3],
    paddingHorizontal: theme.base.space[3],
    borderWidth: 1,
    borderRadius: theme.base.radius.lg,
  },
  btnCancel: {
    borderColor: theme.tokens.status.error,
  },
  num: {
    fontFamily: theme.base.fontMono,
    fontSize: theme.base.text.sm,
    minWidth: 20,
  },
  optTxt: {
    fontSize: theme.base.text.base,
    flex: 1,
  },
}));
