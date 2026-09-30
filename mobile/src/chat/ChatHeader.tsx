import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams } from 'expo-router';
import { cwdParts, type State } from '@hangar/core';
import * as m from '../paraglide/messages';
import { StatePill } from '../features/sessions/StatePill';
import { ContextRing } from './ContextRing';
import { Icon } from '../ui/Icon';
import { useSessions } from '../stores/sessions';
import { useServers } from '../stores/servers';

// Cabeçalho do chat, na ordem da PWA no celular: voltar · título+chevron · anel · pílula de
// estado · terminal · ⋯. O título é o que cede espaço primeiro, então o chip do plano fica na
// linha de baixo — na mesma linha ele espremia o nome da sessão até as reticências.
export function ChatHeader({
  name,
  state,
  onBack,
  onMore,
  onTitlePress,
  onTerminal,
  contextPct,
  chipLoop,
  chipPlan,
}: {
  name: string;
  state: State | null;
  onBack: () => void;
  onMore: () => void;
  onTitlePress: () => void;
  onTerminal?: () => void;
  contextPct?: number | null;
  chipLoop?: React.ReactNode;
  chipPlan?: React.ReactNode;
}) {
  const { theme } = useUnistyles();
  // Destino lido da rota e da lista: quem monta o cabeçalho não precisa repassar máquina e pasta.
  const params = useLocalSearchParams<{ server?: string | string[] }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : params.server;
  const row = useSessions((s) => s.rows.find((r) => r.serverId === serverId && r.name === name) ?? null);
  const serverLabel = useServers((s) => s.servers.find((x) => x.id === serverId)?.label) ?? row?.serverLabel ?? '';
  const pasta = row?.cwd ? cwdParts(row.cwd).base : '';
  const destino = [serverLabel, pasta].filter(Boolean).join(' · ');
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel={m.chat_voltar_sessoes()}
        >
          <Icon name="ChevronLeft" size={24} color={theme.tokens.accent.base} />
        </Pressable>
        <Pressable
          onPress={onTitlePress}
          style={({ pressed }) => [styles.titulo, pressed && styles.tocado]}
          accessibilityRole="button"
          // Nome e destino completos para o leitor de tela; a ação vai na dica.
          accessibilityLabel={[name, serverLabel, row?.cwd].filter(Boolean).join(', ')}
          accessibilityHint={m.sessao_trocar_de()}
        >
          <View style={styles.nomeLinha}>
            <Text style={[styles.name, { color: theme.tokens.text.primary }]} numberOfLines={1}>
              {name}
            </Text>
            <Icon name="ChevronDown" size={14} color={theme.tokens.text.muted} />
          </View>
          {destino ? (
            <Text style={[styles.destino, { color: theme.tokens.text.secondary }]} numberOfLines={1}>
              {destino}
            </Text>
          ) : null}
        </Pressable>
        <ContextRing pct={contextPct} />
        {state ? <StatePill state={state} /> : null}
        {onTerminal ? (
          <Pressable
            onPress={onTerminal}
            hitSlop={8}
            style={styles.more}
            accessibilityRole="button"
            accessibilityLabel={m.term_titulo()}
          >
            <Icon name="Terminal" size={20} color={theme.tokens.text.primary} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={onMore}
          hitSlop={8}
          style={styles.more}
          accessibilityRole="button"
          accessibilityLabel={m.navbar_mais_acoes()}
        >
          <Icon name="Ellipsis" size={20} color={theme.tokens.text.primary} />
        </Pressable>
      </View>
      {chipPlan || chipLoop ? (
        <View style={styles.chips}>
          {chipPlan}
          {chipLoop}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    borderBottomWidth: 1,
    borderBottomColor: theme.tokens.border.subtle,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    paddingHorizontal: theme.base.space[2],
    paddingVertical: theme.base.space[1],
    minHeight: 44,
  },
  chips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    paddingHorizontal: theme.base.space[2],
    paddingBottom: theme.base.space[1],
  },
  titulo: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: theme.base.radius.md,
  },
  nomeLinha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  destino: {
    fontSize: theme.base.text.xs,
  },
  tocado: {
    backgroundColor: theme.tokens.bg.hover,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: theme.base.text.base,
    fontWeight: '600',
    flexShrink: 1,
  },
  more: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
