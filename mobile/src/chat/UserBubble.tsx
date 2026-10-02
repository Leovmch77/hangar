import { memo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ImageThumb, type MediaItem } from './ImageThumb';
import { parseImageMessage, parseRealtimeDelegation, transcriptImageUrlNative, uploadUrlNative, fileAuthHeader } from '@hangar/core';
import * as m from '../paraglide/messages';
import { BubbleActions } from './BubbleActions';
import { superficie } from '../theme/superficie';

// Bolha do usuário: pequena, à direita, no fundo superficie(0.8) — o mesmo degrau da bolha do nativo,
// e por isso acompanha Transparência e Solidez. Se parseImageMessage(text) não nulo → legenda +
// miniaturas. As ações (copiar, compartilhar) não ficam à mostra: o toque longo abre a linha embaixo.
export const UserBubble = memo(function UserBubble({ text, sessionName, ts, eventId, imageCount = 0 }: {
  text: string;
  sessionName?: string;
  ts?: number | null;
  eventId?: string;
  /** Imagens coladas no TERMINAL: vêm do transcript por /transcript-image, não do texto. */
  imageCount?: number;
}) {
  const { theme } = useUnistyles();
  const voice = parseRealtimeDelegation(text);
  const [showOriginal, setShowOriginal] = useState(false);
  const [acoes, setAcoes] = useState(false);
  const parsed = parseImageMessage(text);
  const doTerminal = imageCount > 0 && !!sessionName && !!eventId;
  const hasImages = (!!parsed && !!sessionName) || doTerminal;
  const caption = parsed ? parsed.caption : doTerminal ? text : '';
  // Como no web: com o caminho escrito pra TODAS as fotos, as últimas `imageCount` já vêm do
  // transcript, e mostrar as duas fontes duplicava cada imagem.
  const filenames = !parsed || !sessionName ? []
    : doTerminal && parsed.marcadores === parsed.filenames.length
      ? parsed.filenames.slice(0, Math.max(0, parsed.filenames.length - imageCount))
      : parsed.filenames;
  const galeria: MediaItem[] = hasImages ? [
    ...filenames.map((fn): MediaItem => ({ uri: uploadUrlNative(sessionName!, fn), headers: fileAuthHeader(), name: fn, kind: 'image' })),
    ...(doTerminal ? Array.from({ length: imageCount }, (_, i): MediaItem => ({
      uri: transcriptImageUrlNative(sessionName!, eventId!, i), headers: fileAuthHeader(), name: m.anexos_imagem_enviada(), kind: 'image',
    })) : []),
  ] : [];
  const alternar = () => setAcoes((v) => !v);

  // O texto não é `selectable`: no Android a seleção come o toque longo que abre as ações, e copiar
  // já está lá.
  const bolha = (conteudo: ReactNode, textoAcoes: string, voz = false) => (
    <View style={[styles.col, voz && styles.colVoz]}>
      <Pressable
        onLongPress={alternar}
        delayLongPress={350}
        style={[styles.bubble, voz && styles.voice]}
        accessibilityActions={[{ name: 'longpress', label: m.navbar_mais_acoes() }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'longpress') alternar(); }}
      >
        {conteudo}
      </Pressable>
      {acoes ? <BubbleActions text={textoAcoes} ts={ts} ouvir={false} defaultOpen align={voz ? 'start' : 'end'} /> : null}
    </View>
  );

  if (voice) {
    return bolha(
      <>
        <Text style={[styles.voiceLabel, { color: theme.tokens.text.secondary }]}>{m.voice_message_origin()}</Text>
        <Text style={[styles.txt, { color: theme.tokens.text.primary }]}>{voice.input}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showOriginal }}
          onPress={() => setShowOriginal(value => !value)} style={styles.detailsButton}>
          <Text style={{ color: theme.tokens.text.secondary }}>{m.voice_message_original()}</Text>
        </Pressable>
        {showOriginal ? <Text style={[styles.txt, { color: theme.tokens.text.secondary }]}>{text}</Text> : null}
      </>,
      voice.input,
      true,
    );
  }

  // Se há imagens válidas, exibe legenda + thumbnails; senão fallback texto cru
  if (hasImages) {
    // galeria vazia = foto única absorvida como anexo real: mostra só a legenda, ou o texto original
    if (galeria.length === 0) {
      const display = caption || text;
      return bolha(<Text style={[styles.txt, { color: theme.tokens.text.primary }]}>{display}</Text>, display);
    }
    return bolha(
      <>
        {caption ? <Text style={[styles.txt, { color: theme.tokens.text.primary }]}>{caption}</Text> : null}
        <View style={styles.thumbs}>
          {galeria.map((g, i) => <ImageThumb key={g.uri} items={galeria} index={i} style={styles.thumb} />)}
        </View>
      </>,
      caption || text,
    );
  }

  return bolha(<Text style={[styles.txt, { color: theme.tokens.text.primary }]}>{text}</Text>, text);
});

const styles = StyleSheet.create((theme) => ({
  col: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
    maxWidth: '82%',
    gap: theme.base.space[1],
  },
  colVoz: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: {
    backgroundColor: superficie(theme, 0.8),
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: theme.base.space[2],
    gap: theme.base.space[2],
  },
  txt: {
    fontSize: theme.base.text.base * theme.conversa.texto,
  },
  // Delegação por voz: borda fina em vez de cor, que fica para estado e aviso.
  voice: { borderWidth: 1, borderColor: theme.tokens.border.default },
  voiceLabel: { fontWeight: '600', fontSize: theme.base.text.sm },
  detailsButton: { minHeight: 44, justifyContent: 'center' },
  thumbs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.base.space[2],
  },
  thumb: {
    width: 96,
    height: 96,
    borderRadius: theme.base.radius.md,
    backgroundColor: superficie(theme, 0.8),
  },
}));
