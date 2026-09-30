import { z } from 'zod';
import { prefs } from './prefs';
import * as m from '../paraglide/messages';

const attachmentSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  kind: z.enum(['image', 'file']),
  uploadedPath: z.string().min(1).optional(),
});

const draftSchema = z.object({
  version: z.literal(1),
  text: z.string(),
  revision: z.number().int().nonnegative(),
  transcript: z.string().min(1).nullable(),
  attachment: attachmentSchema.nullable(),
  submission: z.object({
    text: z.string(),
    draftRevision: z.number().int().nonnegative(),
    status: z.enum(['sending', 'unknown', 'rejected']),
  }).nullable(),
});

export type DraftAttachment = z.infer<typeof attachmentSchema>;
export type ConversationDraft = z.infer<typeof draftSchema>;

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
