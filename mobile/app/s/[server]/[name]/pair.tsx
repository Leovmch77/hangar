import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { fetchSessionsForServer, formataErro, getHistory, getPairContract, listExternalPairs, pairExternals, pairHeaderLabel, pairSession, setPairAccess, unpairSession } from '@hangar/core';
import type { ChatEvent, ExternalPair } from '@hangar/core';
import { useServers } from '../../../../src/stores/servers';
import { markLeavingPair, useSessions } from '../../../../src/stores/sessions';
import { mkMarkdownStyle } from '../../../../src/chat/AssistantBubble';
import { PairMembers } from '../../../../src/features/pair/PairMembers';
import { PairPicker } from '../../../../src/features/pair/PairPicker';
import { PairFeed } from '../../../../src/features/pair/PairFeed';
import { montarFeed } from '../../../../src/features/pair/pairFeed';
import { fullPairs, outsideRow } from '../../../../src/features/pair/groupPairs';
import * as m from '../../../../src/paraglide/messages';
import { superficie } from '../../../../src/theme/superficie';

export default function PairSheet() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : (params.server ?? '');
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? '');
  const ready = useServers((state) => state.ready);
  const routeServer = useServers((state) => state.servers.find((server) => server.id === serverId) ?? null);
  const current = useSessions((state) => state.rows.find((row) => row.serverId === serverId && row.name === name) ?? null);
  const peers = current?.pair_peers ?? [];
  const peersKey = peers.join('\u0000');
  const allRows = useSessions((state) => state.rows);
  const groupRows = useMemo(
    () => allRows.filter((row) => row.serverId === serverId && (row.name === name || peers.includes(row.name))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, serverId, name, peersKey],
  );
  const header = pairHeaderLabel(name, groupRows);
  const comFora = groupRows.some((row) => pairExternals(row).length > 0);
  // Pares cuja ponta é esta sessão: sair do grupo os desfaz para todos.
  const [anchored, setAnchored] = useState<ExternalPair[]>([]);
  const anchorOwner = anchored[0]?.owner ?? null;

  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof fetchSessionsForServer>>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [routeMissing, setRouteMissing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [feed, setFeed] = useState<ReturnType<typeof montarFeed>['feed']>([]);
  const [feedFailed, setFeedFailed] = useState<string[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [contract, setContract] = useState<{ path: string; content: string } | null>(null);
  const [contractError, setContractError] = useState('');
  const [contractLoading, setContractLoading] = useState(false);
  const epoch = useRef(0);
  // A ação só perde a validade com rota nova ou desmontagem; pair_peers mudando recarrega a tela, não cancela o POST.
  const actionEpoch = useRef(0);
  const mdStyle = useMemo(() => mkMarkdownStyle(theme), [theme]);

  useEffect(() => {
    setAnchored([]);
    if (!routeServer || !comFora) return;
    let alive = true;
    listExternalPairs(routeServer)
      .then((pairs) => { if (alive) setAnchored(pairs.filter((p) => p.local_session === name)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [routeServer, name, comFora]);

  useEffect(() => {
    setActionError('');
    setBusy(false);
    return () => {
      actionEpoch.current += 1;
    };
  }, [serverId, name]);

  useEffect(() => {
    if (!ready) return;
    const currentEpoch = ++epoch.current;
    setLoading(true);
    setSessions([]);
    setLoadError('');
    setPicked([]);
    setTask('');
    setAdding(false);
    setFeed([]);
    setFeedFailed([]);
    setFeedLoading(peers.length > 0);
    setContractLoading(peers.length > 0);
    setContract(null);
    setContractError('');

    if (!routeServer) {
      setRouteMissing(true);
      setLoading(false);
      setFeedLoading(false);
      setContractLoading(false);
      return;
    }
    setRouteMissing(false);

    const server = routeServer;
    const controller = new AbortController();
    void (async () => {
      try {
        const all = await fetchSessionsForServer(server);
        if (currentEpoch !== epoch.current) return;
        setSessions(all.filter((session) => session.name !== name && session.state !== 'dead'));
      } catch {
        if (currentEpoch === epoch.current) setLoadError(m.forward_nao_listou());
      } finally {
        if (currentEpoch === epoch.current) setLoading(false);
      }
    })();

    if (peers.length) {
      const members = [name, ...peers];
      void (async () => {
        const results = await Promise.all(
          members.map((member) =>
            getHistory(member, undefined, controller.signal, 45_000, server)
              .then((history) => ({ ok: true, h: history }))
              .catch(() => ({ ok: false, h: [] as ChatEvent[] })),
          ),
        );
        if (currentEpoch !== epoch.current) return;
        const built = montarFeed(members, results);
        setFeed(built.feed);
        setFeedFailed(built.failed);
        setFeedLoading(false);
      })();

      void (async () => {
        try {
          const shared = await getPairContract(name, server);
          if (currentEpoch === epoch.current) setContract({ path: shared.path, content: shared.content });
        } catch {
          if (currentEpoch === epoch.current) setContractError(m.par_contrato_falhou());
        } finally {
          if (currentEpoch === epoch.current) setContractLoading(false);
        }
      })();
    }

    return () => {
      controller.abort();
      if (epoch.current === currentEpoch) epoch.current += 1;
    };
    // peersKey é a chave primitiva: o store cria um array novo a cada poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, routeServer, name, peersKey]);

  const candidates = sessions.filter((session) => !peers.includes(session.name));

  function togglePick(peer: string) {
    setPicked((currentPicked) => currentPicked.includes(peer) ? currentPicked.filter((item) => item !== peer) : [...currentPicked, peer]);
  }

  // Grupo com par de acesso completo: quem entra fica aberto para o dono só se a pessoa disser.
  function confirmPair() {
    const full = fullPairs(groupRows);
    if (!full.length) { void doPair(false); return; }
    const token = actionEpoch.current;
    const go = (release: boolean) => { if (token === actionEpoch.current) void doPair(release); };
    Alert.alert(
      m.pair_level_title(),
      full.map((p) => m.pair_full_confirm({ sessao: picked.join(', '), dono: p.owner })).join('\n\n'),
      [
        { text: m.comum_cancelar(), style: 'cancel' },
        { text: m.pair_level_view(), onPress: () => go(false) },
        { text: m.pair_level_full(), onPress: () => go(true) },
      ],
    );
  }

  async function doPair(release: boolean) {
    if (!picked.length || busy || loading || !routeServer) return;
    const selected = picked;
    const full = release ? fullPairs(groupRows) : [];
    const token = actionEpoch.current;
    const server = routeServer;
    setBusy(true);
    setActionError('');
    try {
      const result = await pairSession(name, selected, task.trim(), false, server);
      if (token !== actionEpoch.current) return;
      if (result.warning) {
        setActionError(formataErro(result.warning) ?? String(result.warning));
        return;
      }
      try {
        for (const peer of selected) for (const p of full) await setPairAccess(peer, p.alias, 'full', server);
      } catch (e) {
        if (token === actionEpoch.current) setActionError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (token === actionEpoch.current) router.back();
    } catch {
      if (token === actionEpoch.current) setActionError(m.par_falhou_pareamento({ nomes: selected.join(', ') }));
    } finally {
      if (token === actionEpoch.current) setBusy(false);
    }
  }

  async function doLeave() {
    if (busy || !routeServer) return;
    const token = actionEpoch.current;
    const server = routeServer;
    setBusy(true);
    setActionError('');
    // O sumiço dos pares desta ponta não é a outra pessoa saindo.
    const undo = anchored.map((p) => markLeavingPair(p.alias, p.session));
    try {
      const result = await unpairSession(name, server);
      if (token !== actionEpoch.current) return;
      if (result.warning) {
        setActionError(formataErro(result.warning) ?? String(result.warning));
      } else {
        router.back();
      }
    } catch {
      for (const u of undo) u();
      if (token === actionEpoch.current) setActionError(m.par_falhou_saida());
    } finally {
      if (token === actionEpoch.current) setBusy(false);
    }
  }

  function confirmLeave() {
    const token = actionEpoch.current;
    Alert.alert(
      m.comandos_confirmar({ n: m.par_sair_grupo() }),
      anchorOwner ? m.pair_undo_anchor_body({ dono: anchorOwner }) : undefined,
      [
        { text: m.comum_cancelar(), style: 'cancel' },
        { text: m.comum_confirmar(), style: 'destructive', onPress: () => { if (token === actionEpoch.current) void doLeave(); } },
      ],
    );
  }

  function openPeer(peer: string) {
    const fora = outsideRow(allRows, peer);
    if (fora) { router.push(`/s/${fora.serverId}/${encodeURIComponent(fora.name)}` as never); return; }
    router.push(`/s/${serverId}/${encodeURIComponent(peer)}` as never);
  }

  if (!ready) {
    return (
      <>
        <Stack.Screen options={sheetOptions} />
        <View style={[styles.center, { backgroundColor: theme.tokens.bg.base }]}>
          <ActivityIndicator color={theme.tokens.text.muted} />
          <Text style={[styles.muted, { color: theme.tokens.text.muted }]}>{m.comum_carregando()}</Text>
        </View>
      </>
    );
  }

  if (routeMissing || !routeServer) {
    return (
      <>
        <Stack.Screen options={sheetOptions} />
        <View style={[styles.center, { backgroundColor: theme.tokens.bg.base }]}>
          <Text style={[styles.error, { color: theme.tokens.status.error }]} accessibilityRole="alert">{m.compare_servidor_nao_encontrado()}</Text>
          <Pressable onPress={() => router.back()} accessibilityRole="button">
            <Text style={[styles.back, { color: theme.tokens.accent.base }]}>{m.comum_voltar()}</Text>
          </Pressable>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={sheetOptions} />
      <KeyboardAvoidingView behavior="padding" style={[styles.root, { backgroundColor: theme.tokens.bg.base }]}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
        >
          {comFora ? (
            <View style={styles.fora}>
              <Text style={[styles.sectionTitle, { color: theme.tokens.text.primary }]} accessibilityRole="header">{header}</Text>
              <Text style={[styles.path, { color: theme.tokens.text.muted }]}>{m.pair_not_transitive()}</Text>
            </View>
          ) : null}
          {actionError ? <Text style={[styles.actionError, { color: theme.tokens.status.error }]} accessibilityRole="alert" selectable>{actionError}</Text> : null}
          {peers.length && loadError ? <Text style={[styles.actionError, { color: theme.tokens.status.error }]} accessibilityRole="alert" selectable>{loadError}</Text> : null}
          {peers.length ? (
            <>
              {loading ? <Text style={[styles.muted, { color: theme.tokens.text.muted }]}>{m.comum_carregando()}</Text> : <PairMembers
                peers={peers}
                sessions={sessions}
                candidates={candidates}
                picked={picked}
                adding={adding}
                busy={busy}
                onOpenPeer={openPeer}
                onToggleAdding={() => { setAdding(true); setPicked([]); }}
                onToggle={togglePick}
                onAdd={confirmPair}
                onLeave={confirmLeave}
              />}

              {contractLoading ? (
                <Text style={[styles.muted, { color: theme.tokens.text.muted }]}>{m.comum_carregando()}</Text>
              ) : contract?.content.trim() ? (
                <View style={[styles.contract, { borderTopColor: theme.tokens.border.subtle }]}>
                  <Text style={[styles.sectionTitle, { color: theme.tokens.text.secondary }]}>{m.par_contrato_titulo()}</Text>
                  <View style={[styles.contractBody, { backgroundColor: superficie(theme), borderColor: theme.tokens.border.subtle }]}>
                    <EnrichedMarkdownText markdown={contract.content} markdownStyle={mdStyle} flavor="github" />
                  </View>
                  <Text style={[styles.path, { color: theme.tokens.text.muted }]} numberOfLines={1} selectable>{contract.path}</Text>
                </View>
              ) : contractError ? (
                <Text style={[styles.contractError, { color: theme.tokens.status.warning }]} accessibilityRole="alert">{contractError}</Text>
              ) : null}

              <PairFeed sessionName={name} feed={feed} failed={feedFailed} loading={feedLoading} />
            </>
          ) : (
            <PairPicker
              sessions={candidates}
              picked={picked}
              task={task}
              busy={busy}
              error={actionError || loadError}
              loading={loading}
              onToggle={togglePick}
              onTaskChange={setTask}
              onPair={confirmPair}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const sheetOptions = {
  headerShown: false,
  headerTransparent: true,
  sheetAllowedDetents: [0.92],
  sheetGrabberVisible: true,
  contentStyle: { backgroundColor: 'transparent' },
};

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  scroll: { padding: theme.base.space[4], gap: theme.base.space[4], paddingBottom: theme.base.space[6] },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.base.space[2], padding: theme.base.space[4] },
  muted: { fontSize: theme.base.text.sm, textAlign: 'center' },
  error: { fontSize: theme.base.text.sm, textAlign: 'center' },
  back: { minHeight: 44, lineHeight: 44, fontSize: theme.base.text.sm },
  actionError: { fontSize: theme.base.text.sm, lineHeight: 20 },
  contract: { gap: theme.base.space[2], borderTopWidth: 1, paddingTop: theme.base.space[3] },
  sectionTitle: { fontSize: theme.base.text.sm, fontWeight: '700' },
  contractBody: { borderWidth: 1, borderRadius: theme.base.radius.md, padding: theme.base.space[3] },
  path: { fontSize: theme.base.text.xs },
  contractError: { fontSize: theme.base.text.xs },
  fora: { gap: theme.base.space[1] },
}));
