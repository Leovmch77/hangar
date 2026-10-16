import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
import { mermaidFailureText, mermaidSourceTooLong, pngDataUri, renderMermaid, type MermaidFailure, type MermaidResult } from '@hangar/core';
import * as m from '../paraglide/messages';
import { LightboxModal } from '../features/attachments/LightboxModal';
import { useServers } from '../stores/servers';

// Bloco ```mermaid de uma resposta pronta: a imagem que o servidor desenha, no tema do app e na
// largura da coluna. Enquanto desenha e no erro, o código continua à mostra; o toque abre o visor.
// Fonte vazia não vira bloco; fonte acima do teto avisa sem pedir ao servidor. As duas checagens
// ficam aqui, apesar de o core também recusá-las, porque a resposta é síncrona: sem elas o bloco
// vazio virava uma cerca sem código e o longo passava por "Desenhando…" à espera da largura.
const TOO_LONG: MermaidFailure = { kind: 'too_long', code: 'fonte_longa', message: '' };

export function MermaidBlock({ source, serverId, md }: { source: string; serverId?: string; md: MarkdownStyle }) {
  const { theme, rt } = useUnistyles();
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const themeName = rt.themeName === 'light' ? 'light' : 'dark';
  const empty = !source.trim();
  const tooLong = !empty && mermaidSourceTooLong(source);
  const [width, setWidth] = useState(0);
  const [result, setResult] = useState<MermaidResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Só o toque em "Tentar de novo" pula o cache; troca de tema ou de largura pede normalmente.
  const forceRef = useRef(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!width || empty || tooLong) return;
    let alive = true;
    setResult(null);
    const retry = forceRef.current;
    forceRef.current = false;
    void renderMermaid(source, themeName, server, retry).then((r) => { if (alive) setResult(r); });
    return () => { alive = false; };
  }, [source, themeName, width, server, attempt, empty, tooLong]);

  const shown = tooLong ? TOO_LONG : result;
  const uri = useMemo(() => (shown?.kind === 'image' ? pngDataUri(shown.png) : ''), [shown]);
  const code = useMemo(() => `\`\`\`mermaid\n${source}\n\`\`\``, [source]);
  if (empty) return null;
  // 404 e recusa ao convidado: `null`, sem linha nenhuma, só o código.
  const failure = shown && shown.kind !== 'image' ? mermaidFailureText(shown) : null;

  return (
    <View style={styles.wrap} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      {shown?.kind === 'image' ? (
        <>
          <Pressable onPress={() => setOpen(true)} accessibilityRole="imagebutton" accessibilityLabel={m.mermaid_open()}>
            <Image
              source={{ uri }}
              accessibilityLabel={m.mermaid_alt()}
              contentFit="contain"
              style={{ width: Math.min(width, shown.width), aspectRatio: shown.width / shown.height }}
            />
          </Pressable>
          <LightboxModal
            media={open ? { uri, filename: m.mermaid_file(), imageBackground: theme.tokens.bg.base } : null}
            onClose={() => setOpen(false)}
          />
        </>
      ) : (
        <>
          {!shown ? (
            <Text style={[styles.status, { color: theme.tokens.text.muted }]} accessibilityLiveRegion="polite">{m.mermaid_drawing()}</Text>
          ) : failure ? (
            <View style={styles.failure}>
              <Text style={[styles.failureText, { color: theme.tokens.status.error }]} accessibilityRole="alert">{failure}</Text>
              {shown?.kind === 'unavailable' ? (
                <Pressable
                  onPress={() => { forceRef.current = true; setAttempt((n) => n + 1); }}
                  style={[styles.retry, { borderColor: theme.tokens.border.subtle }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.retryTxt, { color: theme.tokens.accent.base }]}>{m.mermaid_retry()}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <EnrichedMarkdownText markdown={code} markdownStyle={md} flavor="github" />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { alignSelf: 'stretch', gap: theme.base.space[1] },
  status: { fontSize: theme.base.text.sm },
  failure: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.base.space[2] },
  failureText: { fontSize: theme.base.text.sm, flexShrink: 1 },
  retry: {
    minHeight: 40,
    paddingHorizontal: theme.base.space[3],
    borderRadius: theme.base.radius.full,
    borderWidth: 1,
    justifyContent: 'center',
  },
  retryTxt: { fontSize: theme.base.text.sm, fontWeight: '600' },
}));
