import { useEffect, useState, useCallback, useRef } from 'react';
import { Pressable, Text, TextInput, View, ActivityIndicator, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { getRootsForServer, scanDirForServer } from '@hangar/core';
import type { FsRoot, FsEntry, FsScanError, Server } from '@hangar/core';
import { readProject } from '../../stores/createPreferences';
import { superficie } from '../../theme/superficie';
import * as m from '../../paraglide/messages';

function scanMessage(error: FsScanError): string {
  return ({
    permission_denied: m.arquivo_sem_permissao, unreadable: m.arquivo_ilegivel,
    root_not_allowed: m.arquivo_raiz_nao_liberada, invalid_path: m.arquivo_caminho_invalido,
    not_found: m.arquivo_pasta_nao_encontrada, unknown: m.arquivo_ler_falhou,
  })[error]();
}

export function CwdPicker({
  server,
  onPick,
  selected,
  autoSelect = true,
}: {
  server: Server;
  onPick: (path: string, root: string) => void;
  selected?: string | null;
  autoSelect?: boolean;
}) {
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [rootsError, setRootsError] = useState('');
  const [activeRoot, setActiveRoot] = useState<FsRoot | null>(null);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const scanController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRootsLoading(true);
    setRootsError('');
    void (async () => {
      const r = await getRootsForServer(server, controller.signal);
      if (controller.signal.aborted) return;
      setRoots(r);
      const saved = autoSelect ? readProject(server.id) : null;
      if (!autoSelect && r.length) {
        setActiveRoot(r[0]);
        setPath(r[0].path);
      }
      if (saved && !r.some((root) => root.path === saved.root)) {
        setScanError(m.criar_projeto_indisponivel());
        return;
      }
      if (!autoSelect) return;
      for (const root of saved ? r.filter((root) => root.path === saved.root) : r) {
        const cwd = saved?.cwd ?? root.path;
        const result = await scanDirForServer(server, root.path, cwd, controller.signal);
        if (controller.signal.aborted) return;
        if (result.error) {
          setScanError(saved ? `${m.criar_projeto_indisponivel()} ${scanMessage(result.error)}` : scanMessage(result.error));
          continue;
        }
        onPick(cwd, root.path);
        return;
      }
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) setRootsError(cause instanceof Error ? cause.message : m.arquivo_carregar_raizes_erro());
    }).finally(() => {
      if (!controller.signal.aborted) setRootsLoading(false);
    });
    return () => { controller.abort(); scanController.current?.abort(); };
  }, [server, onPick, autoSelect]);

  const doScan = useCallback(async (rootPath: string, target: string, pick = false) => {
    scanController.current?.abort();
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanError(null);
    try {
      const res = await scanDirForServer(server, rootPath, target, controller.signal);
      if (controller.signal.aborted) return;
      if (res.error) {
        setScanError(scanMessage(res.error));
        setEntries([]);
      } else {
        setEntries(res.entries);
        if (pick) onPick(target, rootPath);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setScanError(e instanceof Error ? e.message : m.arquivo_ler_falhou());
      setEntries([]);
    } finally {
      if (!controller.signal.aborted) setScanning(false);
    }
  }, [server, onPick]);

  useEffect(() => {
    if (!rootsLoading && activeRoot) void doScan(activeRoot.path, path || activeRoot.path);
    return () => scanController.current?.abort();
  }, [activeRoot, path, doScan, rootsLoading, autoSelect]);

  const selectRoot = (r: FsRoot) => {
    setActiveRoot(r);
    setPath(r.path);
    setQuery('');
  };

  const filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
  })();

  const crumbs = (() => {
    if (!activeRoot) return [] as { label: string; path: string }[];
    const base = activeRoot.path;
    const rest = path.startsWith(base) ? path.slice(base.length) : '';
    const out = [{ label: activeRoot.name, path: base }];
    for (const match of rest.matchAll(/[^/\\]+/g)) {
      out.push({ label: match[0], path: path.slice(0, base.length + match.index + match[0].length) });
    }
    return out;
  })();

  if (rootsLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.muted}>{m.arquivo_carregando()}</Text>
      </View>
    );
  }
  if (rootsError) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted} accessibilityRole="alert">{rootsError}</Text>
      </View>
    );
  }
  if (!roots.length) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{m.arquivo_sem_raizes()}</Text>
        {scanError ? <Text style={styles.muted} accessibilityRole="alert">{scanError}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll} contentContainerStyle={styles.chips}>
        {roots.map((r) => (
          <Pressable
            key={r.path}
            onPress={() => selectRoot(r)}
            style={[styles.chip, activeRoot?.path === r.path && styles.chipOn]}
          >
            <Text style={[styles.chipTxt, activeRoot?.path === r.path && styles.chipTxtOn]}>{r.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder={m.arquivo_buscar_pasta()}
        placeholderTextColor="#8d8489"
        autoCapitalize="none"
        autoCorrect={false}
      />

      {activeRoot ? (
        <View style={styles.crumbsWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbs}>
            {crumbs.map((c, i) => (
              <View key={c.path} style={styles.crumbRow}>
                {i > 0 ? <Text style={styles.sep}>/</Text> : null}
                <Pressable onPress={() => setPath(c.path)} style={styles.crumbBtn}>
                  <Text style={styles.crumbTxt}>{c.label}</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Pressable onPress={() => void doScan(activeRoot!.path, path, true)} style={styles.useHere}>
            <Text style={styles.useHereTxt}>{m.arquivo_usar_pasta()}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.rows}>
        {scanning ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : scanError ? (
          <Text style={styles.muted}>{scanError}</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.muted}>{query.trim() ? (m.arquivo_sem_resultados()) : (m.arquivo_sem_subpastas())}</Text>
        ) : (
          <ScrollView style={styles.list} contentContainerStyle={{ gap: 4 }}>
            {filtered.map((e) => {
              const sel = selected === e.path;
              return (
                <View key={e.path} style={[styles.row, sel && styles.rowSel]}>
                  <Pressable onPress={() => void doScan(activeRoot!.path, e.path, true)} style={styles.rowBody} accessibilityState={{ selected: sel }}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {e.name}
                    </Text>
                    <Text style={styles.rowPath} numberOfLines={1}>
                      {e.path}
                    </Text>
                    <View style={styles.badges}>
                      {e.is_git ? <Text style={styles.badgeGit}>git</Text> : null}
                      {e.has_claude_md ? <Text style={styles.badgeCl}>CLAUDE.md</Text> : null}
                    </View>
                  </Pressable>
                  <Pressable onPress={() => setPath(e.path)} style={styles.drill} hitSlop={8} accessibilityLabel={m.arquivo_abrir({ nome: e.name })}>
                    <Text style={styles.drillTxt}>›</Text>
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, gap: theme.base.space[3] },
  center: { padding: theme.base.space[4], alignItems: 'center', gap: 8 },
  muted: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted, textAlign: 'center' },
  chipsScroll: { flexGrow: 0 },
  chips: { flexDirection: 'row', gap: theme.base.space[2], paddingBottom: 2 },
  chip: {
    height: 44,
    minHeight: 44,
    paddingHorizontal: theme.base.space[4],
    borderRadius: 9999,
    backgroundColor: superficie(theme),
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: theme.tokens.accent.dim, borderColor: theme.tokens.accent.base },
  chipTxt: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary, fontWeight: '500' },
  chipTxtOn: { color: theme.tokens.text.primary },
  search: {
    height: 44,
    backgroundColor: superficie(theme),
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    borderRadius: theme.base.radius.md,
    color: theme.tokens.text.primary,
    fontSize: 16,
    paddingHorizontal: theme.base.space[3],
  },
  crumbsWrap: { gap: theme.base.space[2] },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  sep: { color: theme.tokens.text.muted },
  crumbBtn: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 6, justifyContent: 'center', alignItems: 'center' },
  crumbTxt: { color: theme.tokens.accent.base, fontSize: theme.base.text.sm },
  useHere: {
    alignSelf: 'flex-start',
    height: 44,
    minHeight: 44,
    paddingHorizontal: theme.base.space[3],
    borderRadius: theme.base.radius.md,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    justifyContent: 'center',
  },
  useHereTxt: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary, fontWeight: '500' },
  rows: { flex: 1, minHeight: 200 },
  list: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: theme.base.radius.md,
    gap: theme.base.space[1],
  },
  rowSel: { backgroundColor: theme.tokens.accent.dim, borderWidth: 1, borderColor: theme.tokens.accent.base },
  rowBody: { flex: 1, minHeight: 56, justifyContent: 'center', padding: theme.base.space[2], gap: 2 },
  rowName: { fontSize: theme.base.text.base, fontWeight: '600', color: theme.tokens.text.primary },
  rowPath: { fontFamily: theme.base.fontMono, fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
  badges: { flexDirection: 'row', gap: 6, marginTop: 2 },
  badgeGit: { fontSize: 10, fontWeight: '600', color: theme.tokens.accent.base, backgroundColor: theme.tokens.accent.dim, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 9999, overflow: 'hidden' },
  badgeCl: { fontSize: 10, fontWeight: '600', color: theme.tokens.status.warning, backgroundColor: 'rgba(255,159,10,0.14)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 9999, overflow: 'hidden' },
  drill: { width: 44, justifyContent: 'center', alignItems: 'center' },
  drillTxt: { color: theme.tokens.text.muted, fontSize: 22, fontWeight: '300' },
}));
