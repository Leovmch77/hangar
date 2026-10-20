import { Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as m from '../../paraglide/messages';
import { superficie } from '../../theme/superficie';
import { PairCandidates } from './PairCandidates';
import type { MachineCandidates } from './groupPairs';

interface Props {
  machines: MachineCandidates[];
  picked: string[];
  // nome de cada escolhida como vai no pedido (outra máquina: `<identificador>::<nome>`)
  pickedNames: string[];
  task: string;
  busy: boolean;
  error: string;
  loading: boolean;
  onToggle: (name: string) => void;
  onTaskChange: (value: string) => void;
  onPair: () => void;
}

export function PairPicker({ machines, picked, pickedNames, task, busy, error, loading, onToggle, onTaskChange, onPair }: Props) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.content}>
      <Text style={[styles.title, { color: theme.tokens.text.primary }]}>{m.par_parear_titulo()}</Text>
      <Text style={[styles.hint, { color: theme.tokens.text.secondary }]}>{m.par_passam_hint()}</Text>

      {error ? <Text style={[styles.error, { color: theme.tokens.status.error }]} accessibilityRole="alert" selectable>{error}</Text> : null}
      {loading ? <Text style={[styles.empty, { color: theme.tokens.text.muted }]}>{m.comum_carregando()}</Text> : (
        <PairCandidates
          machines={machines}
          picked={picked}
          disabled={busy}
          emptyText={error ? '' : m.forward_nenhuma_viva()}
          ariaLabel={(nome, estado) => m.par_parear_aria({ nome, estado })}
          onToggle={onToggle}
        />
      )}

      <TextInput
        value={task}
        onChangeText={onTaskChange}
        placeholder={m.par_tarefa_placeholder()}
        placeholderTextColor={theme.tokens.text.muted}
        style={[styles.taskInput, { color: theme.tokens.text.primary, backgroundColor: superficie(theme), borderColor: theme.tokens.border.default }]}
        returnKeyType="done"
        accessibilityLabel={m.par_tarefa_placeholder()}
      />

      <Pressable
        onPress={onPair}
        disabled={!picked.length || busy || loading}
        style={[styles.primary, { backgroundColor: theme.tokens.accent.base }, (!picked.length || busy || loading) && styles.disabled]}
        accessibilityRole="button"
      >
        <Text style={[styles.primaryText, { color: theme.tokens.text.inverse }]}>
          {busy ? m.par_pareando() : picked.length ? m.par_parear_nomes({ nomes: pickedNames.join(', ') }) : m.par_escolha_varias()}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.base.space[3] },
  title: { fontSize: theme.base.text.lg, fontWeight: theme.base.weight.bold },
  hint: { fontSize: theme.base.text.sm, lineHeight: 21 },
  error: { fontSize: theme.base.text.sm, lineHeight: 20 },
  empty: { fontSize: theme.base.text.sm, textAlign: 'center', paddingVertical: theme.base.space[3] },
  taskInput: { minHeight: 48, borderWidth: 1, borderRadius: theme.base.radius.md, paddingHorizontal: theme.base.space[3], fontSize: theme.base.text.sm },
  primary: { minHeight: 50, borderRadius: theme.base.radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.base.space[3] },
  primaryText: { fontSize: theme.base.text.base, fontWeight: theme.base.weight.bold, textAlign: 'center' },
  disabled: { opacity: 0.45 },
}));
