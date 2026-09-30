import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, ScrollView, Text, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import { broadcast, formataErro, uploadFileForServer, transcribeFileForServer, steerSession, podeEnviarSozinho } from '@hangar/core';
import type { MotivoFim, Server } from '@hangar/core';
import { Glass } from '../ui/Glass';
import { Icon } from '../ui/Icon';
import { MultilineInput } from '../ui/MultilineInput';
import * as m from '../paraglide/messages';
import { chatStore, filaCount as filaCountOf, submitConversationDraft, isSubmitting } from '../stores/chat';
import { confirmFirstInput, readFirstInput, sendFirstInput, useNewConversation } from '../stores/newConversation';
import { useSessions } from '../stores/sessions';
import { clearDraft, clearRecoverableDraft, readDraft, readRecoverableDraft, resolveDraftTranscript, reusableUploadPath, withoutUpload, writeDraft, writeRecoverableDraft, clearDictation, readDictation, writeDictation, finishDictation, recoverDictation, associateDictationTranscript, type ConversationDraft, type DraftAttachment, type DictationDraft } from '../stores/drafts';
import { useServers } from '../stores/servers';
import { removeDraftAttachment, retainDraftAttachment } from './draftAttachments';
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

type PendingAttach = DraftAttachment & { size?: number };

const attachInsert = (attach: DraftAttachment, path: string) =>
  `📎 ${attach.kind === 'image' ? m.board_imagem() : m.board_arquivo()}: ${path}`;
const withAttach = (text: string, insert: string) => (text ? `${text} — ${insert}` : insert);

// Chamado depois que o rascunho largou a cópia: falhar aqui deixa só um arquivo órfão na pasta do app.
function dropCopy(uri: string): void {
  try { removeDraftAttachment(uri); } catch { /* sem perda de dado */ }
}

type DraftLoad = { draft: ConversationDraft | null; recoverable: ConversationDraft | null; dictation: DictationDraft | null; issue: string; blocked: boolean };

function loadDraft(serverId: string, name: string, transcript: string | null): DraftLoad {
  let resolved: ReturnType<typeof resolveDraftTranscript>;
  try {
    resolved = resolveDraftTranscript(serverId, name, transcript);
  } catch (e) {
    const issue = e instanceof Error ? e.message : m.draft_read_error();
    // Formato inválido não tem o que salvar; falha de leitura bloqueia gravar para não apagar o guardado.
    return { draft: null, recoverable: null, dictation: null, issue, blocked: issue !== m.draft_invalid() };
  }
  try {
    const recoverable = resolved.recoverable
      ? keepRecoverable(serverId, name, resolved.recoverable)
      : readRecoverableDraft(serverId, name);
    const dictation = transcript === null ? readDictation(serverId, name)
      : associateDictationTranscript(serverId, name, transcript);
    return { draft: resolved.draft, recoverable, dictation, issue: '', blocked: false };
  } catch (e) {
    // Com o antigo ainda só na chave principal, gravar o texto novo o apagaria.
    return { draft: resolved.draft, recoverable: null, dictation: null, issue: e instanceof Error ? e.message : m.draft_read_error(), blocked: true };
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
  const draftUpdate = chat.use((s) => s.draftUpdate);
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
  const [dictation, setDictation] = useState(boot.dictation);
  const [submission, setSubmission] = useState(boot.draft?.submission ?? null);
  const [pendingAttach, setPendingAttach] = useState<PendingAttach | null>(boot.draft?.attachment ?? null);
  // Rascunho guardado é mais novo que o texto de handoff/cancelamento que a rota ainda carrega.
  const adoptedDraftRef = useRef(draft);
  const [text, setText] = useState(() => boot.draft?.text ?? (firstInputSent ? '' : draft ?? ''));
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // Só texto novo avança a revisão: é ela que decide se o ACK pode limpar o campo.
  const persistDraft = useCallback((patch: { text?: string; attachment?: DraftAttachment | null }): boolean => {
    if (blockedRef.current) return false;
    let current: ConversationDraft | null;
    try { current = readDraft(origin.serverId, origin.name) ?? draftRef.current; } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_read_error());
      return false;
    }
    if (current?.transcript && transcriptRef.current && current.transcript !== transcriptRef.current) current = draftRef.current;
    const base: ConversationDraft = current
      ?? { version: 1, text: '', revision: 0, transcript: transcriptRef.current, attachment: null, submission: null };
    const value: ConversationDraft = {
      ...base,
      transcript: base.transcript ?? transcriptRef.current,
      ...(patch.text !== undefined ? { text: patch.text, revision: base.revision + 1 } : {}),
      ...(patch.attachment !== undefined ? { attachment: patch.attachment } : {}),
    };
    try {
      if (!value.text && !value.attachment && !value.submission) clearDraft(origin.serverId, origin.name);
      else writeDraft(origin.serverId, origin.name, value);
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_write_error());
      return false;
    }
    draftRef.current = value;
    setSubmission(value.submission);
    setDraftIssue('');
    return true;
  }, [origin]);
  const persistText = useCallback((next: string) => persistDraft({ text: next }), [persistDraft]);

  useEffect(() => {
    if ((draftRef.current?.text ?? '') !== text) persistText(text);
  }, [text, persistText]);

  useEffect(() => {
    if (blockedRef.current) return;
    try {
      setDictation(readDictation(origin.serverId, origin.name));
      const latest = readDraft(origin.serverId, origin.name);
      if (!latest) {
        setPendingAttach(null);
        return;
      }
      if (latest.transcript && transcriptRef.current && latest.transcript !== transcriptRef.current) return;
      const unchanged = textRef.current === (draftRef.current?.text ?? '');
      draftRef.current = latest;
      setSubmission(latest.submission);
      setPendingAttach((cur) => latest.attachment
        ? (cur?.uri === latest.attachment.uri ? { ...latest.attachment, size: cur.size } : latest.attachment)
        : null);
      if (unchanged) {
        textRef.current = latest.text;
        setText(latest.text);
      }
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_read_error());
    }
  }, [draftUpdate, origin]);

  const handleRecoverSubmission = useCallback(() => {
    if (isSubmitting(origin.serverId, origin.name) || !submission
      || (submission.status !== 'rejected' && submission.status !== 'unknown')) return;
    // O anexo continua no rascunho com o caminho enviado: devolver só o texto evita citar o arquivo duas vezes.
    const insert = pendingAttach?.uploadedPath ? attachInsert(pendingAttach, pendingAttach.uploadedPath) : null;
    const sent = insert && submission.text.endsWith(insert)
      ? submission.text.slice(0, -insert.length).replace(/ — $/, '') : submission.text;
    const next = textRef.current.trim() === sent.trim()
      ? textRef.current : joinDrafts(textRef.current, sent);
    try {
      const latest = readDraft(origin.serverId, origin.name);
      if (!latest?.submission || (latest.submission.status !== 'rejected' && latest.submission.status !== 'unknown')) return;
      const value = { ...latest, text: next, revision: latest.revision + 1, submission: null };
      writeDraft(origin.serverId, origin.name, value);
      draftRef.current = value;
      textRef.current = next;
      setText(next);
      setSubmission(null);
      setDraftIssue('');
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_write_error());
    }
  }, [submission, origin, pendingAttach]);

  // null → caminho é a primeira confirmação (Codex iniciando); caminho → outro é sessão recriada.
  useEffect(() => {
    transcriptRef.current = transcript;
    const known = draftRef.current?.transcript;
    if (transcript === null || blockedRef.current) return;
    try {
      setDictation(associateDictationTranscript(origin.serverId, origin.name, transcript));
      const target = recordingTargetRef.current;
      if (target?.snapshot.transcript === null) {
        target.snapshot = { ...target.snapshot, transcript };
      }
      if (known === undefined || known === transcript) return;
      const { draft: kept, recoverable: old } = resolveDraftTranscript(origin.serverId, origin.name, transcript);
      if (old) {
        // Gravação que falhou deixou o campo à frente do guardado: conservar o que está na tela.
        const latest = draftRef.current?.text === textRef.current ? old : { ...old, text: textRef.current };
        const kept = keepRecoverable(origin.serverId, origin.name, latest);
        draftRef.current = null;
        setSubmission(null);
        setRecoverable(kept);
        setPendingAttach(null);
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
    if (pendingAttach && recoverable.attachment) {
      setError(m.composer_draft_recover_attach_busy());
      return;
    }
    const next = joinDrafts(textRef.current, recoverable.text);
    // O upload antigo foi para a sessão que morreu: a recriada recebe o arquivo, nunca o caminho.
    const adopted = !pendingAttach && recoverable.attachment ? withoutUpload(recoverable.attachment) : undefined;
    if (!persistDraft({ text: next, ...(adopted ? { attachment: adopted } : {}) })) return;
    try {
      clearRecoverableDraft(origin.serverId, origin.name);
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_clear_error());
    }
    if (adopted) setPendingAttach(adopted);
    setRecoverable(null);
    setText(next);
    setSelection({ start: next.length, end: next.length });
  }, [recoverable, persistDraft, origin, pendingAttach]);

  const handleDiscardDraft = useCallback(() => {
    try {
      clearRecoverableDraft(origin.serverId, origin.name);
      // Nada gravado desde a recriação: a chave principal ainda é o antigo e o reofereceria.
      if (!draftRef.current) clearDraft(origin.serverId, origin.name);
    } catch (e) {
      setDraftIssue(e instanceof Error ? e.message : m.draft_clear_error());
      return;
    }
    if (recoverable?.attachment && recoverable.attachment.uri !== pendingAttach?.uri) dropCopy(recoverable.attachment.uri);
    setRecoverable(null);
  }, [origin, recoverable, pendingAttach]);

  const handleRereadDraft = useCallback(() => {
    const load = loadDraft(origin.serverId, origin.name, transcriptRef.current);
    setDraftIssue(load.issue);
    if (load.blocked) return;
    // Texto igual ao último guardado não foi digitado no bloqueio: se for de sessão morta, já está no recuperável.
    const typed = textRef.current === (draftRef.current?.text ?? '') ? '' : textRef.current;
    blockedRef.current = false;
    setReadBlocked(false);
    draftRef.current = load.draft;
    setSubmission(load.draft?.submission ?? null);
    setPendingAttach(load.draft?.attachment ?? null);
    setRecoverable(load.recoverable);
    setDictation(load.dictation);
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
  const transcribingRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(AppState.currentState === 'active');
  const activityGenerationRef = useRef(0);
  const recordingTargetRef = useRef<{ server: Server; snapshot: ConversationDraft; generation: number; estilo?: string } | null>(null);
  const micStartingRef = useRef(false);
  const [undo, setUndo] = useState<{ before: string; raw: string; revision: number } | null>(null);
  const [failed, setFailed] = useState<{ file: File; motivo: MotivoFim; uri: string } | null>(null);
  const [autoN, setAutoN] = useState<number | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // null = lista de comandos fechada; string = o que veio depois da `/`.
  const [cmdFiltro, setCmdFiltro] = useState<string | null>(null);
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
    if (mountedRef.current) setAutoN(null);
    autoAlvoRef.current = 0;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    activeRef.current = AppState.currentState === 'active';
    const sub = AppState.addEventListener('change', (next) => {
      activeRef.current = next === 'active';
      if (next !== 'active') {
        activityGenerationRef.current++;
        cancelarAuto();
      }
    });
    return () => {
      mountedRef.current = false;
      activityGenerationRef.current++;
      cancelarAuto();
      sub.remove();
    };
  }, [cancelarAuto]);

  // Atalho `/`: enquanto a linha é só o nome do comando, a lista fica aberta e filtrada.
  const handleChangeText = useCallback(
    (v: string) => {
      textRef.current = v;
      persistText(v);
      setText(v);
      setCmdFiltro(comandoParcial(v));
      if (undo) limparUndo();
      if (autoN !== null) cancelarAuto();
    },
    [undo, autoN, limparUndo, cancelarAuto, persistText],
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
  // Repetir um envio recusado com anexo já enviado gera o mesmo texto: o snapshot não bloqueia.
  const composedText = pendingAttach?.uploadedPath
    ? withAttach(text.trim(), attachInsert(pendingAttach, pendingAttach.uploadedPath)) : text.trim();
  const submissionBlocksSend = !!submission && (isSubmitting(serverId, name) || submission.text.trim() !== composedText);
  const canSend = (text.trim().length > 0 || pendingAttach !== null) && !sending && !uploading && !readBlocked && !submissionBlocksSend;

  // A primeira mensagem já pode ter chegado antes de esta tela montar: nunca criar outro eco.
  const sendText = useCallback(async (value: string, revision?: number): Promise<void> => {
    if (!firstInputId) return chat.send(value, revision);
    const snapshot = readFirstInput(serverId, name);
    if (snapshot?.id !== firstInputId) {
      return chat.send(value, revision);
    }
    if (value.trim() !== snapshot.text.trim()) {
      return chat.send(value, revision);
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
    if (submissionBlocksSend) return;
    if (sendingRef.current || sending || uploading) return;
    if (blockedRef.current || !persistText(textRef.current)) return;
    const sentRevision = draftRef.current!.revision;
    sendingRef.current = true;
    limparUndo();
    cancelarAuto();
    setCmdFiltro(null);
    setSending(true);
    setError('');
    const stop = () => {
      setSending(false);
      sendingRef.current = false;
    };
    let finalText = trimmed;
    const attach = pendingAttach;
    if (attach) {
      const target = { serverId: origin.serverId, name: origin.name, transcript: transcriptRef.current };
      let path = reusableUploadPath(attach, target);
      if (!path) {
        const server = useServers.getState().servers.find((s) => s.id === origin.serverId);
        if (!server) {
          setError(m.chat_servidor_removido());
          stop();
          return;
        }
        setUploading(true);
        try {
          const blob = await (await fetch(attach.uri)).blob();
          path = (await uploadFileForServer(server, origin.name, new File([blob], attach.name, { type: attach.mime }))).path;
        } catch (e) {
          // O backend diz o motivo (tamanho, formato); o texto e o anexo continuam no rascunho.
          setError(e instanceof Error && e.message ? `${m.board_falha_upload()}: ${e.message}` : m.board_falha_upload());
          stop();
          return;
        } finally {
          setUploading(false);
        }
        const uploaded = { ...attach, uploadedPath: path, uploadedFor: target };
        if (!persistDraft({ attachment: uploaded })) {
          stop();
          return;
        }
        setPendingAttach(uploaded);
      }
      finalText = withAttach(trimmed, attachInsert(attach, path));
    }
    if (!finalText.trim()) {
      stop();
      return;
    }
    let groupPendingId: string | null = null;
    try {
      const snapshot = firstInputId ? readFirstInput(serverId, name) : null;
      const firstDraft = snapshot?.id === firstInputId && snapshot?.text.trim() === finalText.trim();
      const sendToPairNow = !firstDraft && sendToPair && !!pairPeers?.length && !finalText.trimStart().startsWith('/');
      if (sendToPairNow && pairPeers?.length) {
        const recipients = [name, ...pairPeers];
        await submitConversationDraft(serverId, name, finalText, async () => {
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
        }, sentRevision);
      } else {
        await sendText(finalText, sentRevision);
      }
      if (attach && persistDraft({ attachment: null })) {
        dropCopy(attach.uri);
        setPendingAttach(null);
        // Outra tela desta conversa aberta durante o envio ainda mostra o anexo: o aviso vem depois da limpeza.
        chat.use.setState((s) => ({ draftUpdate: s.draftUpdate + 1 }));
      }
    } catch (e) {
      if (groupPendingId) {
        chat.use.setState((current) => ({ pending: current.pending.filter((item) => item.id !== groupPendingId) }));
      }
      const msg = e instanceof Error ? e.message : m.composer_falha_envio();
      setError(msg);
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }, [text, sending, uploading, chat, sendText, limparUndo, cancelarAuto, pendingAttach, serverId, name, firstInputId, pairPeers, sendToPair, persistText, persistDraft, origin, submissionBlocksSend]);

  // auto-envio: contagem de 3s
  const iniciarAuto = useCallback(
    (textoParaEnviar: string) => {
      cancelarAuto();
      const generation = activityGenerationRef.current;
      const revision = draftRef.current?.revision;
      autoTextoRef.current = textoParaEnviar;
      autoAlvoRef.current = Date.now() + 3000;
      setAutoN(3);
      autoTimerRef.current = setInterval(() => {
        if (!mountedRef.current || !activeRef.current || generation !== activityGenerationRef.current
          || textRef.current !== textoParaEnviar || draftRef.current?.revision !== revision) {
          cancelarAuto();
          return;
        }
        const rest = autoAlvoRef.current - Date.now();
        if (rest <= 0) {
          cancelarAuto();
          const toSend = autoTextoRef.current.trim();
          if (!toSend) return;
          limparUndo();
          void sendText(toSend, revision)
            .then(() => setError(''))
            .catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : m.composer_falha_envio();
              setError(msg);
            });
          return;
        }
        setAutoN(Math.ceil(rest / 1000));
      }, 250);
    },
    [cancelarAuto, sendText, limparUndo],
  );

  const offerUndo = useCallback((before: string, raw: string, cleaned: string, revision: number) => {
    limparUndo();
    if (!raw.trim() || raw.trim() === cleaned.trim()) return;
    setUndo({ before, raw: raw.trim(), revision });
    undoTimerRef.current = setTimeout(limparUndo, 10_000);
  }, [limparUndo]);

  const runTranscription = useCallback(async (voice: DictationDraft, file: File, server: Server, generation: number, allowAuto: boolean) => {
    if (transcribingRef.current) return;
    transcribingRef.current = true;
    if (mountedRef.current) {
      setTranscribing(true);
      setError('');
      setFailed(null);
    }
    let saved = false;
    try {
      writeDictation(origin.serverId, origin.name, voice);
      saved = true;
      if (mountedRef.current) setDictation(voice);
      const sessions = useSessions.getState();
      const live = sessions.byServerRecord?.[origin.serverId]?.find((s) => s.name === origin.name)
        ?? sessions.rows.find((s) => s.serverId === origin.serverId && s.name === origin.name);
      const currentTranscript = live ? live.jsonl || null : transcriptRef.current;
      if (voice.transcript !== null && currentTranscript !== voice.transcript) {
        throw new Error(m.composer_ditado_anterior());
      }
      // Interrupção durante a cópia/leitura conserva o áudio, sem iniciar outro POST na volta.
      if (!mountedRef.current || !activeRef.current || generation !== activityGenerationRef.current) {
        throw new Error(m.composer_ditado_interrompido());
      }
      const { text: result, raw, aviso } = await transcribeFileForServer(server, origin.name, file, {
        limpar: true, estilo: voice.estilo,
      });
      const trimmed = result.trim();
      if (!trimmed) throw new Error(m.composer_transcricao_vazia());
      const active = mountedRef.current && activeRef.current && !blockedRef.current
        && generation === activityGenerationRef.current
        && textRef.current.trim() === voice.before
        && (voice.transcript === null || voice.transcript === transcriptRef.current);
      const completed = finishDictation(origin.serverId, origin.name, voice.id,
        { text: trimmed, raw: raw?.trim() ?? '', issue: aviso ?? '' }, active);
      if (mountedRef.current) {
        setDictation(completed.dictation);
        if (completed.draft) {
          draftRef.current = completed.draft;
          textRef.current = completed.draft.text;
          setText(completed.draft.text);
          setSelection({ start: completed.draft.text.length, end: completed.draft.text.length });
          offerUndo(voice.before, raw ?? '', trimmed, completed.draft.revision);
          if (aviso) setError(aviso);
          if (allowAuto && podeEnviarSozinho({
            motivo: voice.motivo, texto: trimmed, aviso: aviso ?? null,
            rascunhoAntes: !!voice.before.trim() || !!completed.draft.attachment || !!completed.draft.submission,
          })) iniciarAuto(completed.draft.text);
        }
      }
      if (completed.draft && !completed.dictation) dropCopy(voice.audio.uri);
    } catch (e) {
      const detail = e instanceof Error ? e.message : m.composer_falha_transcricao();
      const issue = /^(501|503):/.test(detail) ? `${m.composer_ditado_indisponivel()}: ${detail}` : detail;
      if (!saved && mountedRef.current) setFailed({ file, motivo: voice.motivo, uri: voice.audio.uri });
      try {
        const latest = readDictation(origin.serverId, origin.name);
        if (latest?.id === voice.id) {
          const kept = { ...latest, status: latest.text ? 'ready' as const : 'failed' as const, issue };
          writeDictation(origin.serverId, origin.name, kept);
          if (mountedRef.current) setDictation(kept);
        } else if (!latest && mountedRef.current) {
          // Falhar a primeira gravação não pode perder a repetição do áudio já copiado.
          setFailed({ file, motivo: voice.motivo, uri: voice.audio.uri });
        }
      } catch (storageError) {
        if (mountedRef.current) setDraftIssue(storageError instanceof Error ? storageError.message : m.draft_write_error());
      }
      if (mountedRef.current) setError(issue);
    } finally {
      transcribingRef.current = false;
      if (mountedRef.current) setTranscribing(false);
      // Outra montagem da origem lê o áudio/resultado persistido, sem alterar o destino atual.
      chat.use.setState((s) => ({ draftUpdate: s.draftUpdate + 1 }));
    }
  }, [origin, chat, offerUndo, iniciarAuto]);

  const handleTranscribe = useCallback(
    async (file: File, motivo: MotivoFim, uri: string, allowAuto = true) => {
      const target = recordingTargetRef.current;
      if (!target || transcribingRef.current) return;
      // Bloqueia outro início enquanto a cópia sai do cache para o diretório do app.
      transcribingRef.current = true;
      if (mountedRef.current) setTranscribing(true);
      let audio: DraftAttachment;
      try {
        audio = await retainDraftAttachment({ uri, name: file.name, mime: file.type, kind: 'file' });
      } catch (e) {
        if (mountedRef.current) {
          setFailed({ file, motivo, uri });
          setError(e instanceof Error ? e.message : m.draft_write_error());
          setTranscribing(false);
        }
        transcribingRef.current = false;
        return;
      }
      transcribingRef.current = false;
      const voice: DictationDraft = {
        version: 1, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, audio,
        transcript: target.snapshot.transcript, draftRevision: target.snapshot.revision,
        before: target.snapshot.text.trim(), motivo, estilo: target.estilo,
        status: 'pending', text: '', raw: '', issue: '',
      };
      await runTranscription(voice, file, target.server, target.generation, allowAuto);
    },
    [runTranscription],
  );

  const { gravando, rms, iniciar, parar } = useDitado({
    onFim: handleTranscribe,
    onErroParada: (e) => {
      if (mountedRef.current) setError(e.message === 'ditado_parada_falhou' ? m.composer_falha_gravacao() : e.message || m.composer_falha_gravacao());
    },
  });

  const handleMicPress = useCallback(async () => {
    if (transcribingRef.current || micStartingRef.current) return;
    if (gravando) {
      void parar('botao');
      return;
    }
    if (dictation || !mountedRef.current || !activeRef.current) return;
    if (autoN !== null) cancelarAuto();
    micStartingRef.current = true;
    try {
      const server = useServers.getState().servers.find((s) => s.id === origin.serverId);
      if (!server) throw new Error(m.chat_servidor_removido());
      if (blockedRef.current || !persistText(textRef.current)) return;
      const snapshot = draftRef.current!;
      // Mesmo vazio precisa de revisão em disco para comparar o retorno da voz.
      writeDraft(origin.serverId, origin.name, snapshot);
      const style = useDitadoEstiloStore.getState();
      recordingTargetRef.current = { server: { ...server }, snapshot,
        generation: activityGenerationRef.current, estilo: style.pronto ? style.valor : undefined };
      await iniciar();
      // O diálogo de permissão pode resolver antes de chegar o AppState active.
      if (mountedRef.current && recordingTargetRef.current) {
        recordingTargetRef.current.generation = activityGenerationRef.current;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'permission_denied') {
        setError(m.composer_sem_acesso_mic());
      } else {
        setError(e instanceof Error ? e.message : m.composer_falha_gravacao());
      }
    } finally { micStartingRef.current = false; }
  }, [gravando, iniciar, parar, autoN, cancelarAuto, dictation, origin, persistText]);

  const handleUndo = useCallback(() => {
    if (!undo) return;
    cancelarAuto();
    if (draftRef.current?.revision !== undo.revision) { limparUndo(); return; }
    const { before, raw } = undo;
    const restored = before ? `${before} ${raw}` : raw;
    if (!persistText(restored)) return;
    textRef.current = restored;
    setText(restored);
    limparUndo();
    setSelection({ start: restored.length, end: restored.length });
  }, [undo, limparUndo, cancelarAuto, persistText]);

  const handleRetry = useCallback(async () => {
    if (transcribingRef.current) return;
    if (failed) { await handleTranscribe(failed.file, failed.motivo, failed.uri, false); return; }
    if (!dictation || dictation.status === 'ready' || dictation.status === 'applied') return;
    cancelarAuto();
    const generation = activityGenerationRef.current;
    transcribingRef.current = true;
    setTranscribing(true);
    try {
      const server = useServers.getState().servers.find((s) => s.id === origin.serverId);
      if (!server) throw new Error(m.chat_servidor_removido());
      if (dictation.transcript !== null && dictation.transcript !== transcriptRef.current) {
        setError(m.composer_ditado_anterior());
        return;
      }
      const blob = await (await fetch(dictation.audio.uri)).blob();
      const file = new File([blob], dictation.audio.name, { type: dictation.audio.mime });
      transcribingRef.current = false;
      // Repetir é explícito, mas nunca rearma o autoenvio cancelado.
      await runTranscription({ ...dictation, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        status: 'pending', issue: '' }, file, { ...server }, generation, false);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : m.composer_falha_transcricao());
    } finally {
      transcribingRef.current = false;
      if (mountedRef.current) setTranscribing(false);
    }
  }, [failed, handleTranscribe, dictation, origin, runTranscription, cancelarAuto]);

  const handleRecoverDictation = useCallback(() => {
    if (!dictation?.text || dictation.status !== 'ready' || transcribingRef.current) return;
    cancelarAuto();
    const before = textRef.current.trim();
    if (!persistText(textRef.current)) return;
    try {
      const recovered = recoverDictation(origin.serverId, origin.name, dictation.id);
      setDictation(recovered.dictation);
      if (!recovered.draft) return;
      draftRef.current = recovered.draft;
      textRef.current = recovered.draft.text;
      setText(recovered.draft.text);
      setSelection({ start: recovered.draft.text.length, end: recovered.draft.text.length });
      offerUndo(before, dictation.raw, dictation.text, recovered.draft.revision);
      if (!recovered.dictation) dropCopy(dictation.audio.uri);
      setError(dictation.issue);
    } catch (e) { setDraftIssue(e instanceof Error ? e.message : m.draft_clear_error()); }
  }, [dictation, cancelarAuto, persistText, offerUndo, origin]);

  const handleDiscardDictation = useCallback(() => {
    if (!dictation || transcribingRef.current) return;
    try {
      clearDictation(origin.serverId, origin.name);
      dropCopy(dictation.audio.uri);
      setDictation(null);
      setError('');
    } catch (e) { setDraftIssue(e instanceof Error ? e.message : m.draft_clear_error()); }
  }, [dictation, origin]);

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

  // A seleção vira cópia do app antes de entrar no rascunho: a original pode sumir do cache do picker.
  const adoptPicked = useCallback(async (picked: PendingAttach) => {
    let kept: DraftAttachment;
    try {
      kept = await retainDraftAttachment(withoutUpload(picked));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : m.draft_write_error());
      return;
    }
    if (!persistDraft({ attachment: kept })) {
      dropCopy(kept.uri);
      return;
    }
    if (pendingAttach && pendingAttach.uri !== kept.uri) dropCopy(pendingAttach.uri);
    setPendingAttach({ ...kept, size: picked.size });
  }, [persistDraft, pendingAttach]);

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
      await adoptPicked({
        uri: asset.uri,
        name: asset.fileName ?? 'imagem.jpg',
        mime: asset.mimeType ?? 'image/jpeg',
        kind: 'image',
        size: asset.fileSize,
      });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      const denied = code === 'ERR_USER_REJECTED_PERMISSIONS' || (e instanceof Error && /permission/i.test(e.message));
      setError(denied ? m.composer_sem_acesso_fotos() : e instanceof Error ? e.message : m.board_falha_upload());
    }
  }, [adoptPicked]);

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
        await adoptPicked({
          uri: single.uri,
          name: single.name ?? 'arquivo',
          mime: single.mimeType ?? 'application/octet-stream',
          kind: isImg ? 'image' : 'file',
          size: single.size,
        });
        return;
      }
      const isImg = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(asset.name ?? '');
      await adoptPicked({
        uri: asset.uri,
        name: asset.name ?? 'arquivo',
        mime: asset.mimeType ?? 'application/octet-stream',
        kind: isImg ? 'image' : 'file',
        size: asset.size,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : m.board_falha_upload());
    }
  }, [adoptPicked]);

  const handleRemoveAttach = useCallback(() => {
    if (!pendingAttach || !persistDraft({ attachment: null })) return;
    dropCopy(pendingAttach.uri);
    setPendingAttach(null);
  }, [pendingAttach, persistDraft]);

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
              disabled={sending}
              style={[styles.attachRemove, { borderColor: theme.tokens.border.subtle }, sending && styles.iconBtnDisabled]}
              accessibilityLabel={m.board_remover_anexo()}
              accessibilityRole="button"
              accessibilityState={{ disabled: sending }}
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

          {/* Só a pill encolhe: tela estreita ou fonte grande não empurra Enviar/Parar pra fora. */}
          <View style={styles.estiloSlot}>
            <EstiloPill />
          </View>

          <Pressable
            onPress={handleMicPress}
            disabled={transcribing || sending || (!!dictation && !gravando)}
            accessibilityState={{ disabled: transcribing || sending || (!!dictation && !gravando), busy: transcribing }}
            style={[
              styles.iconBtn,
              (transcribing || sending || (!!dictation && !gravando)) && styles.iconBtnDisabled,
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

        {dictation && !transcribing ? (
          <View style={styles.errorRow}>
            <Text style={[styles.hint, styles.recoverText, { color: theme.tokens.text.muted }]} accessibilityLiveRegion="polite">
              {dictation.status === 'applied' ? m.composer_ditado_aplicado()
                : dictation.text ? m.composer_ditado_recuperavel({ text: dictation.text.slice(0, 80) })
                : dictation.issue || m.composer_ditado_interrompido()}
            </Text>
            {dictation.status === 'applied' ? null : dictation.text ? (
              <Pressable onPress={handleRecoverDictation} style={[styles.undoBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
                <Text style={[styles.undoText, { color: theme.tokens.accent.base }]}>{m.composer_draft_recover()}</Text>
              </Pressable>
            ) : (
              <Pressable onPress={handleRetry} style={[styles.retryBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
                <Text style={[styles.retryText, { color: theme.tokens.accent.base }]}>{m.composer_transcrever_de_novo()}</Text>
              </Pressable>
            )}
            <Pressable onPress={handleDiscardDictation} style={[styles.undoBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
              <Text style={[styles.undoText, { color: theme.tokens.text.secondary }]}>{m.composer_draft_discard()}</Text>
            </Pressable>
          </View>
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

        {submission ? (
          <View style={styles.undoRow}>
            <Text style={[styles.hint, styles.recoverText, { color: theme.tokens.text.muted }]}>
              {submission.status === 'rejected' ? m.composer_submission_rejected()
                : submission.status === 'sending' || sending ? m.composer_submission_sending() : m.chat_envio_incerto()}
            </Text>
            {submission.status === 'rejected' || (submission.status === 'unknown' && !sending) ? (
              <Pressable onPress={handleRecoverSubmission} style={[styles.undoBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
                <Text style={[styles.undoText, { color: theme.tokens.accent.base }]}>{m.composer_draft_recover()}</Text>
              </Pressable>
            ) : null}
            {submission.status === 'unknown' ? (
              <Pressable onPress={chat.retry} style={[styles.undoBtn, { borderColor: theme.tokens.border.subtle }]} accessibilityRole="button">
                <Text style={[styles.undoText, { color: theme.tokens.accent.base }]}>{m.composer_submission_check()}</Text>
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
    minWidth: 64,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: superficie(theme),
    borderRadius: theme.base.radius.lg,
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 6,
  },
  estiloSlot: {
    flexShrink: 1,
    minWidth: 0,
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
