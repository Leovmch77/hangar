import { z } from 'zod';
import { prefs } from './prefs';
import * as m from '../paraglide/messages';

const attachmentSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  kind: z.enum(['image', 'file']),
  uploadedPath: z.string().min(1).optional(),
  uploadedFor: z.object({
    serverId: z.string().min(1),
    name: z.string().min(1),
    transcript: z.string().min(1).nullable(),
  }).optional(),
});

const draftSchema = z.object({
  version: z.literal(1),
  text: z.string(),
  revision: z.number().int().nonnegative(),
  transcript: z.string().min(1).nullable(),
  dictationId: z.string().min(1).optional(),
  attachment: attachmentSchema.nullable(),
  submission: z.object({
    text: z.string(),
    draftRevision: z.number().int().nonnegative(),
    status: z.enum(['sending', 'unknown', 'rejected']),
  }).nullable(),
});

// Separado do anexo escolhido: transcrição tardia não substitui foto nem snapshot de envio.
const dictationSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  audio: attachmentSchema,
  transcript: z.string().min(1).nullable(),
  draftRevision: z.number().int().nonnegative(),
  before: z.string(),
  motivo: z.enum(['silencio', 'botao', 'teto', 'escondeu']),
  estilo: z.string().optional(),
  status: z.enum(['pending', 'ready', 'failed', 'applied']),
  text: z.string(),
  raw: z.string(),
  issue: z.string(),
});

export type DraftAttachment = z.infer<typeof attachmentSchema>;
export type ConversationDraft = z.infer<typeof draftSchema>;
export type DictationDraft = z.infer<typeof dictationSchema>;
export type UploadTarget = NonNullable<DraftAttachment['uploadedFor']>;

// Upload feito antes de a sessão ter transcript ainda é dela; transcript diferente é sessão recriada.
export function reusableUploadPath(attachment: DraftAttachment, target: UploadTarget): string | null {
  const done = attachment.uploadedFor;
  if (!attachment.uploadedPath || !done || done.serverId !== target.serverId || done.name !== target.name) return null;
  return done.transcript === null || done.transcript === target.transcript ? attachment.uploadedPath : null;
}

export function withoutUpload(attachment: DraftAttachment): DraftAttachment {
  const { uri, name, mime, kind } = attachment;
  return { uri, name, mime, kind };
}

const keyOf = (serverId: string, name: string) => `draft.v1:${serverId}::${name}`;
// Rascunho da sessão anterior de mesmo nome, guardado antes de a sessão recriada gravar na chave principal.
const recoverableKeyOf = (serverId: string, name: string) => `draft.v1.recoverable:${serverId}::${name}`;

export const readDraft = (serverId: string, name: string) => readAt(keyOf(serverId, name));
export const writeDraft = (serverId: string, name: string, value: ConversationDraft) => writeAt(keyOf(serverId, name), value);
export const clearDraft = (serverId: string, name: string) => clearAt(keyOf(serverId, name));
export const readRecoverableDraft = (serverId: string, name: string) => readAt(recoverableKeyOf(serverId, name));
export const writeRecoverableDraft = (serverId: string, name: string, value: ConversationDraft) =>
  writeAt(recoverableKeyOf(serverId, name), value);
export const clearRecoverableDraft = (serverId: string, name: string) => clearAt(recoverableKeyOf(serverId, name));

function readAt(key: string): ConversationDraft | null {
  let raw: string | undefined;
  try { raw = prefs.getString(key); } catch {
    throw new Error(m.draft_read_error());
  }
  if (raw === undefined) return null;

  let value: ConversationDraft;
  try { value = draftSchema.parse(JSON.parse(raw)); } catch {
    // O conteúdo continua guardado para recuperação; não expor JSON no erro.
    throw new Error(m.draft_invalid());
  }
  if (value.submission?.status === 'sending') value.submission.status = 'unknown';
  return value;
}

function writeAt(key: string, value: ConversationDraft): void {
  let validated: ConversationDraft;
  try { validated = draftSchema.parse(value); } catch {
    throw new Error(m.draft_write_error());
  }
  try { prefs.set(key, JSON.stringify(validated)); } catch {
    throw new Error(m.draft_write_error());
  }
}

function clearAt(key: string): void {
  try { prefs.remove(key); } catch {
    throw new Error(m.draft_clear_error());
  }
}

const dictationKeyOf = (serverId: string, name: string) => `draft.v1.dictation:${serverId}::${name}`;

export function readDictation(serverId: string, name: string): DictationDraft | null {
  let raw: string | undefined;
  try { raw = prefs.getString(dictationKeyOf(serverId, name)); } catch { throw new Error(m.draft_read_error()); }
  if (raw === undefined) return null;
  let value: DictationDraft;
  try { value = dictationSchema.parse(JSON.parse(raw)); } catch { throw new Error(m.draft_invalid()); }
  if (readDraft(serverId, name)?.dictationId === value.id
    || readRecoverableDraft(serverId, name)?.dictationId === value.id) {
    return { ...value, status: 'applied', issue: m.draft_clear_error() };
  }
  // Reabrir só oferece repetição explícita: o POST anterior ainda pode responder.
  return value.status === 'pending' ? { ...value, status: 'failed', issue: m.composer_ditado_interrompido() } : value;
}

export function writeDictation(serverId: string, name: string, value: DictationDraft): void {
  let validated: DictationDraft;
  try { validated = dictationSchema.parse(value); } catch { throw new Error(m.draft_write_error()); }
  try { prefs.set(dictationKeyOf(serverId, name), JSON.stringify(validated)); } catch { throw new Error(m.draft_write_error()); }
}

export const clearDictation = (serverId: string, name: string) => clearAt(dictationKeyOf(serverId, name));

export function associateDictationTranscript(serverId: string, name: string, transcript: string): DictationDraft | null {
  const voice = readDictation(serverId, name);
  if (!voice || voice.transcript !== null) return voice;
  const associated = { ...voice, transcript };
  writeDictation(serverId, name, associated);
  return associated;
}

export function finishDictation(serverId: string, name: string, id: string,
  result: Pick<DictationDraft, 'text' | 'raw' | 'issue'>, active: boolean,
): { draft: ConversationDraft | null; dictation: DictationDraft | null } {
  const voice = readDictation(serverId, name);
  if (!voice || voice.id !== id) return { draft: null, dictation: voice };
  if (voice.status === 'applied') return { draft: null, dictation: voice };
  const completed: DictationDraft = { ...voice, ...result, status: 'ready' };
  writeDictation(serverId, name, completed);
  const latest = readDraft(serverId, name);
  if (!active || !latest || latest.revision !== voice.draftRevision
    || (voice.transcript !== null && latest.transcript !== voice.transcript)) {
    return { draft: null, dictation: completed };
  }
  return insertDictation(serverId, name, latest, completed);
}

export function recoverDictation(serverId: string, name: string, id: string): ReturnType<typeof finishDictation> {
  const voice = readDictation(serverId, name);
  if (!voice || voice.id !== id || voice.status !== 'ready' || !voice.text) return { draft: null, dictation: voice };
  const latest = readDraft(serverId, name)
    ?? { version: 1 as const, text: '', revision: 0, transcript: null, attachment: null, submission: null };
  return insertDictation(serverId, name, latest, voice);
}

function insertDictation(serverId: string, name: string, latest: ConversationDraft, voice: DictationDraft): ReturnType<typeof finishDictation> {
  // Texto e identidade entram juntos; falhar a limpeza depois não reoferece a mesma inserção.
  const next = { ...latest, text: latest.text.trim() ? `${latest.text.trim()} ${voice.text}` : voice.text,
    revision: latest.revision + 1, dictationId: voice.id };
  writeDraft(serverId, name, next);
  try { clearDictation(serverId, name); } catch {
    return { draft: next, dictation: { ...voice, status: 'applied', issue: m.draft_clear_error() } };
  }
  return { draft: next, dictation: null };
}

export function resolveDraftTranscript(serverId: string, name: string, transcript: string | null): {
  draft: ConversationDraft | null;
  recoverable: ConversationDraft | null;
} {
  const draft = readDraft(serverId, name);
  if (!draft || transcript === null || draft.transcript === transcript) {
    return { draft, recoverable: null };
  }
  if (draft.transcript === null) {
    const associated = { ...draft, transcript };
    writeDraft(serverId, name, associated);
    return { draft: associated, recoverable: null };
  }
  // O consumidor conserva recoverable antes de gravar texto da sessão recriada.
  return { draft: null, recoverable: draft };
}
