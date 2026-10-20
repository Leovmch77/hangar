import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { State } from '@hangar/core';
import { rotuloEstado } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { Icon } from '../../ui/Icon';
import { PairCandidates } from './PairCandidates';
import type { MachineCandidates, MemberView } from './groupPairs';

interface Props {
  members: MemberView[];
  machines: MachineCandidates[];
  picked: string[];
  pickedNames: string[];
  adding: boolean;
  busy: boolean;
  onOpenMember: (member: MemberView) => void;
  onToggleAdding: () => void;
  onToggle: (name: string) => void;
  onAdd: () => void;
  onLeave: () => void;
}

export function PairMembers({ members, machines, picked, pickedNames, adding, busy, onOpenMember, onToggleAdding, onToggle, onAdd, onLeave }: Props) {
  const { theme } = useUnistyles();
  const stateDot = (state: State) => {
    if (state === 'working') return theme.tokens.accent.base;
    if (state === 'awaiting_input') return theme.tokens.status.warning;
    if (state === 'dead') return theme.tokens.status.error;
    return theme.tokens.status.success;
  };

  return (
    <View style={styles.content}>
      <Text style={[styles.title, { color: theme.tokens.text.primary }]}>{m.par_grupo_titulo({ n: members.length + 1 })}</Text>
      <Text style={[styles.hint, { color: theme.tokens.text.secondary }]}>{m.par_membros_hint()}</Text>

      <View style={styles.list}>
        {members.map((member) => {
          const { state, machine } = member;
          const detail = member.missing && machine ? m.grupo_membro_maquina_desconectada({ maquina: machine })
            : [machine, state ? rotuloEstado(state) : null].filter(Boolean).join(' · ');
          const content = <>
            <View style={[styles.dot, { backgroundColor: state ? stateDot(state) : theme.tokens.text.muted }]} />
            <View style={styles.main}>
              <Text style={[styles.name, { color: member.missing ? theme.tokens.text.muted : theme.tokens.text.primary }]} numberOfLines={1}>{member.name}</Text>
              {detail ? <Text style={[styles.state, { color: theme.tokens.text.muted }]} numberOfLines={1}>{detail}</Text> : null}
            </View>
          </>;
          // Sem conversa para abrir é só texto: um botão desligado seria anunciado como ação.
          if (!member.target) {
            return (
              <View key={member.key} style={styles.memberRow} accessible accessibilityRole="text"
                    accessibilityLabel={[member.name, detail].filter(Boolean).join(', ')}>
                {content}
              </View>
            );
          }
          return (
            <Pressable
              key={member.key}
              onPress={() => onOpenMember(member)}
              style={styles.memberRow}
              accessibilityRole="button"
              accessibilityLabel={m.par_abrir_conversa_de({ nome: member.name })}
            >
              {content}
              <Icon name="ChevronRight" size={18} color={theme.tokens.text.muted} />
            </Pressable>
          );
        })}
      </View>

      {!adding ? (
        <Pressable onPress={onToggleAdding} style={[styles.secondary, { borderColor: theme.tokens.border.default }]} accessibilityRole="button">
          <Text style={[styles.secondaryText, { color: theme.tokens.text.secondary }]}>{m.par_adicionar_sessao()}</Text>
        </Pressable>
      ) : (
        <View style={styles.addingBlock}>
          <PairCandidates
            machines={machines}
            picked={picked}
            disabled={busy}
            emptyText={m.par_vazio_fora_grupo()}
            ariaLabel={(nome, estado) => m.par_adicionar_aria({ nome, estado })}
            onToggle={onToggle}
          />
          <Pressable onPress={onAdd} disabled={!picked.length || busy} style={[styles.primary, { backgroundColor: theme.tokens.accent.base }, (!picked.length || busy) && styles.disabled]} accessibilityRole="button">
            <Text style={[styles.primaryText, { color: theme.tokens.text.inverse }]}>
              {busy ? m.par_adicionando() : picked.length ? m.par_adicionar_nomes({ nomes: pickedNames.join(', ') }) : m.par_escolha_sessoes()}
            </Text>
          </Pressable>
        </View>
      )}

      <Pressable onPress={onLeave} disabled={busy} style={[styles.danger, { borderColor: theme.tokens.status.error }, busy && styles.disabled]} accessibilityRole="button">
        <Text style={[styles.dangerText, { color: theme.tokens.status.error }]}>{busy ? m.par_saindo() : m.par_sair_grupo()}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.base.space[3] },
  title: { fontSize: theme.base.text.lg, fontWeight: theme.base.weight.bold },
  hint: { fontSize: theme.base.text.sm, lineHeight: 21 },
  list: { gap: theme.base.space[1] },
  memberRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3], paddingHorizontal: theme.base.space[3], paddingVertical: theme.base.space[2], borderRadius: theme.base.radius.md },
  dot: { width: 8, height: 8, borderRadius: theme.base.radius.full, flexShrink: 0 },
  main: { flex: 1, minWidth: 0, gap: theme.base.space[0.5] },
  name: { fontSize: theme.base.text.base, fontWeight: theme.base.weight.semibold },
  state: { fontSize: theme.base.text.xs },
  addingBlock: { gap: theme.base.space[3] },
  secondary: { minHeight: 44, borderWidth: 1, borderStyle: 'dashed', borderRadius: theme.base.radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.base.space[3] },
  secondaryText: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.semibold },
  primary: { minHeight: 50, borderRadius: theme.base.radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.base.space[3] },
  primaryText: { fontSize: theme.base.text.base, fontWeight: theme.base.weight.bold, textAlign: 'center' },
  danger: { minHeight: 50, borderWidth: 1, borderRadius: theme.base.radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.base.space[3] },
  dangerText: { fontSize: theme.base.text.base, fontWeight: theme.base.weight.bold },
  disabled: { opacity: 0.45 },
}));
