import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Circle } from 'react-native-svg';
import type { Task } from '@hangar/core';
import { Icon } from '../ui/Icon';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';

const R = 6;
const CIRC = 2 * Math.PI * R;

// Lista de tarefas do agente no lugar das chamadas TaskCreate/TaskUpdate (render_tasks do Rust):
// anel de progresso, quanto falta e os passos. O passo em andamento mostra o que o agente diz que
// está fazendo; tocar num passo com descrição abre o texto dele. A lista vem pronta do `foldTasks`.
export const TaskList = memo(function TaskList({ tasks }: { tasks: Task[] }) {
  const { theme } = useUnistyles();
  const [minimizada, setMinimizada] = useState(false);
  const [abertas, setAbertas] = useState<Record<string, boolean>>({});
  const feitas = tasks.filter((t) => t.status === 'completed').length;
  const faltam = tasks.length - feitas;
  const rotulo = faltam === 0 ? m.native_tasks_all_done() : faltam === 1 ? m.native_tasks_left_1() : m.native_tasks_left({ n: faltam });
  const cor = faltam === 0 ? theme.tokens.status.success : theme.tokens.accent.base;
  return (
    <View style={[styles.box, { borderColor: theme.tokens.border.subtle, backgroundColor: superficie(theme, 0.8) }]}>
      <View style={styles.head}>
        <Svg width={16} height={16} viewBox="0 0 16 16" accessibilityLabel={`${feitas}/${tasks.length}`}>
          <Circle cx={8} cy={8} r={R} fill="none" stroke={theme.tokens.border.default} strokeWidth={2.5} />
          <Circle
            cx={8}
            cy={8}
            r={R}
            fill="none"
            stroke={cor}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - feitas / Math.max(1, tasks.length))}
            transform="rotate(-90 8 8)"
          />
        </Svg>
        <Text style={[styles.rotulo, { color: theme.tokens.text.primary }]} numberOfLines={1}>{rotulo}</Text>
        <Pressable
          onPress={() => setMinimizada((v) => !v)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={minimizada ? m.native_tasks_expand() : m.native_tasks_minimize()}
          accessibilityState={{ expanded: !minimizada }}
          style={({ pressed }) => [styles.min, pressed && { backgroundColor: theme.tokens.bg.hover }]}
        >
          <Icon name={minimizada ? 'ChevronDown' : 'Minus'} size={14} color={theme.tokens.text.secondary} />
        </Pressable>
      </View>
      {!minimizada ? (
        <View style={styles.passos}>
          {tasks.map((t, i) => {
            // Identidade pela chave da tarefa, nunca só pela posição: uma que sai não passa o estado aberto para a vizinha.
            const k = t.id || `novo-${i}`;
            const ativa = t.status === 'in_progress';
            const titulo = t.subject || m.native_tasks_untitled();
            const mostrado = ativa && t.activeForm ? t.activeForm : titulo;
            const estado = t.status === 'completed' ? m.native_tasks_completed() : ativa ? m.native_tasks_in_progress() : m.native_tasks_pending();
            const aberta = !!abertas[k] && !!t.description;
            return (
              <View key={k}>
                <Pressable
                  onPress={t.description ? () => setAbertas((a) => ({ ...a, [k]: !a[k] })) : undefined}
                  accessibilityRole={t.description ? 'button' : undefined}
                  accessibilityLabel={`${titulo}: ${estado}`}
                  accessibilityState={t.description ? { expanded: aberta } : undefined}
                  style={({ pressed }) => [
                    styles.passo,
                    ativa && { backgroundColor: theme.tokens.accent.dim },
                    pressed && !!t.description && { backgroundColor: theme.tokens.bg.hover },
                  ]}
                >
                  <Icon
                    name={t.status === 'completed' ? 'CircleCheck' : ativa ? 'LoaderCircle' : 'CircleDashed'}
                    size={14}
                    color={t.status === 'completed' ? theme.tokens.status.success : ativa ? theme.tokens.accent.base : theme.tokens.text.muted}
                  />
                  <Text
                    style={[
                      styles.titulo,
                      { color: t.status === 'completed' ? theme.tokens.text.secondary : ativa ? theme.tokens.accent.base : theme.tokens.text.primary },
                    ]}
                    numberOfLines={1}
                  >
                    {mostrado}
                  </Text>
                </Pressable>
                {aberta ? <Text style={[styles.descricao, { color: theme.tokens.text.secondary }]}>{t.description}</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  box: {
    alignSelf: 'stretch',
    maxWidth: 380,
    marginVertical: 6,
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rotulo: { flex: 1, minWidth: 0, fontSize: theme.base.text.sm, fontWeight: '500' },
  min: { width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  passos: { gap: 2 },
  passo: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingHorizontal: 6, borderRadius: 6 },
  titulo: { flex: 1, minWidth: 0, fontSize: theme.base.text.sm },
  descricao: { paddingLeft: 28, paddingRight: 6, paddingBottom: 4, fontSize: theme.base.text.xs, lineHeight: 18 },
}));
