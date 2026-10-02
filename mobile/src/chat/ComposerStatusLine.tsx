import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseStatusLine } from '@hangar/core';
import { chatStore } from '../stores/chat';
import { useSessions } from '../stores/sessions';
import { Icon } from '../ui/Icon';
import { ContextRing } from './ContextRing';
import { UsageSheet } from './UsageSheet';
import { composerStatus } from './usage';
import * as m from '../paraglide/messages';

interface Props {
  serverId: string;
  name: string;
}

// Linha de status do app de PC embaixo do composer: pasta, branch e diff, tempo, contexto, cota e
// custo. Ela é a porta da folha de Uso — o anel saiu da linha de botões do composer para cá.
// Mono, pequena e apagada; cor só no que avisa (diff, contexto e cota altos).
export function ComposerStatusLine({ serverId, name }: Props) {
  const { theme } = useUnistyles();
  const chat = chatStore(serverId, name);
  const statusLine = chat.use((s) => s.statusLine);
  const session = useSessions((s) => s.byServerRecord?.[serverId]?.find((x) => x.name === name)
    ?? s.rows.find((x) => x.serverId === serverId && x.name === name) ?? null);
  const status = useMemo(() => composerStatus(parseStatusLine(statusLine, session), session), [statusLine, session]);
  const [usageOpen, setUsageOpen] = useState(false);

  // Mesmos limiares do anel (70 / 90).
  const tone = (pct: number) => (pct >= 90 ? theme.tokens.status.error : pct >= 70 ? theme.tokens.status.warning : theme.tokens.text.muted);
  const muted = theme.tokens.text.muted;
  const items: { key: string; node: ReactNode; spoken: string; shrink?: boolean }[] = [];
  if (status.folder) {
    items.push({ key: 'folder', spoken: status.folder, shrink: true, node: (
      <>
        <Icon name="Folder" size={12} color={muted} />
        <Text style={[styles.text, styles.shrinkText, { color: muted }]} numberOfLines={1}>{status.folder}</Text>
      </>
    ) });
  }
  if (status.branch) {
    const diff = [status.added ? `+${status.added}` : '', status.removed ? `−${status.removed}` : ''].filter(Boolean).join(' ');
    items.push({ key: 'branch', spoken: diff ? `${status.branch} ${diff}` : status.branch, shrink: true, node: (
      <>
        <Icon name="GitBranch" size={12} color={muted} />
        <Text style={[styles.text, styles.shrinkText, { color: muted }]} numberOfLines={1}>{status.branch}</Text>
        {status.added ? <Text style={[styles.text, { color: theme.tokens.status.success }]}>+{status.added}</Text> : null}
        {status.removed ? <Text style={[styles.text, { color: theme.tokens.status.error }]}>−{status.removed}</Text> : null}
      </>
    ) });
  }
  if (status.time) {
    items.push({ key: 'time', spoken: status.time, node: (
      <>
        <View style={[styles.dot, { backgroundColor: theme.tokens.status.success }]} />
        <Text style={[styles.text, { color: muted }]}>{status.time}</Text>
      </>
    ) });
  }
  if (status.ctxPct != null) {
    const pct = Math.round(status.ctxPct);
    items.push({ key: 'ctx', spoken: `${m.ctx_contexto()} ${pct}%`, node: (
      <>
        <ContextRing pct={status.ctxPct} size={12} showValue={false} />
        <Text style={[styles.text, { color: tone(status.ctxPct) }]}>{pct}%</Text>
      </>
    ) });
  }
  if (status.quota) {
    const q = status.quota;
    items.push({ key: 'quota', spoken: `${q.label} ${Math.round(q.pct)}%`, node: (
      <Text style={[styles.text, { color: tone(q.pct) }]}>{q.key} {Math.round(q.pct)}%</Text>
    ) });
  }
  if (status.cost) {
    items.push({ key: 'cost', spoken: status.cost, node: <Text style={[styles.text, { color: muted }]}>{status.cost}</Text> });
  }

  return (
    <>
      {/* Cabe na largura como no PWA: pasta e branch encolhem com reticências, o resto fica inteiro. */}
      <Pressable
        onPress={() => setUsageOpen(true)}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={m.uso_aria()}
        accessibilityValue={items.length ? { text: items.map((i) => i.spoken).join(', ') } : undefined}
      >
        {/* Os itens já vão no valor do botão; lidos de novo por dentro seriam repetição. */}
        <View style={styles.items} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {items.length ? items.map((it) => (
            <View key={it.key} style={[styles.item, it.shrink ? styles.shrinkItem : styles.fixedItem]}>{it.node}</View>
          )) : (
            <View style={styles.item}>
              <Icon name="Gauge" size={12} color={muted} />
              <Text style={[styles.text, { color: muted }]}>{m.uso_titulo()}</Text>
            </View>
          )}
        </View>
      </Pressable>
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} serverId={serverId} name={name} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: theme.base.space[4],
    paddingTop: theme.base.space[1],
    paddingBottom: theme.base.space[1],
  },
  pressed: {
    opacity: 0.6,
  },
  items: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[3],
    minWidth: 0,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  shrinkItem: {
    flexShrink: 1,
    minWidth: 0,
  },
  fixedItem: {
    flexShrink: 0,
  },
  shrinkText: {
    flexShrink: 1,
  },
  text: {
    fontFamily: theme.base.fontMono,
    fontSize: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
}));
