import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import { broadcast, formataErro, uploadFile, transcribeFile, steerSession, podeEnviarSozinho } from '@hangar/core';
import type { MotivoFim } from '@hangar/core';
import { Glass } from '../ui/Glass';
import { Icon } from '../ui/Icon';
import { MultilineInput } from '../ui/MultilineInput';
import * as m from '../paraglide/messages';
import { chatStore, filaCount as filaCountOf } from '../stores/chat';
import { confirmFirstInput, readFirstInput, sendFirstInput, useNewConversation } from '../stores/newConversation';
import { useSessions } from '../stores/sessions';
import { clearDraft, clearRecoverableDraft, readRecoverableDraft, resolveDraftTranscript, writeDraft, writeRecoverableDraft, type ConversationDraft } from '../stores/drafts';
import { useRouter } from 'expo-router';
import { ModelPill } from '../features/pills/ModelPill';
import { EffortPill } from '../features/pills/EffortPill';
import { PermissionPill } from '../features/pills/PermissionPill';
import { EstiloPill } from '../features/ditado/EstiloPill';
import { useDitado } from '../features/ditado/useDitado';
import { useDitadoEstiloStore } from '../features/ditado/ditadoEstiloStore';
import { PillMenu } from '../features/pills/PillMenu';
import { CommandSheet } from './CommandSheet';
import { comandoParcial } from './comandoParcial';
import { superficie } from '../theme/superficie';

interface Props {
  serverId: string;
  name: string;
  draft?: string;
  firstInputId?: string;
  firstInputSent?: boolean;
  sessionProvider?: string | null;
  onStop?: () => void;
  stopping?: boolean;
}

type PendingAttach = {
  uri: string;
  name: string;
  mime: string;
  kind: 'image' | 'file';
  size?: number;
};

type DraftLoad = { draft: ConversationDraft | null; recoverable: ConversationDraft | null; issue: string; blocked: boolean };

function loadDraft(serverId: string, name: string, transcript: string | null): DraftLoad {
  let resolved: ReturnType<typeof resolveDraftTranscript>;
  try {
    resolved = resolveDraftTranscript(serverId, name, transcript);
  } catch (e) {
    const issue = e instanceof Error ? e.message : m.draft_read_error();
    // Formato inválido não tem o que salvar; falha de leitura bloqueia gravar para não apagar o guardado.
    return { draft: null, recoverable: null, issue, blocked: issue !== m.draft_invalid() };
  }
  try {
    const recoverable = resolved.recoverable
      ? keepRecoverable(serverId, name, resolved.recoverable)
      : readRecoverableDraft(serverId, name);
    return { draft: resolved.draft, recoverable, issue: '', blocked: false };
  } catch (e) {
    // Com o antigo ainda só na chave principal, gravar o texto novo o apagaria.
    return { draft: resolved.draft, recoverable: null, issue: e instanceof Error ? e.message : m.draft_read_error(), blocked: !!resolved.recoverable };
  }
}

const joinDrafts = (before: string, after: string) => (before.trim() && after.trim() ? `${before}\n${after}` : before.trim() ? before : after);

// Guarda o antigo antes de a sessão recriada gravar; um pendente de outra recriação é somado, nunca trocado.
function keepRecoverable(serverId: string, name: string, old: ConversationDraft): ConversationDraft {
  const pending = readRecoverableDraft(serverId, name);
  if (pending && pending.transcript === old.transcript && pending.revision === old.revision) return pending;
  const value = pending ? { ...old, text: joinDrafts(pending.text, old.text), attachment: old.attachment ?? pending.attachment } : old;
  writeRecoverableDraft(serverId, name, value);
  return value;
}

export function Composer({ serverId, name, draft, firstInputId, firstInputSent = false, sessionProvider, onStop, stopping = false }: Props) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const chat = chatStore(serverId, name);
  const pending = chat.use((s) => s.pending);
  const events = chat.use((s) => s.events);
  const state = chat.use((s) => s.stateEvent?.state ?? 'idle');
  const detectedProvider = useSessions((s) => {
    const byServer = s.byServerRecord?.[serverId];
    if (byServer) {
      const hit = byServer.find((x) => x.name === name);
      if (hit?.provider) return hit.provider;
    }
    return (s.rows.find((x) => x.serverId === serverId && x.name === name)?.provider ?? null) as string | null;
  });
  const provider = sessionProvider ?? detectedProvider;
  const pairPeers = useSessions((s) => {
    const byServer = s.byServerRecord?.[serverId];
    return byServer?.find((x) => x.name === name)?.pair_peers ?? s.rows.find((x) => x.name === name)?.pair_peers ?? null;
  });
  const pairPeersKey = pairPeers?.join('\u0000') ?? '';
  const isCodex = provider === 'codex';
  const filaCount = filaCountOf({ events, pending }, provider);

  const [sendToPair, setSendToPair] = useState(false);
  useEffect(() => {
    setSendToPair(false);
  }, [pairPeersKey]);

  // O Composer remonta por rota (key): a origem da montagem é o destino de toda gravação dele.
  const origin = useRef({ serverId, name }).current;
  const transcript = useSessions((s) => (s.byServerRecord?.[origin.serverId]?.find((x) => x.name === origin.name)?.jsonl
    ?? s.rows.find((x) => x.serverId === origin.serverId && x.name === origin.name)?.jsonl) || null);
  const transcriptRef = useRef(transcript);
  const [boot] = useState(() => loadDraft(origin.serverId, origin.name, transcript));
  const draftRef = useRef<ConversationDraft | null>(boot.draft);
  const blockedRef = useRef(boot.blocked);
  const [readBlocked, setReadBlocked] = useState(boot.blocked);
  const [draftIssue, setDraftIssue] = useState(boot.issue);
  const [recoverable, setRecoverable] = useState(boot.recoverable);
  // Rascunho guardado é mais novo que o texto de handoff/cancelamento que a rota ainda carrega.
  const adoptedDraftRef = useRef(draft);
  const [text, setText] = useState(() => boot.draft?.text || draft || '');
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const persistText = useCallback((next: string): boolean => {
    if (blockedRef.current) return false;
    const current = draftRef.current;
    const value: ConversationDraft = current
      ? { ...current, text: next, revision: current.revision + 1, transcript: current.transcript ?? transcriptRef.current }
      : { version: 1, text: next, revision: 1, transcript: transcriptRef.current, attachment: null, submission: null };
    try {
      if (!next && !value.attachment && !value.submission) clearDraft(origin.serverId, origin.name);
      else writeDraft(origin.serverId, origin.name, value);
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_write_error());
      return false;
    }
    draftRef.current = value;
    setDraftIssue('');
    return true;
  }, [origin]);

  useEffect(() => {
    if ((draftRef.current?.text ?? '') !== text) persistText(text);
  }, [text, persistText]);

  // null → caminho é a primeira confirmação (Codex iniciando); caminho → outro é sessão recriada.
  useEffect(() => {
    transcriptRef.current = transcript;
    const known = draftRef.current?.transcript;
    if (transcript === null || blockedRef.current || known === undefined || known === transcript) return;
    try {
      const { draft: kept, recoverable: old } = resolveDraftTranscript(origin.serverId, origin.name, transcript);
      if (old) {
        // Gravação que falhou deixou o campo à frente do guardado: conservar o que está na tela.
        const latest = draftRef.current?.text === textRef.current ? old : { ...old, text: textRef.current };
        const kept = keepRecoverable(origin.serverId, origin.name, latest);
        draftRef.current = null;
        setRecoverable(kept);
        setText('');
      } else {
        draftRef.current = kept ?? (draftRef.current && { ...draftRef.current, transcript });
      }
    } catch (e) {
      // Sem onde conservar o antigo, gravar o texto novo o apagaria.
      blockedRef.current = true;
      setReadBlocked(true);
      setDraftIssue(e instanceof Error ? e.message : m.draft_read_error());
    }
  }, [transcript, origin]);

  const handleRecoverDraft = useCallback(() => {
    if (!recoverable) return;
    const next = joinDrafts(textRef.current, recoverable.text);
    if (!persistText(next)) return;
    try {
      clearRecoverableDraft(origin.serverId, origin.name);
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_clear_error());
    }
    setRecoverable(null);
    setText(next);
    setSelection({ start: next.length, end: next.length });
  }, [recoverable, persistText, origin]);

  const handleDiscardDraft = useCallback(() => {
    try {
      clearRecoverableDraft(origin.serverId, origin.name);
      // Nada gravado desde a recriação: a chave principal ainda é o antigo e o reofereceria.
      if (!draftRef.current) clearDraft(origin.serverId, origin.name);
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_clear_error());
      return;
    }
    setRecoverable(null);
  }, [origin]);

  const handleRereadDraft = useCallback(() => {
    const load = loadDraft(origin.serverId, origin.name, transcriptRef.current);
    setDraftIssue(load.issue);
    if (load.blocked) return;
    // Texto igual ao último guardado não foi digitado no bloqueio: se for de sessão morta, já está no recuperável.
    const typed = textRef.current === (draftRef.current?.text ?? '') ? '' : textRef.current;
    blockedRef.current = false;
    setReadBlocked(false);
    draftRef.current = load.draft;
    setRecoverable(load.recoverable);
    // O que a pessoa digitou enquanto a leitura falhava fica depois do guardado.
    const next = joinDrafts(load.draft?.text ?? '', typed);
    persistText(next);
    setText(next);
  }, [origin, persistText]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const steeringRef = useRef(false);
  const [steering, setSteering] = useState(false);
  const [steerFeedback, setSteerFeedback] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [undo, setUndo] = useState<{ before: string; raw: string } | null>(null);
  const [failed, setFailed] = useState<{ file: File; motivo: MotivoFim } | null>(null);
  const [autoN, setAutoN] = useState<number | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // null = lista de comandos fechada; string = o que veio depois da `/`.
  const [cmdFiltro, setCmdFiltro] = useState<string | null>(null);
  const [pendingAttach, setPendingAttach] = useState<PendingAttach | null>(null);
  // Só é definido quando o app MOVE o cursor (ditado, undo, draft); o onSelectionChange devolve o
  // controle ao campo logo em seguida — preso, ele impediria a pessoa de mexer no cursor.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>();
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoAlvoRef = useRef<number>(0);
  const autoTextoRef = useRef<string>('');

  const limparUndo = useCallback(() => {
    setUndo(null);
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, []);

  const cancelarAuto = useCallback(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setAutoN(null);
    autoAlvoRef.current = 0;
  }, []);

  // Atalho `/`: enquanto a linha é só o nome do comando, a lista fica aberta e filtrada.
  const handleChangeText = useCallback(
    (v: string) => {
      setText(v);
      setCmdFiltro(comandoParcial(v));
      if (undo) limparUndo();
      if (autoN !== null) cancelarAuto();
    },
    [undo, autoN, limparUndo, cancelarAuto],
  );

  // draft devolvido pelo cancelar do picker (Task 3): adota quando muda
  useEffect(() => {
    if (draft === adoptedDraftRef.current) return;
    adoptedDraftRef.current = draft;
    if (draft !== undefined && draft !== text) {
      setText(draft);
      setSelection({ start: draft.length, end: draft.length });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  useEffect(() => {
    if (firstInputSent && draft !== undefined) setText((current) => current === draft ? '' : current);
  }, [firstInputSent, draft]);

  const canSend = (text.trim().length > 0 || pendingAttach !== null) && !sending && !uploading;

  // A primeira mensagem já pode ter chegado antes de esta tela montar: nunca criar outro eco.
  const sendText = useCallback(async (value: string): Promise<void> => {
    if (!firstInputId) return chat.send(value);
    const snapshot = readFirstInput(serverId, name);
    if (snapshot?.id !== firstInputId) {
      if (value.trim() === draft?.trim()) return;
      return chat.send(value);
    }
    if (value.trim() !== snapshot.text.trim()) {
      return chat.send(value);
    }
    if (snapshot.phase === 'created') await sendFirstInput(serverId, snapshot.id);
    const current = readFirstInput(serverId, name);
    if (!current || current.id !== snapshot.id) return;
    if (current.phase === 'sent') {
      confirmFirstInput(snapshot.id);
      return;
    }
    const issue = useNewConversation.getState().issues[serverId];
    throw new Error(issue?.message ?? (current.phase === 'created'
      ? m.composer_falha_envio() : m.nova_conversa_envio_incerto()));
  }, [serverId, name, firstInputId, draft, chat]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    const hasAttach = pendingAttach !== null;
    if (!trimmed && !hasAttach) return;
    if (sendingRef.current || sending || uploading) return;
    sendingRef.current = true;
    limparUndo();
    cancelarAuto();
    setCmdFiltro(null);
    setSending(true);
    setError('');
    // upload do anexo pendente antes de enviar
    let finalText = trimmed;
    let toClearAttach = false;
    if (hasAttach && pendingAttach) {
      setUploading(true);
      try {
        const cur = pendingAttach;
        const blobRes = await fetch(cur.uri);
        const blob = await blobRes.blob();
        const file = new File([blob], cur.name, { type: cur.mime });
        const { path } = await uploadFile(name, file);
        const insert = `📎 ${cur.kind === 'image' ? m.board_imagem() : m.board_arquivo()}: ${path}`;
        finalText = trimmed ? `${trimmed} — ${insert}` : insert;
        toClearAttach = true;
      } catch (e) {
        setError(e instanceof Error ? e.message : m.board_falha_upload());
        setSending(false);
        sendingRef.current = false;
        setUploading(false);
        return;
      } finally {
        setUploading(false);
      }
    }
    if (!finalText.trim()) {
      setSending(false);
      sendingRef.current = false;
      return;
    }
    setText('');
    if (toClearAttach) setPendingAttach(null);
    let groupPendingId: string | null = null;
    try {
      const snapshot = firstInputId ? readFirstInput(serverId, name) : null;
      const firstDraft = snapshot?.id === firstInputId && snapshot?.text.trim() === finalText.trim();
      const sendToPairNow = !firstDraft && sendToPair && !!pairPeers?.length && !finalText.trimStart().startsWith('/');
      if (sendToPairNow && pairPeers?.length) {
        const recipients = [name, ...pairPeers];
        groupPendingId = `pending-group-${Date.now()}`;
        chat.use.setState((current) => ({ pending: [...current.pending, { id: groupPendingId!, text: finalText }] }));
        const results = await broadcast(recipients, finalText);
        const failedRecipients = recipients.filter((recipient) => !results[recipient]?.ok);
        if (failedRecipients.length) {
          const delivered = recipients.filter((recipient) => results[recipient]?.ok);
          const detail = failedRecipients.map((recipient) => formataErro(results[recipient]?.error)).find(Boolean);
          throw new Error(
            `${delivered.length ? m.chat_chegou_mas({ n: delivered.join(', ') }) : ''}${m.chat_nao_chegou_em()}${failedRecipients.join(', ')} (${detail ?? m.board_falha_envio()})`,
          );
        }
      } else {
        await sendText(finalText);
      }
    } catch (e) {
      if (groupPendingId) {
        chat.use.setState((current) => ({ pending: current.pending.filter((item) => item.id !== groupPendingId) }));
      }
      const msg = e instanceof Error ? e.message : m.composer_falha_envio();
      setError(msg);
      setText((prev) => (prev.trim() ? prev : finalText));
      if (toClearAttach) {
        // mantém o anexo pra tentar de novo? recoloca se falhou o envio mas upload já foi
        // upload já ocorreu, path está em finalText; recolocar pending seria duplicar
      }
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }, [text, sending, uploading, chat, sendText, limparUndo, cancelarAuto, pendingAttach, serverId, name, firstInputId, pairPeers, sendToPair]);

  // auto-envio: contagem de 3s
  const iniciarAuto = useCallback(
    (textoParaEnviar: string) => {
      cancelarAuto();
      autoTextoRef.current = textoParaEnviar;
      autoAlvoRef.current = Date.now() + 3000;
      setAutoN(3);
      autoTimerRef.current = setInterval(() => {
        const rest = autoAlvoRef.current - Date.now();
        if (rest <= 0) {
          cancelarAuto();
          const toSend = autoTextoRef.current.trim();
          if (!toSend) return;
          setText('');
          limparUndo();
          void sendText(toSend)
            .then(() => setError(''))
            .catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : m.composer_falha_envio();
              setError(msg);
              setText((prev) => (prev.trim() ? prev : toSend));
            });
          return;
        }
        setAutoN(Math.ceil(rest / 1000));
      }, 250);
    },
    [cancelarAuto, sendText, limparUndo],
  );

  const handleTranscribe = useCallback(
    async (file: File, motivo: MotivoFim) => {
      if (transcribing) {
        setError(m.composer_aguarde_transcricao());
        return;
      }
      setTranscribing(true);
      setError('');
      setFailed(null);
      try {
        const estilo = useDitadoEstiloStore.getState().pronto
          ? useDitadoEstiloStore.getState().valor
          : undefined;
        const { text: t, raw, aviso } = await transcribeFile(name, file, {
          limpar: true,
          estilo,
        });
        const trimmed = t.trim();
        if (!trimmed) {
          setError(m.composer_transcricao_vazia());
          return;
        }
        const before = textRef.current.trim();
        const next = before ? `${before} ${trimmed}` : trimmed;
        setText(next);
        setSelection({ start: next.length, end: next.length });
        if (raw && raw.trim() !== trimmed) {
          setUndo({ before, raw: raw.trim() });
          if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
          undoTimerRef.current = setTimeout(() => limparUndo(), 10_000);
        } else {
          limparUndo();
        }
        if (aviso) {
          setError(aviso);
        }
        const shouldAuto = podeEnviarSozinho({
          motivo,
          texto: trimmed,
          aviso: aviso ?? null,
          rascunhoAntes: before.length > 0,
        });
        if (shouldAuto) {
          iniciarAuto(next);
        }
      } catch (e) {
        setFailed({ file, motivo });
        const msg = e instanceof Error ? e.message : m.composer_falha_transcricao();
        setError(msg);
      } finally {
        setTranscribing(false);
      }
    },
    [name, transcribing, limparUndo, iniciarAuto],
  );

  const { gravando, rms, iniciar, parar } = useDitado({
    onFim: handleTranscribe,
    onErroParada: (e) =>
      setError(e.message === 'ditado_parada_falhou' ? m.composer_falha_gravacao() : e.message || m.composer_falha_gravacao()),
  });

  const handleMicPress = useCallback(async () => {
    if (transcribing) return;
    if (gravando) {
      void parar('botao');
      return;
    }
    if (autoN !== null) cancelarAuto();
    try {
      await iniciar();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'permission_denied') {
        setError(m.composer_sem_acesso_mic());
      } else {
        setError(e instanceof Error ? e.message : m.composer_falha_gravacao());
      }
    }
  }, [gravando, transcribing, iniciar, parar, autoN, cancelarAuto]);

  const handleUndo = useCallback(() => {
    if (!undo) return;
    const { before, raw } = undo;
    const restored = before ? `${before} ${raw}` : raw;
    setText(restored);
    limparUndo();
    setSelection({ start: restored.length, end: restored.length });
  }, [undo, limparUndo]);

  const handleRetry = useCallback(() => {
    if (!failed) return;
    void handleTranscribe(failed.file, failed.motivo);
  }, [failed, handleTranscribe]);

  const handleSteer = useCallback(async () => {
    if (steeringRef.current) return;
    steeringRef.current = true;
    setSteering(true);
    setSteerFeedback('');
    setError('');
    try {
      const result = await steerSession(name);
      if (result.queued_ids?.length) {
        const sent = new Set(result.queued_ids);
        chat.use.setState(s => ({ events: s.events.map(e => sent.has(e.id) ? { ...e, queued_delivered: true } : e) }));
      }
      if (isCodex && chat.use.getState().stateEvent?.state === 'working') {
        setSteerFeedback((result.confirmed ?? 0) > 0 ? m.codex_orientar_recebido() : m.codex_orientar_sem_envio());
      }
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      setError(status === 409 ? m.composer_fila_erro() : e instanceof Error ? e.message : m.composer_fila_erro());
    } finally {
      steeringRef.current = false;
      setSteering(false);
    }
  }, [name, isCodex, chat]);

  const isKimi = provider === 'kimi';
  const showSteer = (isKimi || isCodex) && state === 'working' && (filaCount > 0 || steering);
  useEffect(() => {
    if (state !== 'working') setSteerFeedback('');
  }, [state]);

  const handleKeyPress = useCallback(
    (ev: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      // Enter envia só no web (no celular é quebra de linha). O shiftKey vem do evento do DOM que o
      // react-native-web repassa em nativeEvent — o tipo do RN não o declara.
      const nat: TextInputKeyPressEventData = ev.nativeEvent;
      const shift = 'shiftKey' in nat && Boolean((nat as { shiftKey?: boolean }).shiftKey);
      if (nat.key === 'Enter' && !shift && Platform.OS === 'web') {
        // Sem isto o Enter TAMBÉM insere a quebra de linha, que corre contra o setText('') do envio.
        ev.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handlePickImage = useCallback(async () => {
    setAttachMenuOpen(false);
    setError('');
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      setPendingAttach({
        uri: asset.uri,
        name: asset.fileName ?? 'imagem.jpg',
        mime: asset.mimeType ?? 'image/jpeg',
        kind: 'image',
        size: asset.fileSize,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : m.board_falha_upload());
    }
  }, []);

  const handlePickFile = useCallback(async () => {
    setAttachMenuOpen(false);
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (res.canceled) return;
      const asset = (res as unknown as { assets: { uri: string; name: string; mimeType?: string; size?: number }[] }).assets?.[0];
      if (!asset) {
        const single = res as unknown as { uri: string; name: string; mimeType?: string; size?: number };
        if (!single.uri) return;
        const isImg = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(single.name ?? '');
        setPendingAttach({
          uri: single.uri,
          name: single.name ?? 'arquivo',
          mime: single.mimeType ?? 'application/octet-stream',
          kind: isImg ? 'image' : 'file',
          size: single.size,
        });
        return;
      }
      const isImg = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(asset.name ?? '');
      setPendingAttach({
        uri: asset.uri,
        name: asset.name ?? 'arquivo',
        mime: asset.mimeType ?? 'application/octet-stream',
        kind: isImg ? 'image' : 'file',
        size: asset.size,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : m.board_falha_upload());
    }
  }, []);

  const handleRemoveAttach = useCallback(() => {
    setPendingAttach(null);
  }, []);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    };
  }, []);

  return (
    <Glass variant="chrome" style={styles.glass}>
        {/* chip de fila: pending local + queued-* do SSE (contado no store como pending até chegar o real) */}
        {filaCount > 0 || steering ? (
          <View style={styles.filaChip}>
            {!steering ? <Text style={[styles.filaText, { color: theme.tokens.text.secondary }]}>
              ⏳ {m.composer_fila_contagem({ n: filaCount })}
            </Text> : null}
            {showSteer ? (
              <Pressable
                onPress={handleSteer}
                disabled={steering}
                accessibilityState={{ disabled: steering, busy: steering }}
                style={[styles.steerBtn, { borderColor: theme.tokens.accent.base }]}
                accessibilityLabel={m.composer_fila_aria()}
                accessibilityRole="button"
              >
                <Text style={[styles.steerText, { color: theme.tokens.accent.base }]}>
                  {steering ? m.askq_enviando() : isCodex ? m.codex_orientar() : m.composer_fila_acao()}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {steerFeedback && state === 'working' ? <Text style={[styles.steerText, { color: theme.tokens.text.secondary }]} accessibilityLiveRegion="polite">{steerFeedback}</Text> : null}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillsRow}>
          <View style={styles.pillDuo}>
            <ModelPill serverId={serverId} name={name} />
            <EffortPill serverId={serverId} name={name} />
          </View>
          <PermissionPill serverId={serverId} name={name} />
          {pairPeers?.length ? (
            <Pressable
              onPress={() => setSendToPair((current) => !current)}
              style={[styles.pairChip, { borderColor: sendToPair ? theme.tokens.accent.base : theme.tokens.border.subtle, backgroundColor: sendToPair ? theme.tokens.bg.elevated : 'transparent' }]}
              accessibilityRole="switch"
              accessibilityState={{ checked: sendToPair }}
              accessibilityLabel={m.composer_mandar_grupo()}
              accessibilityHint={sendToPair ? m.composer_mandando_grupo() : m.composer_mandar_tambem({ n: pairPeers.join(', ') })}
            >
              <Text style={[styles.pairChipText, { color: sendToPair ? theme.tokens.accent.base : theme.tokens.text.secondary }]}>⇄</Text>
              <Text style={[styles.pairChipLabel, { color: sendToPair ? theme.tokens.accent.base : theme.tokens.text.secondary }]} numberOfLines={1}>
                {sendToPair ? (pairPeers.length === 1 ? m.composer_pros_dois() : m.composer_pro_grupo()) : m.composer_mandar_tambem({ n: pairPeers.join(', ') })}
              </Text>
            </Pressable>
          ) : null}
          {isCodex ? (
            <Pressable
              onPress={() => router.push(`/s/${serverId}/${name}/codex-limits` as never)}
              style={[styles.codexChip, { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]}
              accessibilityRole="button"
              accessibilityLabel={m.codex_limites_titulo()}
            >
              <Text style={[styles.codexChipText, { color: theme.tokens.text.primary }]}>{m.codex_limites_titulo()}</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        {pendingAttach ? (
          <View style={[styles.attachPreview, { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]}>
            {pendingAttach.kind === 'image' ? (
              <Image source={{ uri: pendingAttach.uri }} style={styles.attachThumb} contentFit="cover" transition={150} />
            ) : (
              <View style={[styles.attachFileIcon, { backgroundColor: superficie(theme) }]}>
                <Text style={styles.attachFileIco}>📎</Text>
              </View>
            )}
            <View style={styles.attachInfo}>
              <Text style={[styles.attachName, { color: theme.tokens.text.primary }]} numberOfLines={1}>
                {pendingAttach.name}
              </Text>
              {pendingAttach.size ? (
                <Text style={[styles.attachMeta, { color: theme.tokens.text.muted }]}>{Math.round(pendingAttach.size / 1024)} KB</Text>
              ) : null}
            </View>
            <Pressable
              onPress={handleRemoveAttach}
              style={[styles.attachRemove, { borderColor: theme.tokens.border.subtle }]}
              accessibilityLabel={m.board_remover_anexo()}
              accessibilityRole="button"
            >
              <Text style={[styles.attachRemoveTxt, { color: theme.tokens.text.secondary }]}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.row}>
          <View style={styles.inputWrap}>
            <MultilineInput
              value={text}
              onChangeText={handleChangeText}
              placeholder={m.composer_mensagem()}
              maxHeight={120}
              onKeyPress={handleKeyPress}
              selection={selection}
              onSelectionChange={() => setSelection(undefined)}
            />
          </View>

          <EstiloPill />

          <Pressable
            onPress={handleMicPress}
            disabled={transcribing || sending}
            style={[
              styles.iconBtn,
              (transcribing || sending) && styles.iconBtnDisabled,
              gravando && { backgroundColor: theme.tokens.status.error, borderColor: theme.tokens.status.error },
            ]}
            accessibilityLabel={gravando ? m.composer_parar_gravacao() : m.composer_gravar_audio()}
            accessibilityRole="button"
          >
            <Text style={[styles.iconGlyph, { color: gravando ? '#fff' : theme.tokens.text.secondary }]}>
              {gravando ? '■' : '🎤'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setAttachMenuOpen(true)}
            disabled={uploading || sending || gravando}
            style={[styles.iconBtn, (uploading || gravando) && styles.iconBtnDisabled]}
            accessibilityLabel={m.composer_anexar_arquivo()}
            accessibilityRole="button"
          >
            {uploading ? (
              <ActivityIndicator size="small" color={theme.tokens.text.secondary} />
            ) : (
              <Text style={[styles.iconGlyph, { color: theme.tokens.text.secondary }]}>📎</Text>
            )}
          </Pressable>

          {onStop && state === 'working' ? (
            <Pressable
              onPress={onStop}
              disabled={stopping}
              style={[styles.iconBtn, stopping && styles.iconBtnDisabled]}
              accessibilityLabel={m.composer_parar()}
              accessibilityRole="button"
              accessibilityState={{ disabled: stopping, busy: stopping }}
            >
              <Icon name="Square" size={20} />
            </Pressable>
          ) : null}

          <Pressable
            onPress={handleSend}
            disabled={!canSend}
            style={[styles.sendBtn, { backgroundColor: theme.tokens.accent.base }, !canSend && styles.sendBtnDisabled]}
            accessibilityLabel={m.composer_enviar_mensagem()}
            accessibilityRole="button"
          >
            <Text style={[styles.sendGlyph, { color: theme.tokens.text.inverse }]}>↑</Text>
          </Pressable>
        </View>

        {gravando ? (
          <View style={[styles.rmsTrack, { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]} accessibilityLabel={m.composer_gravando_audio()}>
            <View style={[styles.rmsFill, { width: `${Math.round(Math.min(1, rms) * 100)}%`, backgroundColor: theme.tokens.accent.base }]} />
          </View>
        ) : null}

        {transcribing ? (
          <Text style={[styles.hint, { color: theme.tokens.text.muted }]}>{m.composer_transcrevendo_audio()}</Text>
        ) : null}

        {autoN !== null ? (
          <Pressable onPress={cancelarAuto} style={[styles.autoChip, { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
            <Text style={[styles.autoText, { color: theme.tokens.text.primary }]}>{m.composer_enviando_cancelar({ n: autoN })}</Text>
          </Pressable>
        ) : null}

        {undo ? (
          <View style={styles.undoRow}>
            <Text style={[styles.hint, { color: theme.tokens.text.muted }]}>{m.composer_ditado_limpo()}</Text>
            <Pressable onPress={handleUndo} style={[styles.undoBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
              <Text style={[styles.undoText, { color: theme.tokens.accent.base }]}>{m.composer_desfazer_limpeza()}</Text>
            </Pressable>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorRow}>
            <Text style={[styles.error, { color: theme.tokens.status.error }]}>{error}</Text>
            {failed ? (
              <Pressable onPress={handleRetry} style={[styles.retryBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
                <Text style={[styles.retryText, { color: theme.tokens.accent.base }]}>{m.composer_transcrever_de_novo()}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {draftIssue ? (
          <View style={styles.errorRow}>
            <Text style={[styles.error, { color: theme.tokens.status.error }]}>{draftIssue}</Text>
            {readBlocked ? (
              <Pressable onPress={handleRereadDraft} style={[styles.retryBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
                <Text style={[styles.retryText, { color: theme.tokens.accent.base }]}>{m.composer_draft_read_again()}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {recoverable ? (
          <View style={styles.undoRow}>
            <Text style={[styles.hint, styles.recoverText, { color: theme.tokens.text.muted }]} numberOfLines={2}>
              {m.composer_draft_previous({ text: recoverable.text.trim().slice(0, 80) })}
            </Text>
            <Pressable onPress={handleRecoverDraft} style={[styles.undoBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
              <Text style={[styles.undoText, { color: theme.tokens.accent.base }]}>{m.composer_draft_recover()}</Text>
            </Pressable>
            <Pressable onPress={handleDiscardDraft} style={[styles.undoBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
              <Text style={[styles.undoText, { color: theme.tokens.text.secondary }]}>{m.composer_draft_discard()}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* hint sutil do estado working: quando há pending/queued, já há chip; este texto só aparece em working sem fila */}
        {state === 'working' && filaCount === 0 && !gravando && !transcribing ? (
          <Text style={[styles.hint, { color: theme.tokens.text.muted }]}>{m.composer_sessao_trabalhando()}</Text>
        ) : null}

        <CommandSheet
          open={cmdFiltro !== null}
          onClose={() => setCmdFiltro(null)}
          name={name}
          filtro={cmdFiltro ?? ''}
          onEscolher={(display) => {
            const novo = `${display} `;
            setCmdFiltro(null);
            setText(novo);
            setSelection({ start: novo.length, end: novo.length });
          }}
        />

        <PillMenu
          open={attachMenuOpen}
          onClose={() => setAttachMenuOpen(false)}
          title={m.composer_anexar_arquivo()}
          items={[{ label: m.board_imagem() }, { label: m.board_arquivo() }]}
          onSelect={(it) => {
            if (it.label === m.board_imagem()) void handlePickImage();
            else void handlePickFile();
          }}
        />
    </Glass>
  );
}

const styles = StyleSheet.create((theme) => ({
  glass: {
    marginHorizontal: theme.base.space[2],
    marginBottom: theme.base.space[2],
    padding: theme.base.space[2],
    gap: theme.base.space[2],
  },
  filaChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    backgroundColor: superficie(theme, 0.8),
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
  },
  filaText: {
    fontSize: theme.base.text.xs,
    fontWeight: '500',
  },
  steerBtn: {
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 4,
  },
  steerText: {
    fontSize: theme.base.text.xs,
    fontWeight: '700',
  },
  pillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    paddingVertical: 2,
  },
  pillDuo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[1],
  },
  codexChip: {
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 6,
    minHeight: 32,
    justifyContent: 'center',
  },
  codexChipText: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  pairChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[1],
    minHeight: 32,
    maxWidth: 220,
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
  },
  pairChipText: {
    fontSize: theme.base.text.sm,
    fontWeight: '700',
  },
  pairChipLabel: {
    flexShrink: 1,
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.base.space[2],
  },
  inputWrap: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: superficie(theme),
    borderRadius: theme.base.radius.lg,
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 6,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: theme.base.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: superficie(theme, 0.8),
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
  },
  iconBtnDisabled: {
    opacity: 0.5,
  },
  iconGlyph: {
    fontSize: 18,
    lineHeight: 22,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: theme.base.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendGlyph: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
  },
  rmsTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    borderWidth: 1,
  },
  rmsFill: {
    height: '100%',
    borderRadius: 3,
  },
  autoChip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[3],
    paddingVertical: 6,
  },
  autoText: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  undoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
  },
  recoverText: {
    flex: 1,
  },
  undoBtn: {
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 4,
  },
  undoText: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  error: {
    fontSize: theme.base.text.xs,
    paddingHorizontal: theme.base.space[1],
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    flexWrap: 'wrap',
  },
  retryBtn: {
    borderWidth: 1,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 4,
  },
  retryText: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  hint: {
    fontSize: theme.base.text.xs,
    paddingHorizontal: theme.base.space[1],
  },
  attachPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    padding: theme.base.space[2],
    borderRadius: theme.base.radius.md,
    borderWidth: 1,
  },
  attachThumb: {
    width: 48,
    height: 48,
    borderRadius: theme.base.radius.sm,
    backgroundColor: superficie(theme),
  },
  attachFileIcon: {
    width: 48,
    height: 48,
    borderRadius: theme.base.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachFileIco: {
    fontSize: 22,
  },
  attachInfo: {
    flex: 1,
    gap: 2,
  },
  attachName: {
    fontSize: theme.base.text.sm,
    fontWeight: '600',
  },
  attachMeta: {
    fontSize: theme.base.text.xs,
  },
  attachRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachRemoveTxt: {
    fontSize: 14,
    fontWeight: '700',
  },
}));
