// Painel "Na fila" acima do composer: o que espera a vez no Hangar. Toque longo na linha abre o menu
// (Subir, Descer, Orientar, Editar, Apagar), como o T3 mobile; tocar no texto mostra a mensagem inteira.
import { useState } from 'react';
import { ActionSheetIOS, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { MenuView, type NativeActionEvent } from '@react-native-menu/menu';
import * as Haptics from 'expo-haptics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { QueuePanel as Panel } from '@hangar/core';
import * as m from '../paraglide/messages';
import { Icon } from '../ui/Icon';
import { Glass } from '../ui/Glass';

type MenuId = 'up' | 'down' | 'steer' | 'edit' | 'remove';
interface MenuAction { id: MenuId; title: string; disabled: boolean; destructive?: boolean }

// A linha em edição já está no composer: reabrir, orientar ou apagar por ela jogaria fora o que foi digitado.
function menuActions({ index, count, busy, steerable, editing = false }: {
  index: number; count: number; busy: boolean; steerable: boolean; editing?: boolean;
}): MenuAction[] {
  return [
    { id: 'up', title: m.queue_panel_move_up(), disabled: busy || index === 0 },
    { id: 'down', title: m.queue_panel_move_down(), disabled: busy || index === count - 1 },
    { id: 'steer', title: m.codex_orientar(), disabled: busy || !steerable || editing },
    { id: 'edit', title: m.atalhos_editar(), disabled: busy || editing },
    { id: 'remove', title: m.comum_apagar(), disabled: busy || editing, destructive: true },
  ];
}

// O iOS já vibra ao abrir o menu de contexto; o PopupMenu do Android não.
const vibrateOnOpen =
  Platform.OS === 'android' ? () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}) : undefined;

interface Props {
  panel: Panel;
  editingId: string | null;
  busy: boolean;
  steerable: boolean;
  onEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}

export function QueuePanel({ panel, editingId, busy, steerable, onEdit, onCancelEdit, onSteer, onRemove, onMove }: Props) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(true);
  const [full, setFull] = useState<string | null>(null);
  if (panel.entries.length === 0) return null;
  const pick = (id: string, action: MenuId) => {
    void Haptics.selectionAsync().catch(() => {});
    if (action === 'up') onMove(id, -1);
    else if (action === 'down') onMove(id, 1);
    else if (action === 'steer') onSteer(id);
    else if (action === 'edit') onEdit(id);
    else onRemove(id);
  };
  const muted = theme.tokens.text.muted;
  return (
    <Glass variant="chrome" style={styles.box}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? m.queue_panel_collapse() : m.queue_panel_expand()}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        hitSlop={4}
        style={styles.header}
      >
        <Icon name="ListOrdered" size={14} color={muted} />
        <Text style={styles.title}>{m.queue_panel_title()}</Text>
        <Text style={styles.count}>{panel.entries.length}</Text>
        <Icon name={expanded ? 'ChevronDown' : 'ChevronUp'} size={14} color={muted} />
      </Pressable>
      {expanded ? (
        <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {panel.entries.map((entry, index) => {
            const editing = editingId === entry.id;
            const actions = menuActions({ index, count: panel.entries.length, busy, steerable, editing });
            const enabled = actions.filter((a) => !a.disabled);
            const openIOS = () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              const destructive = enabled.findIndex((a) => a.destructive);
              ActionSheetIOS.showActionSheetWithOptions(
                {
                  title: entry.text.slice(0, 80),
                  options: [...enabled.map((a) => a.title), m.comum_cancelar()],
                  cancelButtonIndex: enabled.length,
                  destructiveButtonIndex: destructive >= 0 ? destructive : undefined,
                },
                (i) => { if (i < enabled.length) pick(entry.id, enabled[i].id); },
              );
            };
            const row = (
              <Pressable
                onPress={() => setFull(full === entry.id ? null : entry.id)}
                // No Android o toque longo é do MenuView; o no-op impede que soltar o dedo vire toque.
                onLongPress={!panel.actions ? undefined : Platform.OS === 'ios' ? openIOS : () => {}}
                delayLongPress={350}
                accessibilityLabel={entry.text}
                accessibilityHint={panel.actions ? m.queue_panel_actions() : undefined}
                // O menu mora no toque longo, que o leitor de tela não alcança: as ações viram ações da linha.
                accessibilityActions={panel.actions ? enabled.map((a) => ({ name: a.id, label: a.title })) : undefined}
                onAccessibilityAction={({ nativeEvent }) => {
                  if (enabled.some((a) => a.id === nativeEvent.actionName)) pick(entry.id, nativeEvent.actionName as MenuId);
                }}
                style={[styles.row, editing && { backgroundColor: theme.tokens.accent.dim }]}
              >
                <Text style={styles.text} numberOfLines={full === entry.id ? undefined : 1}>{entry.text}</Text>
                {editing ? (
                  <Pressable accessibilityRole="button" onPress={onCancelEdit} disabled={busy} hitSlop={8} style={styles.cancelBtn}>
                    <Text style={[styles.cancel, busy && styles.disabled]}>{m.comum_cancelar()}</Text>
                  </Pressable>
                ) : null}
                {panel.actions && !editing ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={m.codex_orientar()}
                      accessibilityHint={steerable ? m.codex_orientar_ajuda() : m.queue_panel_steer_unavailable()}
                      accessibilityState={{ disabled: busy || !steerable }}
                      disabled={busy || !steerable}
                      onPress={() => pick(entry.id, 'steer')}
                      hitSlop={6}
                      style={[styles.iconBtn, (busy || !steerable) && styles.disabled]}
                    >
                      <Icon name="CornerUpRight" size={16} color={theme.tokens.accent.base} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={m.queue_panel_remove()}
                      accessibilityState={{ disabled: busy }}
                      disabled={busy}
                      onPress={() => pick(entry.id, 'remove')}
                      hitSlop={6}
                      style={[styles.iconBtn, busy && styles.disabled]}
                    >
                      <Icon name="X" size={16} color={muted} />
                    </Pressable>
                  </>
                ) : null}
              </Pressable>
            );
            if (!panel.actions || Platform.OS === 'ios') return <View key={entry.id}>{row}</View>;
            return (
              <MenuView
                key={entry.id}
                shouldOpenOnLongPress
                title={m.queue_panel_actions()}
                actions={actions.map((a) => ({ id: a.id, title: a.title, attributes: { disabled: a.disabled, destructive: !!a.destructive } }))}
                onPressAction={({ nativeEvent }: NativeActionEvent) => {
                  const action = actions.find((a) => a.id === nativeEvent.event);
                  if (action && !action.disabled) pick(entry.id, action.id);
                }}
                onOpenMenu={vibrateOnOpen}
              >
                {row}
              </MenuView>
            );
          })}
        </ScrollView>
      ) : null}
    </Glass>
  );
}
QueuePanel.menuActions = menuActions;

const ROW_HEIGHT = 40;

const styles = StyleSheet.create((theme) => ({
  // Aba colada no topo da caixa do composer, um pouco mais estreita que ela, como no T3.
  box: {
    marginHorizontal: theme.base.space[2] + 18,
    marginBottom: -1,
    borderRadius: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomWidth: 0,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 36 },
  title: { fontSize: theme.base.text.xs, fontWeight: '600', color: theme.tokens.text.muted },
  count: { marginLeft: 'auto', fontSize: theme.base.text.xs, color: theme.tokens.text.muted, fontVariant: ['tabular-nums'] },
  // Cerca de quatro linhas; passou disso, a lista rola dentro do painel.
  list: { maxHeight: 4 * ROW_HEIGHT + 6, paddingHorizontal: 6, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: ROW_HEIGHT, paddingLeft: 8, borderRadius: 10 },
  text: { flex: 1, fontSize: theme.base.text.xs, color: theme.tokens.text.primary, paddingVertical: 6 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  cancelBtn: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 8 },
  cancel: { fontSize: theme.base.text.xs, fontWeight: '600', color: theme.tokens.accent.base },
  disabled: { opacity: 0.4 },
}));
