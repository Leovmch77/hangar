import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { rotuloEstado, type State } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { Icon } from '../../ui/Icon';
import { superficie } from '../../theme/superficie';
import type { MachineCandidates } from './groupPairs';

interface Props {
  machines: MachineCandidates[];
  picked: string[];
  disabled: boolean;
  emptyText: string;
  ariaLabel: (name: string, state: string) => string;
  onToggle: (key: string) => void;
}

/** Candidatas de todas as máquinas, separadas por máquina quando há mais de uma. */
export function PairCandidates({ machines, picked, disabled, emptyText, ariaLabel, onToggle }: Props) {
  const { theme } = useUnistyles();
  const stateDot = (state: State) => {
    if (state === 'working') return theme.tokens.accent.base;
    if (state === 'awaiting_input') return theme.tokens.status.warning;
    if (state === 'dead') return theme.tokens.status.error;
    return theme.tokens.status.success;
  };
  if (!machines.length) return !emptyText ? null : <Text style={[styles.empty, { color: theme.tokens.text.muted }]}>{emptyText}</Text>;
  const titled = machines.length > 1 || machines[0].status !== 'ready';

  return (
    <View style={styles.list}>
      {machines.map((machine) => (
        <View key={machine.serverId} style={styles.list}>
          {titled ? <Text style={[styles.machine, { color: theme.tokens.text.secondary }]} accessibilityRole="header">{machine.label}</Text> : null}
          {machine.status === 'loading' ? <Text style={[styles.note, { color: theme.tokens.text.muted }]}>{m.comum_carregando()}</Text> : null}
          {machine.status === 'no_identity' ? (
            <Text style={[styles.note, { color: theme.tokens.status.warning }]} accessibilityRole="alert">{m.grupo_recusa_sem_identificador()}</Text>
          ) : null}
          {machine.candidates.map(({ key, row, refusal }) => {
            const selected = picked.includes(key);
            const off = disabled || !!refusal;
            return (
              <Pressable
                key={key}
                onPress={() => onToggle(key)}
                disabled={off}
                style={[styles.row, { borderColor: selected ? theme.tokens.accent.base : 'transparent', backgroundColor: selected ? superficie(theme, 0.8) : 'transparent' }, refusal && styles.refused]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: off }}
                accessibilityLabel={ariaLabel(row.name, rotuloEstado(row.state))}
                accessibilityHint={refusal ? m.grupo_recusa_outra_dona() : undefined}
              >
                <View style={[styles.dot, { backgroundColor: stateDot(row.state) }]} />
                <View style={styles.main}>
                  <Text style={[styles.name, { color: theme.tokens.text.primary }]} numberOfLines={1}>{row.name}</Text>
                  {refusal ? <Text style={[styles.cwd, { color: theme.tokens.status.warning }]}>{m.grupo_recusa_outra_dona()}</Text>
                    : row.cwd ? <Text style={[styles.cwd, { color: theme.tokens.text.muted }]} numberOfLines={1}>{row.cwd}</Text> : null}
                </View>
                {row.pair_peers?.length ? (
                  <View style={styles.paired}>
                    <Icon name="Handshake" size={13} color={theme.tokens.text.muted} />
                    <Text style={[styles.pairedTxt, { color: theme.tokens.text.muted }]}>{row.pair_peers.length}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.base.space[1] },
  machine: { fontSize: theme.base.text.xs, fontWeight: theme.base.weight.bold, paddingTop: theme.base.space[2] },
  note: { fontSize: theme.base.text.sm, paddingVertical: theme.base.space[2] },
  empty: { fontSize: theme.base.text.sm, textAlign: 'center', paddingVertical: theme.base.space[3] },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3], paddingHorizontal: theme.base.space[3], paddingVertical: theme.base.space[2], borderWidth: 1, borderRadius: theme.base.radius.md },
  refused: { opacity: 0.6 },
  dot: { width: 8, height: 8, borderRadius: theme.base.radius.full, flexShrink: 0 },
  main: { flex: 1, minWidth: 0, gap: theme.base.space[0.5] },
  name: { fontSize: theme.base.text.base, fontWeight: theme.base.weight.semibold },
  cwd: { fontSize: theme.base.text.xs },
  paired: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[0.5], flexShrink: 0 },
  pairedTxt: { fontSize: theme.base.text.xs },
}));
