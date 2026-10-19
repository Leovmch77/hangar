import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/shallow';
import { linkedChildren, linkedChildrenDone, providerName, rotuloEstado, rotuloModelo } from '@hangar/core';
import { useSessions } from '../stores/sessions';
import { Icon } from '../ui/Icon';
import { StateDot } from '../ui/StateDot';
import { haptic } from '../ui/haptics';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';

// Linha das sessões filhas ligadas a esta, na mesma faixa do CI; lida da lista que o chat já mantém aberta.
export const LinkedChildren = memo(function LinkedChildren({ serverId, name }: { serverId: string; name: string }) {
  const { theme } = useUnistyles();
  const router = useRouter();
  // Linha que não mudou mantém o objeto: a comparação rasa só redesenha quando uma filha muda.
  const children = useSessions(useShallow(s => linkedChildren(s.rows, { serverId, name })));
  const [open, setOpen] = useState(false);
  if (children.length === 0) return null;
  const done = linkedChildrenDone(children);
  const toggle = () => { haptic.selection(); setOpen(v => !v); };
  return <View style={styles.wrap}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityHint={m.linked_children_toggle()}
      onPress={toggle} style={styles.head}>
      <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={14} color={theme.tokens.text.muted} />
      <Icon name="GitBranch" size={14} color={theme.tokens.text.secondary} />
      <Text style={styles.count}>{children.length === 1 ? m.linked_children_count_one() : m.linked_children_count({ count: children.length })}</Text>
      <View style={styles.chips}>
        {children.map(child => <Text key={child.name} style={styles.chip} numberOfLines={1}>{child.name}</Text>)}
      </View>
      <View style={styles.dots}>
        {children.map(child => <StateDot key={child.name} state={child.state} size={7} />)}
      </View>
      <Text style={[styles.meta, { flexShrink: 0 }]}>{m.linked_children_done({ done, total: children.length })}</Text>
    </Pressable>
    {open ? children.map(child => {
      const last = child.last_reply?.trim().split('\n')[0];
      return <View key={child.name} style={styles.row}>
        <StateDot state={child.state} size={7} />
        <View style={styles.main}>
          <Text style={styles.name} numberOfLines={1}>{child.name}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[providerName(child.provider), child.model ? rotuloModelo(child.model) : null, rotuloEstado(child.state)].filter(Boolean).join(' · ')}
          </Text>
          {last ? <Text style={styles.last} numberOfLines={1}>{last}</Text> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={m.par_abrir_conversa_de({ nome: child.name })} style={styles.open}
          onPress={() => router.push(`/s/${serverId}/${encodeURIComponent(child.name)}` as never)}>
          <Text style={styles.openText}>{m.linked_children_open()}</Text>
        </Pressable>
      </View>;
    }) : null}
  </View>;
});

const styles = StyleSheet.create(theme => ({
  wrap: { marginHorizontal: theme.base.space[3], borderColor: theme.tokens.border.subtle, borderWidth: 1, borderRadius: theme.base.radius.sm, overflow: 'hidden' },
  head: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: theme.base.space[1.5], paddingHorizontal: theme.base.space[2] },
  count: { ...theme.type.label, color: theme.tokens.text.primary, flexShrink: 0 },
  chips: { flex: 1, flexDirection: 'row', gap: theme.base.space[1], overflow: 'hidden', minWidth: 0 },
  chip: { ...theme.type.caption, flexShrink: 1, color: theme.tokens.text.secondary, backgroundColor: superficie(theme, 0.8),
    borderRadius: theme.base.radius.xs, paddingHorizontal: theme.base.space[1.5], overflow: 'hidden' },
  dots: { flexDirection: 'row', gap: theme.base.space[0.5], flexShrink: 0 },
  meta: { ...theme.type.meta, color: theme.tokens.text.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingLeft: theme.base.space[2],
    borderTopColor: theme.tokens.border.subtle, borderTopWidth: 1 },
  main: { flex: 1, minWidth: 0, paddingVertical: theme.base.space[1.5] },
  name: { ...theme.type.label, color: theme.tokens.text.primary },
  last: { ...theme.type.mono, color: theme.tokens.text.secondary },
  open: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[2] },
  openText: { ...theme.type.control, color: theme.tokens.accent.base },
}));
