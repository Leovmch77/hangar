import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Platform, Pressable, Text, View, ScrollView } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { WebView } from 'react-native-webview';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import type { TextSelectionMenuConfig } from 'react-native-enriched-markdown';
import type { FileContent, PathDiff, Server } from '@hangar/core';
import { fileKind, fileUrlNative, fileAuthHeader, mensagemDeErro } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { EditDiff } from '../../chat/tools/EditDiff';
import { PdfReader } from '../attachments/DocumentViewer';
import { mkMarkdownStyle } from '../../chat/AssistantBubble';
import { toast } from '../../ui/Toast';

interface Props {
  path: string;
  conteudo: FileContent | null;
  diff: PathDiff | null;
  loading: boolean;
  erro?: string | null;
  escopo: 'branch' | 'nao_commitado';
  onEscopo: (e: 'branch' | 'nao_commitado') => void;
  onEditar: () => void;
  name: string; // sessão name para fileUrl
  server?: Server;
}

export function FileViewer(props: Props) {
  return <FileViewerContent key={`${props.server?.id ?? ''}::${props.name}::${props.path}`} {...props} />;
}

function openMarkdownLink({ url }: { url: string }) {
  if (!/^(https?|mailto):/i.test(url)) return;
  Linking.openURL(url).catch((error: unknown) => toast.erro(error instanceof Error ? error.message : String(error)));
}

function FileViewerContent({ path, conteudo, diff, loading, erro, escopo, onEscopo, onEditar, name, server }: Props) {
  const { theme } = useUnistyles();
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const [verArquivo, setVerArquivo] = useState(isMarkdown);
  const [showSource, setShowSource] = useState(false);
  const markdownStyle = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const selectionMenu = useMemo<TextSelectionMenuConfig>(() => ({
    copy: { label: m.selection_copy() },
    copyAsMarkdown: { label: m.selection_copy_markdown() },
    copyImageUrl: {
      label: m.selection_copy_image_url(),
      pluralLabels: { other: m.selection_copy_image_urls({ count: '{count}' }) },
    },
  }), []);
  const [webErro, setWebErro] = useState<string | null>(null);
  const [webCarregando, setWebCarregando] = useState(true);

  const doArquivo = conteudo && conteudo.path === path ? conteudo : null;
  const diffDoArquivo = diff && diff.path === path ? diff : null;
  const temDiff = !!diffDoArquivo && diffDoArquivo.diff.trim() !== '';
  const podeEditar = !!doArquivo && doArquivo.digest !== null;

  // html/pdf via WebView — modo nativo: token só no header GET, nunca na URL (BLOQUEADOR 1)
  // Guarda de carregamento/erro do WebView (BLOQUEADOR 4): nunca área vazia
  useEffect(() => {
    setWebErro(null);
    setWebCarregando(true);
  }, [path, name, server?.id]);

  const kind = fileKind(path);
  // PDF/imagem chegam sem texto (o backend recusa binário no /files/read); HTML precisa da leitura ok.
  const documento = (kind === 'html' && !!doArquivo) || ((kind === 'pdf' || kind === 'image') && !doArquivo && !loading && !erro);

  if (documento) {
    const uri = fileUrlNative(name, path, server);
    const headers = fileAuthHeader(server);
    const semToken = server ? !server.token : Object.keys(headers).length === 0;
    if (semToken) {
      return (
        <View style={styles.root}>
          <Text style={[styles.erro, { color: theme.tokens.status.error }]} accessibilityRole="alert">
            {m.sessao_expirada()}
          </Text>
        </View>
      );
    }
    if (kind === 'pdf' && Platform.OS === 'android') {
      return <PdfReader key={uri} uri={uri} headers={headers} name={path.split(/[\\/]/).pop()!} />;
    }
    return (
      <View style={styles.root}>
        <View style={[styles.bar, { borderBottomColor: theme.tokens.border.subtle }]}>
          <Text style={[styles.path, { color: theme.tokens.text.primary }]} numberOfLines={1}>
            {path}
          </Text>
        </View>
        {webCarregando && !webErro ? (
          <View style={styles.webLoading}>
            <ActivityIndicator color={theme.tokens.text.muted} />
            <Text style={[styles.aviso, { color: theme.tokens.text.muted }]}>{m.comum_carregando()}</Text>
          </View>
        ) : null}
        {webErro ? (
          <Text style={[styles.erro, { color: theme.tokens.status.error }]} accessibilityRole="alert">
            {webErro}
          </Text>
        ) : null}
        <WebView
          source={{ uri, headers }}
          style={styles.webview}
          onLoadStart={() => {
            setWebCarregando(true);
          }}
          onLoad={() => setWebCarregando(false)}
          onError={(e) => {
            setWebCarregando(false);
            setWebErro(e.nativeEvent.description || m.arquivo_carregar_erro());
          }}
          onHttpError={(e) => {
            setWebCarregando(false);
            const descricao = e.nativeEvent.description;
            setWebErro(descricao ? `HTTP ${e.nativeEvent.statusCode}: ${descricao}` : m.arquivo_carregar_erro());
          }}
        />
      </View>
    );
  }

  if (erro) {
    return (
      <View style={styles.root}>
        <Text style={[styles.erro, { color: theme.tokens.status.error }]} accessibilityRole="alert">
          {erro}
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.root}>
        <Text style={[styles.aviso, { color: theme.tokens.text.muted }]}>{m.git_diff_carregando()}</Text>
      </View>
    );
  }

  // sem arquivo ainda
  if (!doArquivo && !temDiff) {
    return (
      <View style={styles.root}>
        <Text style={[styles.aviso, { color: theme.tokens.text.muted }]}>{m.arq_sem_mudanca()}</Text>
      </View>
    );
  }

  const caiu = diffDoArquivo !== null && diffDoArquivo.escopo_usado !== diffDoArquivo.escopo_pedido;
  const motivoVisivel =
    caiu && diffDoArquivo?.motivo ? (mensagemDeErro(diffDoArquivo.motivo) ?? diffDoArquivo.motivo) : null;

  const diffTruncated = diffDoArquivo?.truncated ?? false;
  const arquivoTruncated = doArquivo?.truncated ?? false;

  return (
    <View style={styles.root}>
      {/* header */}
      <View style={[styles.bar, { borderBottomColor: theme.tokens.border.subtle }]}>
        <Text style={[styles.path, { color: theme.tokens.text.primary }]} numberOfLines={1}>
          {path}
        </Text>
        {podeEditar ? (
          <Pressable onPress={onEditar} style={styles.editBtn} accessibilityRole="button" accessibilityLabel={m.arq_editar()}>
            <Text style={[styles.editTxt, { color: theme.tokens.accent.base }]}>{m.arq_editar()}</Text>
          </Pressable>
        ) : null}
      </View>

      {/* toggle arquivo / alterações */}
      {temDiff && diffDoArquivo ? (
        <View style={styles.segRow}>
          <View style={[styles.seg, { borderColor: theme.tokens.border.subtle }]}>
            <Pressable
              onPress={() => setVerArquivo(false)}
              style={[styles.segBtn, !verArquivo ? { backgroundColor: theme.tokens.accent.dim } : null]}
            >
              <Text style={{ color: !verArquivo ? theme.tokens.accent.base : theme.tokens.text.secondary, fontSize: theme.base.text.xs }}>{m.arq_ver_alteracoes()}</Text>
            </Pressable>
            <Pressable
              onPress={() => setVerArquivo(true)}
              style={[styles.segBtn, verArquivo ? { backgroundColor: theme.tokens.accent.dim } : null]}
            >
              <Text style={{ color: verArquivo ? theme.tokens.accent.base : theme.tokens.text.secondary, fontSize: theme.base.text.xs }}>{m.arq_ver_arquivo()}</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={() => onEscopo(escopo === 'branch' ? 'nao_commitado' : 'branch')}
            disabled={!!caiu}
            style={styles.escopoBtn}
          >
            <Text style={[styles.escopoTxt, { color: theme.tokens.text.muted }]}>
              {diffDoArquivo.base ? m.arq_escopo_desde({ base: diffDoArquivo.base.slice(0, 7) }) : escopo === 'branch' ? m.arq_escopo_branch() : m.arq_escopo_nao_commitado()}
            </Text>
          </Pressable>
          {motivoVisivel ? <Text style={[styles.motivo, { color: theme.tokens.status.warning }]}>{motivoVisivel}</Text> : null}
        </View>
      ) : (
        <View style={styles.metaRow}>
          <Pressable
            onPress={() => onEscopo(escopo === 'branch' ? 'nao_commitado' : 'branch')}
            disabled={!!caiu}
            style={styles.escopoBtn}
          >
            <Text style={[styles.escopoTxt, { color: theme.tokens.text.muted }]}>
              {diffDoArquivo?.base ? m.arq_escopo_desde({ base: diffDoArquivo.base.slice(0, 7) }) : escopo === 'branch' ? m.arq_escopo_branch() : m.arq_escopo_nao_commitado()}
            </Text>
          </Pressable>
        </View>
      )}

      {arquivoTruncated ? <Text style={[styles.aviso, { color: theme.tokens.status.warning }]}>{m.arq_arquivo_cortado()}</Text> : null}
      {diffTruncated && temDiff && !verArquivo ? <Text style={[styles.aviso, { color: theme.tokens.status.warning }]}>{m.arq_diff_cortado()}</Text> : null}

      {isMarkdown && doArquivo && (!temDiff || verArquivo) ? (
        <View style={styles.segRow}>
          <View style={[styles.seg, { borderColor: theme.tokens.border.subtle }]}>
            {([
              { source: false, label: m.mobile_file_page() },
              { source: true, label: m.native_file_source() },
            ]).map(option => (
              <Pressable
                key={option.label}
                onPress={() => setShowSource(option.source)}
                accessibilityRole="button"
                accessibilityState={{ selected: showSource === option.source }}
                style={[styles.modeBtn, showSource === option.source ? { backgroundColor: theme.tokens.accent.dim } : null]}
              >
                <Text style={{ color: theme.tokens.text.primary, fontSize: theme.base.text.xs }}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {/* conteúdo */}
      {temDiff && !verArquivo && diffDoArquivo ? (
        <ScrollView style={styles.scroll}>
          <EditDiff oldText={diffDoArquivo.original ?? ''} newText={doArquivo?.text ?? ''} />
          {/* fallback: sem o original (só o patch), mostra o diff cru */}
          {diffDoArquivo.original === null && diffDoArquivo.diff ? (
            <Text style={[styles.mono, { color: theme.tokens.text.secondary }]} selectable>
              {diffDoArquivo.diff}
            </Text>
          ) : null}
        </ScrollView>
      ) : doArquivo && isMarkdown && !showSource ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.markdown}>
          {doArquivo.text.trim() ? (
            <EnrichedMarkdownText
              markdown={doArquivo.text}
              markdownStyle={markdownStyle}
              flavor="github"
              onLinkPress={openMarkdownLink}
              selectionMenuConfig={selectionMenu}
            />
          ) : <Text style={[styles.aviso, { color: theme.tokens.text.muted }]}>{m.native_file_empty()}</Text>}
        </ScrollView>
      ) : doArquivo ? (
        <FileSource text={doArquivo.text} />
      ) : null}
    </View>
  );
}

const lineKey = (_line: string, index: number) => String(index);

const FileSource = memo(function FileSource({ text }: { text: string }) {
  const { theme } = useUnistyles();
  const lines = useMemo(() => text === '' ? [] : text.replace(/\n$/, '').split('\n'), [text]);
  const renderLine = useCallback(({ item, index }: ListRenderItemInfo<string>) => (
    <View style={styles.lineRow}>
      <Text style={[styles.lineNo, { color: theme.tokens.text.muted }]}>{index + 1}</Text>
      <Text style={[styles.lineTxt, { color: theme.tokens.text.primary }]} selectable>{item || ' '}</Text>
    </View>
  ), [theme]);
  return (
    <FlatList
      style={styles.scroll}
      contentContainerStyle={styles.codeView}
      data={lines}
      renderItem={renderLine}
      keyExtractor={lineKey}
      initialNumToRender={24}
      maxToRenderPerBatch={24}
      windowSize={5}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.tokens.bg.base,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.base.space[3],
    paddingVertical: theme.base.space[2],
    borderBottomWidth: 1,
    gap: theme.base.space[2],
  },
  path: {
    flex: 1,
    fontSize: theme.base.text.xs,
    fontWeight: '500',
  },
  editBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: theme.tokens.accent.dim,
  },
  editTxt: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  segRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: theme.base.space[3],
    paddingVertical: 6,
  },
  metaRow: {
    flexDirection: 'row',
    paddingHorizontal: theme.base.space[3],
    paddingVertical: 4,
  },
  seg: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  modeBtn: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  markdown: {
    padding: theme.base.space[3],
  },
  escopoBtn: {
    paddingHorizontal: 6,
  },
  escopoTxt: {
    fontSize: theme.base.text.xxs,
  },
  motivo: {
    fontSize: theme.base.text.xxs,
    flex: 1,
  },
  aviso: {
    fontSize: theme.base.text.xs,
    paddingHorizontal: theme.base.space[3],
    paddingVertical: 4,
  },
  erro: {
    fontSize: theme.base.text.xs,
    padding: theme.base.space[3],
  },
  scroll: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  webLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: theme.base.space[3],
  },
  codeView: {
    padding: theme.base.space[2],
  },
  lineRow: {
    flexDirection: 'row',
    gap: 8,
  },
  lineNo: {
    width: 32,
    textAlign: 'right',
    fontSize: theme.base.text.xxs,
    fontFamily: theme.base.fontMono,
  },
  lineTxt: {
    flex: 1,
    fontSize: theme.base.text.xs,
    fontFamily: theme.base.fontMono,
  },
  mono: {
    fontSize: theme.base.text.xxs,
    fontFamily: theme.base.fontMono,
    padding: theme.base.space[3],
  },
}));
