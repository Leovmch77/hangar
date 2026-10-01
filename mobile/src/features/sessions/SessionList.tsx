import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, RefreshControl, SectionList, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MenuView } from '@react-native-menu/menu';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useRouter } from 'expo-router';
import {
  agruparSessoes,
  deleteSession,
  effectiveGroupBy,
  formataErro,
  renameSession,
  resumeSession,
  type AggSession,
  type GroupBy,
} from '@hangar/core';
import { useServers } from '../../stores/servers';
import { useSessions } from '../../stores/sessions';
import { useAparencia, ehGroupBy } from '../../stores/aparencia';
import { HangarMark } from '../../ui/HangarMark';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/Toast';
import { SessionRow } from './SessionRow';
import { splitAttention } from './AttentionStrip';
import { RenameSheet } from './RenameSheet';
import * as m from '../../paraglide/messages';
import { superficie } from '../../theme/superficie';

const ROTULO_AGRUPAR: Record<GroupBy, () => string> = {
  none: m.lista_agrupar_nenhum,
  server: m.lista_agrupar_servidor,
  project: m.lista_agrupar_projeto,
};

// Erro LANÇADO pelo apiFetch — já vem com mensagem pronta. O `formataErro` é pro envelope do
// corpo da resposta (o `warning` do excluir), e aplicado a um Error devolve o código cru.
const mensagemDe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Um grupo do painel: "Precisa de você" no topo, depois os grupos do Agrupar por. `total` sobrevive
// ao grupo recolhido (aí `data` fica vazio e o cabeçalho continua contando).
interface Section {
  id: string;
  label: string;
  color: string | null;
  attention: boolean;
  total: number;
  collapsed: boolean;
  data: AggSession[];
}

interface Props {
  onOpenServers: () => void;
  onOpenSettings: () => void;
}

export function SessionList({ onOpenServers, onOpenSettings }: Props) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const servers = useServers((s) => s.servers);
  const ready = useServers((s) => s.ready);
  const rows = useSessions((s) => s.rows);
  const loading = useSessions((s) => s.loading);
  const agrupar = useAparencia((s) => s.agrupar);
  const activeId = useServers((s) => s.activeId);
  const byServer = useSessions((s) => s.byServer);
  const [filtro, setFiltro] = useState('');
  const [buscaAberta, setBuscaAberta] = useState(false);
  // chave `modo:id`: trocar o Agrupar por não herda o recolhido de um grupo de outro tipo
  const [recolhidos, setRecolhidos] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  // guarda a sessão inteira, não o nome: dois servidores podem ter sessões de mesmo nome
  const [renomeando, setRenomeando] = useState<AggSession | null>(null);
  // uma linha aberta por vez: a anterior fecha quando outra abre, e ao rolar
  const aberta = useRef<SwipeableMethods | null>(null);
  const trocarAberta = useCallback((nova: SwipeableMethods | null) => {
    if (aberta.current && aberta.current !== nova) aberta.current.close();
    aberta.current = nova;
  }, []);

  // 1 stream por servidor via refcount compartilhado
  useEffect(() => {
    const release = useSessions.getState().retain();
    return () => release();
  }, []);

  // A API fala com o servidor ATIVO — uma ação numa linha de outro servidor iria pro lugar errado.
  const comServidor = useCallback((s: AggSession, fn: () => void) => {
    if (!useServers.getState().ensureActive(s.serverId)) {
      toast.erro(m.servidor_nao_existe());
      return;
    }
    fn();
  }, []);

  const abrir = useCallback((s: AggSession) => router.push(`/s/${s.serverId}/${s.name}` as never), [router]);
  const abrirGit = useCallback((s: AggSession) => router.push(`/s/${s.serverId}/${s.name}/files` as never), [router]);

  const excluir = useCallback(
    (s: AggSession) =>
      Alert.alert(m.sessao_excluir(), s.name, [
        { text: m.comum_cancelar(), style: 'cancel' },
        {
          text: m.sessao_excluir_curto(),
          style: 'destructive',
          onPress: () =>
            comServidor(s, () => {
              deleteSession(s.name)
                .then((r) => {
                  // A sessão morreu, mas um companheiro do grupo pode não ter sido avisado: o
                  // motivo aparece em vez de a linha sumir calada (mesmo tratamento do desktop).
                  if (r.warning) toast.erro(formataErro(r.warning) ?? String(r.warning));
                  else toast.ok(s.name);
                })
                .catch((e: unknown) => toast.erro(mensagemDe(e)));
            }),
        },
      ]),
    [comServidor],
  );

  const renomear = useCallback(
    (novo: string) => {
      const s = renomeando;
      setRenomeando(null);
      if (!s) return;
      comServidor(s, () => {
        // o backend sanitiza o nome — mostra o que ficou, não o que foi digitado
        renameSession(s.name, novo)
          .then((r) => toast.ok(r.name))
          .catch((e: unknown) => toast.erro(mensagemDe(e)));
      });
    },
    [comServidor, renomeando],
  );

  const retomar = useCallback(
    (s: AggSession) =>
      comServidor(s, () => {
        resumeSession(s.name)
          .then((r) => {
            // Vários transcripts candidatos: escolher qual é decisão de quem lê a conversa.
            if ('ambiguous' in r) toast.erro(m.sessao_retomar_qual());
            else toast.ok(s.name);
          })
          .catch((e: unknown) => toast.erro(mensagemDe(e)));
      }),
    [comServidor],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    useSessions.getState().reconnect();
    // A reconexão é síncrona no store; damos um tick pro SSE emitir antes de parar o spinner.
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const modo = effectiveGroupBy(agrupar, servers.length);
  const busca = filtro.trim().toLowerCase();
  // Filtrar + ordenar + agrupar a lista inteira a cada render é caro, e arrastar um slider de
  // material re-renderiza todo mundo que lê o tema — inclusive esta tela.
  const sections = useMemo<Section[]>(() => {
    const visiveis = busca
      ? rows.filter((r) => r.name.toLowerCase().includes(busca) || (r.cwd ?? '').toLowerCase().includes(busca))
      : rows;
    const { attention, rest } = splitAttention(visiveis);
    const out: Section[] = [];
    if (attention.length) {
      out.push({ id: 'attention', label: m.board_precisa_de_voce(), color: null, attention: true, total: attention.length, collapsed: false, data: attention });
    }
    for (const g of agruparSessoes(rest, modo)) {
      if (!g.sessions.length) continue;
      const collapsed = modo !== 'none' && recolhidos.has(`${modo}:${g.id}`);
      out.push({ id: g.id, label: g.label, color: g.color, attention: false, total: g.sessions.length, collapsed, data: collapsed ? [] : g.sessions });
    }
    return out;
  }, [rows, busca, modo, recolhidos]);
  const variosServidores = servers.length > 1;

  const alternarGrupo = useCallback(
    (id: string) =>
      setRecolhidos((atual) => {
        const novo = new Set(atual);
        const chave = `${modo}:${id}`;
        if (novo.has(chave)) novo.delete(chave);
        else novo.add(chave);
        return novo;
      }),
    [modo],
  );

  const alternarBusca = useCallback(() => {
    // fechar o campo com texto dentro deixaria a lista filtrada sem nada na tela dizendo por quê
    if (buscaAberta) setFiltro('');
    setBuscaAberta(!buscaAberta);
  }, [buscaAberta]);

  // "Todas as sessões" desfaz tudo que esconde linha: filtro e grupos recolhidos.
  const mostrarTodas = useCallback(() => {
    setFiltro('');
    setBuscaAberta(false);
    setRecolhidos(new Set());
  }, []);

  const novaConversa = useCallback(() => router.push('/create' as never), [router]);

  const ativo = servers.find((s) => s.id === activeId) ?? null;
  const baldeAtivo = byServer.find((b) => b.server.id === activeId);
  const corAtivo = baldeAtivo?.error ? theme.tokens.status.error : baldeAtivo?.loaded ? theme.tokens.status.success : theme.tokens.text.muted;
  const rotuloAtivo = ativo
    ? baldeAtivo?.error
      ? m.lista_servidor_offline({ label: ativo.label })
      : baldeAtivo?.loaded
        ? `${ativo.label}, ${m.native_connected()}`
        : ativo.label
    : '';

  const iconeTopo = (icon: 'Search' | 'Server' | 'Settings', label: string, onPress: () => void, ativoIcone = false) => (
    <Pressable
      onPress={onPress}
      style={styles.icone}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={icon === 'Search' ? { expanded: buscaAberta } : undefined}
      hitSlop={4}
    >
      <Icon name={icon} size={18} color={ativoIcone ? theme.tokens.text.primary : theme.tokens.text.secondary} />
    </Pressable>
  );

  const topo = (
    <View style={styles.topo}>
      <HangarMark size={18} color={theme.tokens.text.primary} />
      <Text style={[styles.marca, { color: theme.tokens.text.primary }]} numberOfLines={1} accessibilityRole="header">
        {m.native_brand()}
      </Text>
      <View style={styles.topoAcoes}>
        {iconeTopo('Search', m.lista_filtrar(), alternarBusca, buscaAberta || !!filtro)}
        <MenuView
          onPressAction={({ nativeEvent }) => {
            if (ehGroupBy(nativeEvent.event)) useAparencia.getState().setAgrupar(nativeEvent.event);
          }}
          actions={(['server', 'project', 'none'] as GroupBy[]).map((g) => ({
            id: g,
            title: ROTULO_AGRUPAR[g](),
            state: g === agrupar ? ('on' as const) : ('off' as const),
          }))}
        >
          <View style={styles.icone} accessible accessibilityRole="button" accessibilityLabel={m.lista_agrupar()} accessibilityValue={{ text: ROTULO_AGRUPAR[agrupar]() }}>
            <Icon name="ListFilter" size={18} color={theme.tokens.text.secondary} />
          </View>
        </MenuView>
        {iconeTopo('Server', m.maquinas_este_aparelho(), onOpenServers)}
        {iconeTopo('Settings', m.config_modal_titulo(), onOpenSettings)}
      </View>
    </View>
  );

  const campoBusca = buscaAberta ? (
    <View style={[styles.campo, { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]}>
      <Icon name="Search" size={14} color={theme.tokens.text.muted} />
      <TextInput
        value={filtro}
        onChangeText={setFiltro}
        placeholder={m.lista_filtro_placeholder()}
        placeholderTextColor={theme.tokens.text.muted}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        accessibilityLabel={m.lista_filtrar()}
        style={[styles.input, { color: theme.tokens.text.primary }]}
      />
      {filtro ? (
        <Pressable onPress={() => setFiltro('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={m.lista_filtro_limpar()}>
          <Icon name="X" size={14} color={theme.tokens.text.muted} />
        </Pressable>
      ) : null}
    </View>
  ) : null;

  const itemNav = (icon: 'SquarePen' | 'List', label: string, onPress: () => void, contagem?: number) => (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.nav, pressed && { backgroundColor: superficie(theme, 0.8) }]}
      accessibilityRole="button"
      accessibilityLabel={contagem === undefined ? label : `${label}, ${contagem}`}
    >
      <Icon name={icon} size={16} color={theme.tokens.text.secondary} />
      <Text style={[styles.navTxt, { color: theme.tokens.text.primary }]} numberOfLines={1}>{label}</Text>
      {contagem === undefined ? null : <Text style={[styles.navConta, { color: theme.tokens.text.muted }]}>{contagem}</Text>}
    </Pressable>
  );

  const rodape = (
    <View style={styles.rodape}>
      {servers.length ? (
        <Pressable
          onPress={novaConversa}
          // texto e fundo trocados entre si: a pílula inverte sozinha no tema claro e no escuro
          style={({ pressed }) => [styles.nova, { backgroundColor: theme.tokens.text.primary, opacity: pressed ? 0.8 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={m.sessao_nova()}
        >
          <Icon name="Plus" size={16} color={theme.tokens.bg.base} />
          <Text style={[styles.novaTxt, { color: theme.tokens.bg.base }]}>{m.lista_nova_curto()}</Text>
        </Pressable>
      ) : null}
      {ativo ? (
        <Pressable onPress={onOpenServers} style={styles.ativo} accessibilityRole="button" accessibilityLabel={rotuloAtivo} hitSlop={6}>
          <View style={[styles.ponto, { backgroundColor: corAtivo }]} />
          <Text style={[styles.ativoTxt, { color: theme.tokens.text.muted }]} numberOfLines={1}>{ativo.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );

  // `noTopo`: com a busca aberta o teclado cobre a metade de baixo, e o aviso centrado sumia atrás dele.
  const vazio = (titulo: string | null, texto: string | null, noTopo = false) => (
    <View style={[styles.empty, noTopo && styles.emptyTopo]}>
      {titulo ? <Text style={styles.emptyTitle}>{titulo}</Text> : null}
      {texto ? <Text style={styles.emptyTxt}>{texto}</Text> : null}
    </View>
  );

  let corpo: ReactNode;
  if (!ready) corpo = vazio(null, m.comum_carregando());
  else if (servers.length === 0) corpo = vazio(m.lista_nenhum_servidor(), m.lista_pareie_qr());
  else if (loading && rows.length === 0) corpo = vazio(null, m.lista_carregando());
  else {
    corpo = (
      <SectionList
        sections={sections}
        keyExtractor={(item) => `${item.serverId}::${item.name}`}
        // Sem cabeçalho fixo: o painel é vidro, e um cabeçalho fixo transparente deixaria as linhas
        // passarem por baixo do texto dele.
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.navs}>
            {itemNav('SquarePen', m.native_new_chat_title(), novaConversa)}
            {itemNav('List', m.native_sidebar_all_sessions(), mostrarTodas, rows.length)}
          </View>
        }
        renderSectionHeader={({ section }) => {
          if (!section.label) return null;
          const cor = section.attention ? theme.tokens.pill.input.fg : (section.color ?? theme.tokens.text.muted);
          const conteudo = (
            <>
              {section.attention ? null : (
                <Icon name={section.collapsed ? 'ChevronRight' : 'ChevronDown'} size={12} color={theme.tokens.text.muted} />
              )}
              <View style={[styles.ponto, { backgroundColor: cor }]} />
              <Text style={[styles.grupoTxt, { color: theme.tokens.text.muted }]} numberOfLines={1}>{section.label}</Text>
              <Text style={[styles.grupoConta, { color: theme.tokens.text.muted }]}>{section.total}</Text>
            </>
          );
          return section.attention ? (
            <View style={styles.grupo} accessible accessibilityRole="header" accessibilityLabel={`${section.label}, ${section.total}`}>
              {conteudo}
            </View>
          ) : (
            <Pressable
              onPress={() => alternarGrupo(section.id)}
              style={styles.grupo}
              accessibilityRole="button"
              accessibilityLabel={`${section.label}, ${section.total} ${m.lista_sessoes_plural()}`}
              accessibilityState={{ expanded: !section.collapsed }}
              accessibilityHint={section.collapsed ? m.sessao_expandir() : m.sessao_recolher()}
            >
              {conteudo}
            </Pressable>
          );
        }}
        renderItem={({ item, section }) => (
          <SessionRow
            session={item}
            mostrarServidor={variosServidores && (section.attention || modo !== 'server')}
            onPress={() => abrir(item)}
            onGit={() => abrirGit(item)}
            onExcluir={() => excluir(item)}
            onRenomear={() => setRenomeando(item)}
            onResume={() => retomar(item)}
            aoAbrir={trocarAberta}
          />
        )}
        onScrollBeginDrag={() => trocarAberta(null)}
        ListEmptyComponent={busca ? vazio(m.lista_vazia_filtro(), null, true) : vazio(m.lista_nenhuma_ativa(), m.lista_toque_criar())}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    );
  }

  return (
    <>
      {/* Sem caixa: a lista fica direto sobre o fundo escolhido em Aparência, como no app de PC. */}
      <View style={styles.painel}>
        {topo}
        {campoBusca}
        <View style={styles.corpo}>{corpo}</View>
        {rodape}
      </View>
      <RenameSheet nome={renomeando?.name ?? null} onConfirmar={renomear} onFechar={() => setRenomeando(null)} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  painel: { flex: 1, marginHorizontal: theme.base.space[1], marginTop: 6, marginBottom: theme.base.space[2], paddingTop: theme.base.space[3], paddingHorizontal: theme.base.space[2], paddingBottom: 10 },
  topo: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingLeft: theme.base.space[2], paddingBottom: 6 },
  // encolhe a marca, não os botões: com texto ampliado o nome empurrava as ações para fora
  marca: { flexShrink: 1, fontSize: theme.base.text.base, fontWeight: '700' },
  topoAcoes: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto' },
  icone: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  campo: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 6, marginBottom: 6, paddingHorizontal: 10, borderRadius: theme.base.radius.md, borderWidth: 1, minHeight: 38 },
  input: { flex: 1, fontSize: theme.base.text.sm, paddingVertical: 8 },
  corpo: { flex: 1 },
  listContent: { flexGrow: 1, paddingBottom: theme.base.space[2] },
  navs: { paddingBottom: 4 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, paddingHorizontal: 10, borderRadius: theme.base.radius.md },
  navTxt: { flexShrink: 1, fontSize: theme.base.text.sm },
  navConta: { marginLeft: 'auto', fontSize: theme.base.text.xs },
  grupo: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 10, paddingBottom: 6, paddingHorizontal: 10, backgroundColor: 'transparent' },
  grupoTxt: { flexShrink: 1, fontSize: theme.base.text.xxs, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  grupoConta: { marginLeft: 'auto', fontSize: theme.base.text.xxs },
  ponto: { width: 7, height: 7, borderRadius: 4 },
  rodape: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: theme.base.space[2], paddingHorizontal: 6 },
  nova: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: theme.base.space[4], borderRadius: theme.base.radius.full },
  novaTxt: { fontSize: theme.base.text.sm, fontWeight: '600' },
  ativo: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto', flexShrink: 1, minWidth: 0 },
  ativoTxt: { flexShrink: 1, fontSize: theme.base.text.xxs },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: theme.base.space[6], gap: 8 },
  emptyTopo: { flex: 0, justifyContent: 'flex-start', paddingTop: theme.base.space[4] },
  emptyTitle: { fontSize: theme.base.text.lg, fontWeight: '600', color: theme.tokens.text.primary, textAlign: 'center' },
  emptyTxt: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted, textAlign: 'center' },
}));
