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

export function readDraft(serverId: string, name: string): ConversationDraft | null {
  let raw: string | undefined;
  try { raw = prefs.getString(keyOf(serverId, name)); } catch {
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

export function writeDraft(serverId: string, name: string, value: ConversationDraft): void {
  let validated: ConversationDraft;
  try { validated = draftSchema.parse(value); } catch {
    throw new Error(m.draft_write_error());
  }
  try { prefs.set(keyOf(serverId, name), JSON.stringify(validated)); } catch {
    throw new Error(m.draft_write_error());
  }
}

export function clearDraft(serverId: string, name: string): void {
  try { prefs.remove(keyOf(serverId, name)); } catch {
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
