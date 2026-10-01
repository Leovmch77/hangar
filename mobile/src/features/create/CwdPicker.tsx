import { useEffect, useState, useCallback, useRef } from 'react';
import { FlatList, Pressable, Text, TextInput, View, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getRootsForServer, relativeTime, scanDirForServer } from '@hangar/core';
import type { FsRoot, FsEntry, FsScanError, Server } from '@hangar/core';
import { readProject } from '../../stores/createPreferences';
import { Icon } from '../../ui/Icon';
import { useSettingsColors } from '../config/colors';
import { TextTabs } from '../usage/HomeUsageCard';
import * as m from '../../paraglide/messages';

function scanMessage(error: FsScanError): string {
  return ({
    permission_denied: m.arquivo_sem_permissao, unreadable: m.arquivo_ilegivel,
    root_not_allowed: m.arquivo_raiz_nao_liberada, invalid_path: m.arquivo_caminho_invalido,
    not_found: m.arquivo_pasta_nao_encontrada, unknown: m.arquivo_ler_falhou,
  })[error]();
}

// Caminho relativo ao pai da raiz ("projetos/web"), como o rel_path do app de PC.
function relPath(root: string, path: string): string {
  const cut = root.replace(/[/\\]+$/, '').search(/[/\\][^/\\]*$/);
  const parent = cut > 0 ? root.slice(0, cut + 1) : '';
  return parent && path.startsWith(parent) ? path.slice(parent.length) : path;
}

function parentOf(path: string): string {
  const cut = path.replace(/[/\\]+$/, '').search(/[/\\][^/\\]*$/);
  return cut > 0 ? path.slice(0, cut) : path;
}

export function CwdPicker({
  server,
  onPick,
  selected,
  autoSelect = true,
  onDone,
  compact = false,
}: {
  server: Server;
  // Sem raiz = caminho digitado; não vira o projeto lembrado.
  onPick: (path: string, root?: string) => void;
  selected?: string | null;
  autoSelect?: boolean;
  // Escolha final (linha, "Usar esta pasta", caminho digitado): quem abriu o painel o fecha.
  onDone?: () => void;
  // Painel preso à pílula da tela inicial: menu enxuto que encolhe ao conteúdo.
  compact?: boolean;
}) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [rootsError, setRootsError] = useState('');
  const [rootsTry, setRootsTry] = useState(0);
  const [activeRoot, setActiveRoot] = useState<FsRoot | null>(null);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // Falha de rede tem "tentar de novo"; recusa do backend (permissão, pasta sumida) é só o motivo.
  const [scanFailed, setScanFailed] = useState(false);
  const [scanTry, setScanTry] = useState(0);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const scanController = useRef<AbortController | null>(null);
  const selectedAtOpen = useRef(selected);

  useEffect(() => {
    const controller = new AbortController();
    setRootsLoading(true);
    setRootsError('');
    setScanError(null);
    void (async () => {
      const r = await getRootsForServer(server, controller.signal);
      if (controller.signal.aborted) return;
      setRoots(r);
      const saved = readProject(server.id);
      if (!autoSelect && r.length) {
        // O painel reabre onde a pasta escolhida está, como o menu do PC, que guarda a pasta aberta.
        const root = r.find((x) => x.path === saved?.root) ?? r[0];
        const current = selectedAtOpen.current;
        setActiveRoot(root);
        setPath(current && current !== root.path && current.startsWith(root.path) ? parentOf(current) : root.path);
        return;
      }
      if (saved && !r.some((root) => root.path === saved.root)) {
        setScanError(m.criar_projeto_indisponivel());
        return;
      }
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
  }, [server, onPick, autoSelect, rootsTry]);

  const doScan = useCallback(async (rootPath: string, target: string) => {
    scanController.current?.abort();
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanError(null);
    setScanFailed(false);
    try {
      const res = await scanDirForServer(server, rootPath, target, controller.signal);
      if (controller.signal.aborted) return;
      setEntries(res.error ? [] : res.entries);
      if (res.error) setScanError(scanMessage(res.error));
    } catch (e) {
      if (controller.signal.aborted) return;
      setScanError(e instanceof Error ? e.message : m.arquivo_ler_falhou());
      setScanFailed(true);
      setEntries([]);
    } finally {
      if (!controller.signal.aborted) setScanning(false);
    }
  }, [server]);

  useEffect(() => {
    if (!rootsLoading && activeRoot) void doScan(activeRoot.path, path || activeRoot.path);
    return () => scanController.current?.abort();
  }, [activeRoot, path, doScan, rootsLoading, scanTry]);

  // Raiz escolhida já é a pasta, como no menu do PC; o painel continua aberto para descer nela.
  const selectRoot = (r: FsRoot) => {
    setActiveRoot(r);
    setPath(r.path);
    setQuery('');
    onPick(r.path, r.path);
  };
  const drill = (p: string) => {
    setPath(p);
    setQuery('');
  };
  const choose = (p: string, root?: string) => {
    onPick(p, root);
    onDone?.();
  };
  const useTyped = () => {
    const p = manualPath.trim();
    if (p) choose(p);
  };

  const q = query.trim().toLowerCase();
  const filtered = !q || !activeRoot ? entries
    : entries.filter((e) => e.name.toLowerCase().includes(q) || relPath(activeRoot.path, e.path).toLowerCase().includes(q));

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

  if (compact) {
    const textRetry = (onPress: () => void) => (
      <Pressable onPress={onPress} accessibilityRole="button" hitSlop={6} style={styles.cTextBtn}>
        <Text style={[styles.cTextBtnTxt, { color: c.accent }]}>{m.native_retry()}</Text>
      </Pressable>
    );
    const note = (text: string, alert = false) => (
      <Text style={[styles.cNote, { color: alert ? theme.tokens.status.error : c.faint }]}
            accessibilityRole={alert ? 'alert' : undefined}>{text}</Text>
    );
    const inSub = !!activeRoot && path !== '' && path !== activeRoot.path;
    const manualValid = !!manualPath.trim();

    const cRows = !activeRoot ? (
      scanError ? note(scanError, true) : null
    ) : scanning ? (
      <View style={styles.cSkeletons}>
        {[120, 168, 96].map((w) => <View key={w} style={[styles.cSkeleton, { width: w, backgroundColor: c.border }]} />)}
      </View>
    ) : scanError ? (
      <View style={styles.cState}>
        {note(scanError, scanFailed)}
        {scanFailed ? textRetry(() => setScanTry((n) => n + 1)) : null}
      </View>
    ) : filtered.length === 0 ? (
      note(q ? m.native_create_no_results() : m.native_create_no_subfolders())
    ) : (
      <FlatList
        data={filtered}
        keyExtractor={(e) => e.path}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // Altura explícita: dentro do painel que encolhe, a lista sem altura colapsava em uma linha.
        style={[styles.cList, { height: Math.min(filtered.length, 5) * 44.5 }]}
        ItemSeparatorComponent={() => <View style={[styles.cSep, { backgroundColor: c.border }]} />}
        renderItem={({ item: e }) => {
          const on = selected === e.path;
          const when = relativeTime(e.mtime);
          return (
            <View style={[styles.cRowWrap, on && { backgroundColor: c.accentDim }]}>
              <Pressable
                onPress={() => choose(e.path, activeRoot.path)}
                accessibilityRole="button"
                accessibilityLabel={e.name}
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.cRow, pressed && !on && { backgroundColor: c.hover }]}
              >
                <Icon name="Folder" size={16} color={c.faint} />
                <Text style={[styles.cName, { color: c.text }]} numberOfLines={1} ellipsizeMode="tail">{e.name}</Text>
                {e.is_git ? <Icon name="GitBranch" size={12} color={c.faint} /> : null}
                {when ? <Text style={[styles.cWhen, { color: c.faint }]}>{when}</Text> : null}
              </Pressable>
              <Pressable onPress={() => drill(e.path)} style={({ pressed }) => [styles.cDrill, pressed && { backgroundColor: c.hover }]}
                         accessibilityRole="button" accessibilityLabel={m.native_create_open({ nome: e.name })}>
                <Icon name="ChevronRight" size={14} color={c.faint} />
              </Pressable>
            </View>
          );
        }}
      />
    );

    return (
      <View style={styles.cContainer}>
        {rootsLoading ? (
          <View style={styles.cTabsRow}>{[64, 88].map((w) => <View key={w} style={[styles.cTabSkeleton, { width: w, backgroundColor: c.border }]} />)}</View>
        ) : rootsError ? (
          <View style={styles.cState}>
            {note(`${m.native_create_roots_failed()} ${rootsError}`, true)}
            {textRetry(() => setRootsTry((n) => n + 1))}
          </View>
        ) : !roots.length ? (
          note(m.arquivo_sem_raizes())
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll} keyboardShouldPersistTaps="handled">
            <TextTabs
              label={m.native_create_roots()}
              value={activeRoot?.path ?? ''}
              onChange={(p) => { const r = roots.find((x) => x.path === p); if (r) selectRoot(r); }}
              options={roots.map((r) => ({ v: r.path, label: r.name }))}
            />
          </ScrollView>
        )}

        {activeRoot ? (
          <View style={[styles.cSearch, { backgroundColor: c.inset }]}>
            <Icon name="Search" size={14} color={c.faint} />
            <TextInput
              style={[styles.searchInput, { color: c.text }]}
              value={query}
              onChangeText={setQuery}
              placeholder={m.native_create_search()}
              accessibilityLabel={m.native_create_search()}
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>
        ) : null}

        {inSub ? (
          <View style={styles.cPathRow}>
            <Pressable onPress={() => drill(parentOf(path))} hitSlop={8} accessibilityRole="button" accessibilityLabel={m.comum_voltar()}
                       style={({ pressed }) => [styles.cBack, pressed && { backgroundColor: c.hover }]}>
              <Icon name="ChevronLeft" size={14} color={c.muted} />
            </Pressable>
            <Text style={[styles.cPath, { color: c.muted }]} numberOfLines={1} ellipsizeMode="head"
                  accessibilityLabel={`${m.native_create_path()}: ${relPath(activeRoot.path, path)}`}>
              {relPath(activeRoot.path, path)}
            </Text>
          </View>
        ) : null}

        <View style={styles.cRows}>{cRows}</View>

        <View style={styles.cFooter}>
          {activeRoot ? (
            <Pressable onPress={() => choose(path || activeRoot.path, activeRoot.path)} accessibilityRole="button"
                       style={({ pressed }) => [styles.cPill, { borderColor: c.accent }, pressed && { backgroundColor: c.accentDim }]}>
              <Text style={[styles.cPillTxt, { color: c.accent }]}>{m.native_create_use_folder()}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setManualOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: manualOpen }}
                     hitSlop={6} style={styles.cTextBtn}>
            <Text style={[styles.cTextBtnTxt, { color: c.muted }]}>{m.native_create_computer_folder()}</Text>
          </Pressable>
        </View>
        {manualOpen ? (
          <View style={styles.manual}>
            <TextInput
              style={[styles.cSearch, styles.cManualInput, { backgroundColor: c.inset, color: c.text }]}
              value={manualPath}
              onChangeText={setManualPath}
              onSubmitEditing={useTyped}
              placeholder={m.native_create_path_placeholder()}
              accessibilityLabel={m.native_create_path_aria()}
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="go"
            />
            <Pressable onPress={useTyped} disabled={!manualValid} accessibilityRole="button" accessibilityState={{ disabled: !manualValid }}
                       style={[styles.cPill, { borderColor: c.accent }, !manualValid && styles.disabled]}>
              <Text style={[styles.cPillTxt, { color: c.accent }]}>{m.native_create_use()}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  const retry = (onPress: () => void) => (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.outline}>
      <Text style={styles.outlineTxt}>{m.native_retry()}</Text>
    </Pressable>
  );

  // Esqueleto da trilha de raízes: duas pílulas de 96 × 32.
  const rootsBlock = rootsLoading ? (
    <View style={styles.chips}>{[0, 1].map((i) => <View key={i} style={[styles.skeleton, styles.chipSkeleton]} />)}</View>
  ) : rootsError ? (
    <View style={styles.state}>
      <Text style={styles.error} accessibilityRole="alert">{`${m.native_create_roots_failed()} ${rootsError}`}</Text>
      {retry(() => setRootsTry((n) => n + 1))}
    </View>
  ) : !roots.length ? (
    <Text style={styles.muted}>{m.arquivo_sem_raizes()}</Text>
  ) : (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll} contentContainerStyle={styles.chips}
                accessibilityLabel={m.native_create_roots()} keyboardShouldPersistTaps="handled">
      {roots.map((r) => {
        const on = activeRoot?.path === r.path;
        return (
          <Pressable key={r.path} onPress={() => selectRoot(r)} accessibilityRole="button" accessibilityState={{ selected: on }}
                     hitSlop={{ top: 6, bottom: 6 }} style={[styles.chip, on && styles.chipOn]}>
            <Text style={[styles.chipTxt, on && styles.chipTxtOn]} numberOfLines={1}>{r.name}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  const rows = !activeRoot ? (
    scanError ? <Text style={styles.muted} accessibilityRole="alert">{scanError}</Text> : null
  ) : scanning ? (
    // Cinco linhas de esqueleto: nome e detalhe, como o render_rows do PC.
    <View style={styles.skeletonList}>
      {[0, 1, 2, 3, 4].map((i) => (
        <View key={i} style={styles.skeletonRow}>
          <View style={[styles.skeleton, { width: 160, height: 12 }]} />
          <View style={[styles.skeleton, styles.skeletonSoft, { width: 240, height: 10 }]} />
        </View>
      ))}
    </View>
  ) : scanError ? (
    <View style={styles.state}>
      <Text style={scanFailed ? styles.error : styles.muted} accessibilityRole="alert">{scanError}</Text>
      {scanFailed ? retry(() => setScanTry((n) => n + 1)) : null}
    </View>
  ) : filtered.length === 0 ? (
    <Text style={styles.muted}>{q ? m.native_create_no_results() : m.native_create_no_subfolders()}</Text>
  ) : (
    <FlatList
      data={filtered}
      keyExtractor={(e) => e.path}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      style={styles.list}
      renderItem={({ item: e }) => {
        const on = selected === e.path;
        const when = relativeTime(e.mtime);
        return (
          <View style={styles.rowWrap}>
            <Pressable
              onPress={() => choose(e.path, activeRoot.path)}
              accessibilityRole="button"
              accessibilityLabel={e.name}
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && !on && styles.rowPressed]}
            >
              <Text style={styles.rowName} numberOfLines={1}>{e.name}</Text>
              <View style={styles.meta}>
                <Text style={styles.rowPath} numberOfLines={1}>{relPath(activeRoot.path, e.path)}</Text>
                {e.is_git ? <Text style={styles.badge}>git</Text> : null}
                {e.has_claude_md ? <Text style={styles.badge}>CLAUDE.md</Text> : null}
                {when ? <Text style={styles.when}>{when}</Text> : null}
              </View>
            </Pressable>
            <Pressable onPress={() => drill(e.path)} style={({ pressed }) => [styles.drill, pressed && styles.rowPressed]}
                       accessibilityRole="button" accessibilityLabel={m.native_create_open({ nome: e.name })}>
              <Icon name="ChevronRight" size={16} color={theme.tokens.text.secondary} />
            </Pressable>
          </View>
        );
      }}
    />
  );

  return (
    <View style={styles.container}>
      {rootsBlock}

      {activeRoot ? (
        <>
          <View style={[styles.search, searchFocused && styles.searchOn]}>
            <Icon name="Search" size={14} color={theme.tokens.text.muted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder={m.native_create_search()}
              accessibilityLabel={m.native_create_search()}
              placeholderTextColor={theme.tokens.text.muted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbs}
                      accessibilityLabel={m.native_create_path()} keyboardShouldPersistTaps="handled" style={styles.chipsScroll}>
            {crumbs.map((c) => (
              <Pressable key={c.path} onPress={() => drill(c.path)} style={({ pressed }) => [styles.crumb, pressed && styles.rowPressed]}
                         accessibilityRole="button">
                <Text style={styles.crumbTxt} numberOfLines={1}>{c.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      ) : null}

      <View style={styles.rows}>{rows}</View>

      <View style={styles.footer}>
        {activeRoot ? (
          <Pressable onPress={() => choose(path || activeRoot.path, activeRoot.path)} accessibilityRole="button" style={styles.outline}>
            <Text style={styles.outlineTxt}>{m.native_create_use_folder()}</Text>
          </Pressable>
        ) : null}
        {/* No celular não há seletor de pastas do sistema para o servidor: "Abrir pasta…" é digitar o caminho. */}
        <Pressable onPress={() => setManualOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: manualOpen }}
                   style={({ pressed }) => [styles.ghost, pressed && styles.rowPressed]}>
          <Icon name="FolderOpen" size={14} color={theme.tokens.text.secondary} />
          <Text style={styles.ghostTxt}>{m.native_create_computer_folder()}</Text>
        </Pressable>
      </View>
      {manualOpen ? (
        <View style={styles.manual}>
          <TextInput
            style={styles.manualInput}
            value={manualPath}
            onChangeText={setManualPath}
            onSubmitEditing={useTyped}
            placeholder={m.native_create_path_placeholder()}
            accessibilityLabel={m.native_create_path_aria()}
            placeholderTextColor={theme.tokens.text.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="go"
          />
          <Pressable onPress={useTyped} disabled={!manualPath.trim()} accessibilityRole="button"
                     accessibilityState={{ disabled: !manualPath.trim() }} style={[styles.outline, !manualPath.trim() && styles.disabled]}>
            <Text style={styles.outlineTxt}>{m.native_create_use()}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

// Medidas do render_compact_folders do PC (create.rs:1602): gap 12, pílulas de raiz, campo pequeno
// com lupa, linhas com borda raio 8 e a seta fora delas. Alturas sobem para o toque.
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, gap: 12 },
  state: { gap: 8, alignItems: 'flex-start', paddingVertical: 8 },
  muted: { fontSize: 14, color: theme.tokens.text.muted, paddingVertical: 8 },
  error: { fontSize: 13.5, color: theme.tokens.status.error },
  chipsScroll: { flexGrow: 0, flexShrink: 0 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: theme.tokens.accent.dim, borderColor: theme.tokens.accent.base },
  chipTxt: { fontSize: 14, color: theme.tokens.text.primary },
  chipTxtOn: { fontWeight: '500' },
  skeleton: { borderRadius: 6, backgroundColor: theme.tokens.border.default },
  skeletonSoft: { opacity: 0.6 },
  chipSkeleton: { width: 96, height: 32, borderRadius: 9999 },
  skeletonList: { gap: 6 },
  skeletonRow: { gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
  search: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
  },
  searchOn: { borderColor: theme.tokens.accent.base },
  // 16 no campo: abaixo disso o iOS dá zoom ao focar.
  searchInput: { flex: 1, height: '100%', color: theme.tokens.text.primary, fontSize: 16, paddingVertical: 0 },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  crumb: { minHeight: 32, paddingHorizontal: 8, borderRadius: 6, justifyContent: 'center' },
  crumbTxt: { fontSize: 14, color: theme.tokens.text.primary },
  rows: { flex: 1, minHeight: 96 },
  list: { flex: 1 },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingBottom: 2 },
  row: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    justifyContent: 'center',
    gap: 2,
  },
  rowOn: { backgroundColor: theme.tokens.accent.dim, borderColor: theme.tokens.accent.base },
  rowPressed: { backgroundColor: theme.tokens.border.subtle },
  rowName: { fontSize: 15, fontWeight: '600', color: theme.tokens.text.primary },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowPath: { flex: 1, minWidth: 0, fontFamily: theme.base.fontMono, fontSize: 12, color: theme.tokens.text.muted },
  badge: {
    fontFamily: theme.base.fontMono,
    fontSize: 11.5,
    color: theme.tokens.text.muted,
    paddingHorizontal: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    overflow: 'hidden',
  },
  when: { flexShrink: 0, fontSize: 12, color: theme.tokens.text.muted, opacity: 0.8 },
  drill: { width: 40, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  outline: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    justifyContent: 'center',
  },
  outlineTxt: { fontSize: 14, fontWeight: '500', color: theme.tokens.text.primary },
  ghost: { minHeight: 36, paddingHorizontal: 10, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  ghostTxt: { fontSize: 14, color: theme.tokens.text.secondary },
  manual: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  manualInput: {
    flex: 1,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    color: theme.tokens.text.primary,
    fontFamily: theme.base.fontMono,
    fontSize: 16,
  },
  disabled: { opacity: 0.5 },
  // Modo compacto: menu do iPhone com as cores do Hangar; sem flex:1 para o painel encolher ao conteúdo.
  cContainer: { flexShrink: 1, gap: 8 },
  cState: { gap: 4, alignItems: 'flex-start', paddingVertical: 4 },
  cNote: { fontSize: 14, paddingVertical: 6 },
  cTextBtn: { height: 32, justifyContent: 'center', paddingHorizontal: 4 },
  cTextBtnTxt: { fontSize: 14.5, fontWeight: '500' },
  cTabsRow: { flexDirection: 'row', gap: 6 },
  cTabSkeleton: { height: 28, borderRadius: 6 },
  cSearch: { height: 36, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 },
  cPathRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -2 },
  cBack: { width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  cPath: { flex: 1, minWidth: 0, fontSize: 13 },
  cRows: { flexShrink: 1 },
  cList: { flexGrow: 0, flexShrink: 1 },
  cSkeletons: { gap: 18, paddingVertical: 12, paddingLeft: 8 },
  cSkeleton: { height: 8, borderRadius: 4 },
  cRowWrap: { flexDirection: 'row', alignItems: 'center', borderRadius: 8 },
  cRow: { flex: 1, minWidth: 0, height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 8, borderRadius: 8 },
  cName: { flexShrink: 1, fontSize: 15, fontWeight: '500' },
  cWhen: { marginLeft: 'auto', paddingLeft: 8, fontSize: 13, fontVariant: ['tabular-nums'] },
  cDrill: { width: 40, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  // Recuo até o texto: 8 de margem + ícone 16 + gap 10.
  cSep: { height: StyleSheet.hairlineWidth, marginLeft: 34 },
  cFooter: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 2 },
  cPill: { height: 32, paddingHorizontal: 14, borderRadius: 9999, borderWidth: 1, justifyContent: 'center' },
  cPillTxt: { fontSize: 14.5, fontWeight: '500' },
  cManualInput: { flex: 1, fontFamily: theme.base.fontMono, fontSize: 16 },
}));
