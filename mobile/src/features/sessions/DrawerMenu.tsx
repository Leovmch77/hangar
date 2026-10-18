import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listClaudeConfigsForServer, probeServerResponse, rotuloEstado, type AggSession, type CotaContaResumo } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { Icon, type IconName } from '../../ui/Icon';
import { WorkingMark } from '../../ui/WorkingMark';
import { useSessions } from '../../stores/sessions';
import { useServers } from '../../stores/servers';
import { useLiveVoice } from '../voice/liveVoiceStore';
import { accountQuotaLine, recentSessions } from './drawerMenu';
import { HeadlessSignal } from './HeadlessSignal';

const RECENT = 5;
const NO_ROWS: AggSession[] = [];

// Menu da gaveta no padrão dos apps de chat: destinos, recentes só pelo nome e a ação principal
// flutuando embaixo. A lista completa de sessões mora no Início. `onClose` roda antes de navegar.
export function DrawerMenu({ open, onClose, onOpenServers }: { open: boolean; onClose: () => void; onOpenServers: () => void }) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Fechada, a gaveta continua montada: sem assinar a lista, troca de estado das sessões não a redesenha.
  const rows = useSessions((s) => (open ? s.rows : NO_ROWS));
  const recent = useMemo(() => recentSessions(rows, RECENT), [rows]);
  const server = useServers((s) => s.servers.find((x) => x.id === s.activeId));
  const activeId = server?.id;
  const voiceOk = !!server && !server.invite && !server.inviteEnded && !server.removed;
  const quota = useAccountQuota(server?.invite ? undefined : server, open);

  const go = (path: string) => { onClose(); router.push(path as never); };
  const ink = theme.tokens.text.primary;
  const item = (icon: IconName, label: string, onPress: () => void, hint?: string) => (
    <Pressable key={label} onPress={onPress} accessibilityRole="button" accessibilityLabel={hint ? `${label}, ${hint}` : label}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
      <Icon name={icon} size={20} color={ink} />
      <Text style={styles.itemText} numberOfLines={1}>{label}</Text>
      {hint ? <Text style={styles.hint} numberOfLines={1}>{hint}</Text> : null}
    </Pressable>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.head}>
        <Text style={styles.brand} accessibilityRole="header" numberOfLines={1}>{m.native_brand()}</Text>
        <Pressable onPress={() => go('/search')} style={styles.circle} hitSlop={4}
          accessibilityRole="button" accessibilityLabel={m.switcher_buscar_conversas()}>
          <Icon name="Search" size={19} color={ink} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 96 }} showsVerticalScrollIndicator={false}>
        {item('House', m.menu_inicio(), onClose)}
        {item('ChartNoAxesCombined', m.nav_custos(), () => go('/costs'))}
        {voiceOk && activeId ? item('AudioLines', m.voz_titulo(), () => { onClose(); useLiveVoice.getState().openFor(activeId, ''); }) : null}
        {item('Server', m.maquinas_titulo(), () => { onClose(); onOpenServers(); })}
        {item('CircleUser', m.contas_titulo(), () => go('/config/contas'), quota || undefined)}
        {item('GitBranch', m.worktrees_titulo(), () => go('/config/worktrees'))}
        {recent.length ? <Text style={styles.section} accessibilityRole="header">{m.conversas_recentes()}</Text> : null}
        {recent.map((s) => <RecentRow key={`${s.serverId}:${s.name}`} session={s} onPress={() => go(`/s/${s.serverId}/${s.name}`)} />)}
        <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
          <Text style={styles.more}>{m.native_sidebar_all_sessions()}</Text>
        </Pressable>
      </ScrollView>
      <View style={[styles.bottom, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
        <Pressable onPress={() => go('/create')} accessibilityRole="button" accessibilityLabel={m.sessao_nova()}
          style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}>
          <Icon name="Plus" size={18} color={theme.tokens.bg.base} />
          <Text style={styles.pillText}>{m.sessao_nova()}</Text>
        </Pressable>
        <Pressable onPress={() => go('/config')} style={styles.circle} hitSlop={4}
          accessibilityRole="button" accessibilityLabel={m.config_modal_titulo()}>
          <Icon name="Settings" size={20} color={ink} />
        </Pressable>
      </View>
    </View>
  );
}

function RecentRow({ session, onPress }: { session: AggSession; onPress: () => void }) {
  const { theme } = useUnistyles();
  const waiting = session.state === 'awaiting_input';
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${session.name}${session.headless === true ? `, ${m.criar_modo_exec_headless()}` : ''}, ${rotuloEstado(session.state)}`}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
      {session.state === 'working'
        ? <WorkingMark size={20} color={theme.tokens.accent.base} />
        : <Icon name="MessageCircle" size={20} color={theme.tokens.text.secondary} />}
      <Text style={styles.itemText} numberOfLines={1}>{session.name}</Text>
      {session.headless === true ? <HeadlessSignal /> : null}
      {waiting ? <View style={[styles.dot, { backgroundColor: theme.tokens.status.warning }]} /> : null}
    </Pressable>
  );
}

// A cota é só uma dica na linha: sem leitura, a linha fica sem ela e a tela de Contas mostra o motivo.
// Relida a cada abertura: a gaveta fica montada e o número de horas atrás pareceria atual.
function useAccountQuota(server: Parameters<typeof listClaudeConfigsForServer>[0] | undefined, open: boolean): string {
  const [line, setLine] = useState('');
  useEffect(() => {
    if (!open) return;
    if (!server) { setLine(''); return; }
    let alive = true;
    const cotas = probeServerResponse(server, '/api/cotas')
      .then((r) => (r.ok ? r.json() as Promise<CotaContaResumo[]> : []))
      .catch(() => [] as CotaContaResumo[]);
    void Promise.all([listClaudeConfigsForServer(server), cotas])
      .then(([configs, cs]) => { if (alive) setLine(accountQuotaLine(configs, cs)); })
      .catch(() => { if (alive) setLine(''); });
    return () => { alive = false; };
  }, [server, open]);
  return line;
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingLeft: 20, paddingRight: 14, paddingVertical: 10 },
  brand: { flex: 1, fontSize: theme.base.text.xl, fontWeight: '700', color: theme.tokens.text.primary },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.tokens.bg.hover },
  item: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20 },
  pressed: { backgroundColor: theme.tokens.bg.hover },
  itemText: { flexShrink: 1, fontSize: theme.base.text.base, color: theme.tokens.text.primary },
  hint: { flex: 1, textAlign: 'right', fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
  section: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 },
  more: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: 'auto' },
  bottom: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, borderRadius: 22, backgroundColor: theme.tokens.text.primary, boxShadow: '0px 6px 20px rgba(0,0,0,0.35)' },
  pillPressed: { opacity: 0.85 },
  pillText: { fontSize: theme.base.text.base, fontWeight: '600', color: theme.tokens.bg.base },
}));
