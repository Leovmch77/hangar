import { memo, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { UnistylesThemes } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import type { MarkdownStyle } from 'react-native-enriched-markdown';
import { useRouter } from 'expo-router';
import { fileUrlNative, fileAuthHeader, fileKind, lerTabelaMarkdown, parseCodePaths, parseFilePaths, proposedPlan, planDisplayText } from '@hangar/core';
import * as m from '../paraglide/messages';
import { TableChart } from './TableChart';
import { ArquivoChip } from './ArquivoChip';
import { BubbleActions } from './BubbleActions';
import { getTableChartPref, setTableChartPref } from './tableChartPref';
import { superficie } from '../theme/superficie';
import { Icon, type IconName } from '../ui/Icon';
import { useAparencia } from '../stores/aparencia';

// Tema completo do unistyles (tokens + base) — UnistylesTheme não é exportado na raiz.
type TemaApp = UnistylesThemes[keyof UnistylesThemes];

// Entrelinha de fábrica de cada bloco da lib (normalizeMarkdownStyle): a escala da Aparência anda
// em cima dela, para 100% continuar igual ao que era.
const ios = Platform.OS === 'ios';
const LH = {
  p: ios ? 24 : 26, h1: ios ? 36 : 38, h2: ios ? 30 : 32, h3: ios ? 26 : 28, h4: ios ? 24 : 26,
  h5: ios ? 22 : 24, h6: ios ? 20 : 22, quote: ios ? 24 : 26, list: ios ? 22 : 26, code: ios ? 20 : 22,
};
const CODIGO_FABRICA = 14;

// Tema do markdown mapeado dos tokens do app (cores/links/code) — a lib recebe um
// MarkdownStyle plano; sem ele usa defaults pretos que somem no tema escuro.
// Tamanho, entrelinha e código vêm de Aparência › Texto da conversa (`theme.conversa`).
export function mkMarkdownStyle(t: TemaApp): MarkdownStyle {
  const { texto, linha, codigo } = t.conversa;
  const bloco = (size: number, lh: number) => ({ fontSize: size * texto, lineHeight: Math.round(lh * texto * linha) });
  return {
    paragraph: { color: t.tokens.text.primary, ...bloco(t.base.text.base, LH.p) },
    h1: { color: t.tokens.text.primary, ...bloco(t.base.text.xl, LH.h1), fontWeight: '700' },
    h2: { color: t.tokens.text.primary, ...bloco(t.base.text.lg, LH.h2), fontWeight: '700' },
    h3: { color: t.tokens.text.primary, ...bloco(t.base.text.base, LH.h3), fontWeight: '600' },
    h4: { color: t.tokens.text.primary, ...bloco(t.base.text.base, LH.h4), fontWeight: '600' },
    h5: { color: t.tokens.text.primary, ...bloco(t.base.text.sm, LH.h5), fontWeight: '600' },
    h6: { color: t.tokens.text.secondary, ...bloco(t.base.text.sm, LH.h6), fontWeight: '600' },
    link: { color: t.tokens.accent.base, underline: true },
    strong: { color: t.tokens.text.primary },
    em: { color: t.tokens.text.primary },
    // Código inline é pílula na cor de destaque, sem contorno: sem `borderColor` a lib desenha a
    // borda rosa de fábrica, que corta a frase em caixinhas.
    code: {
      fontFamily: t.base.fontMono,
      fontSize: codigo,
      color: t.tokens.accent.base,
      backgroundColor: t.tokens.accent.dim,
      borderColor: 'transparent',
    },
    codeBlock: {
      fontFamily: t.base.fontMono,
      fontSize: codigo,
      lineHeight: Math.round((LH.code * codigo) / CODIGO_FABRICA),
      color: t.tokens.text.primary,
      backgroundColor: superficie(t),
      borderColor: t.tokens.border.subtle,
      borderWidth: 1,
      borderRadius: t.base.radius.sm,
      padding: t.base.space[2],
      syntaxColors: {
        keyword: t.tokens.accent.base,
        string: t.tokens.status.success,
        number: t.tokens.status.warning,
        constant: t.tokens.status.warning,
        function: t.tokens.accent.base,
        type: t.tokens.accent.base,
        property: t.tokens.text.secondary,
        tag: t.tokens.accent.base,
        attribute: t.tokens.text.secondary,
        comment: t.tokens.text.muted,
      },
    },
    blockquote: { borderColor: t.tokens.border.default, backgroundColor: 'transparent', color: t.tokens.text.secondary, ...bloco(t.base.text.base, LH.quote) },
    list: { bulletColor: t.tokens.text.muted, color: t.tokens.text.primary, ...bloco(t.base.text.base, LH.list) },
    table: {
      headerBackgroundColor: superficie(t, 0.8),
      headerTextColor: t.tokens.text.primary,
      // Sem estas duas a biblioteca pinta as linhas de branco, e o texto claro do tema some nelas.
      rowEvenBackgroundColor: 'transparent',
      rowOddBackgroundColor: superficie(t, 0.3),
      borderColor: t.tokens.border.subtle,
      borderWidth: 1,
      color: t.tokens.text.primary,
    },
  };
}

export const AssistantBubble = memo(function AssistantBubble({
  text,
  sessionName,
  serverId,
  ts,
}: {
  text: string;
  sessionName?: string;
  serverId?: string;
  ts?: number | null;
}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const proposed = useMemo(() => proposedPlan(text), [text]);
  const display = useMemo(() => planDisplayText(text), [text]);
  const md = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const refs = useMemo(() => parseFilePaths(text), [text]);
  const hasRefs = refs.length > 0 && !!sessionName;
  // Arquivo de CÓDIGO citado na prosa (o parseFilePaths acima só pega mídia/pdf/html, que viram
  // miniatura). Só vira chip quando dá pra abrir na aba Arquivos. O `fileKind` tira a mídia daqui:
  // com extensão aberta no absoluto o `parseCodePaths` casa `.png` e o arquivo saía nos dois.
  const codigos = useMemo(() => parseCodePaths(text).filter((p) => !fileKind(p)), [text]);
  const hasCodigos = codigos.length > 0 && !!sessionName && !!serverId;
  const tabelas = useMemo(() => lerTabelaMarkdown(display), [display]);
  const [pref, setPref] = useState(() => getTableChartPref());
  // Aparência › Gráfico nas tabelas: desligado, nem o botão aparece.
  const grafico = useAparencia((s) => s.graficoTabela);
  const [colIndices, setColIndices] = useState<number[]>(() => tabelas.map(() => 0));
  useEffect(() => {
    if (colIndices.length !== tabelas.length) setColIndices(tabelas.map(() => 0));
  }, [tabelas.length, colIndices.length]);

  return (
    <View style={styles.wrap}>
      {proposed ? <Text style={styles.planLabel}>{m.chat_plan_proposto()}</Text> : null}
      <EnrichedMarkdownText markdown={display} markdownStyle={md} flavor="github" />
      {grafico && tabelas.length > 0 ? (
        <View style={styles.tableBlock}>
          <Pressable
            onPress={() => {
              const next = pref === 'chart' ? 'table' : 'chart';
              setPref(next);
              setTableChartPref(next);
            }}
            style={[styles.chartBtn, { borderColor: theme.tokens.border.subtle, backgroundColor: superficie(theme) }]}
            accessibilityRole="button"
          >
            <Text style={[styles.chartBtnText, { color: theme.tokens.accent.base }]}>
              {pref === 'chart' ? m.tabela_botao_tabela() : m.tabela_botao_grafico()}
            </Text>
          </Pressable>
          {pref === 'chart'
            ? tabelas.map((t, idx) => (
                <TableChart
                  key={idx}
                  tabela={t}
                  coluna={colIndices[idx] ?? 0}
                  onColuna={(c) =>
                    setColIndices((prev) => {
                      const copy = [...prev];
                      copy[idx] = c;
                      return copy;
                    })
                  }
                />
              ))
            : null}
        </View>
      ) : null}
      {hasRefs ? (
        <View style={styles.atts}>
          {refs.map((r) => {
            const isImg = r.kind === 'image';
            const uri = r.url ?? fileUrlNative(sessionName!, r.path);
            const headers = r.url ? undefined : fileAuthHeader();
            if (isImg) {
              return <Image key={r.path} source={{ uri, headers }} style={styles.thumb} contentFit="cover" transition={150} />;
            }
            const icon: IconName = r.kind === 'pdf' ? 'FileText' : r.kind === 'html' ? 'Globe' : r.kind === 'audio' ? 'Music' : 'Paperclip';
            return (
              <View key={r.path} style={[styles.chip, { backgroundColor: superficie(theme), borderColor: theme.tokens.border.subtle }]}>
                <Icon name={icon} size={14} color={theme.tokens.text.secondary} />
                <Text style={[styles.chipName, { color: theme.tokens.text.primary }]} numberOfLines={1}>
                  {r.name}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {hasCodigos ? (
        <View style={styles.atts}>
          {codigos.map((p) => (
            <ArquivoChip
              key={p}
              caminho={p}
              onPress={() => router.push(`/s/${serverId}/${sessionName}/files?path=${encodeURIComponent(p)}` as never)}
            />
          ))}
        </View>
      ) : null}
      <BubbleActions text={text} ts={ts} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  planLabel: {
    color: theme.tokens.accent.base,
    fontSize: theme.base.text.sm,
    fontWeight: '600',
  },
  // Sem bolha, como no nativo: texto corrido na largura toda. Só tabela, código e anexo têm caixa,
  // e essa caixa vem da superficie() para seguir Transparência e Solidez.
  wrap: {
    alignSelf: 'stretch',
    gap: theme.base.space[2],
  },
  atts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.base.space[2],
    marginTop: theme.base.space[1],
  },
  thumb: {
    width: 96,
    height: 96,
    borderRadius: theme.base.radius.md,
    backgroundColor: superficie(theme),
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[1],
    paddingHorizontal: theme.base.space[2],
    paddingVertical: theme.base.space[1],
    borderRadius: theme.base.radius.md,
    borderWidth: 1,
    maxWidth: 220,
  },
  chipName: {
    fontSize: theme.base.text.xs,
    flexShrink: 1,
  },
  tableBlock: {
    gap: theme.base.space[2],
    marginTop: theme.base.space[1],
  },
  chartBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.base.space[3],
    paddingVertical: theme.base.space[1],
    borderRadius: theme.base.radius.full,
    borderWidth: 1,
  },
  chartBtnText: {
    fontSize: theme.base.text.sm,
    fontWeight: '600',
  },
}));
