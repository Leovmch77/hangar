import { Directory, File, Paths } from 'expo-file-system';
import type { DraftAttachment } from '../stores/drafts';
import * as m from '../paraglide/messages';

let sequence = 0;
const attachmentDirectory = () => new Directory(Paths.document, 'draft-attachments');

export async function retainDraftAttachment(attachment: DraftAttachment): Promise<DraftAttachment> {
  const directory = attachmentDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const extension = attachment.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? '';
  const destination = new File(directory, `${Date.now()}-${++sequence}${extension}`);
  await new File(attachment.uri).copy(destination, { overwrite: false });
  if (!destination.exists) throw new Error(m.draft_write_error());
  return { ...attachment, uri: destination.uri };
}

export function removeDraftAttachment(uri: string): void {
  const prefix = `${attachmentDirectory().uri.replace(/\/$/, '')}/`;
  // Um segmento gerado evita atravessar pastas ou apagar uma seleção externa.
  if (!uri.startsWith(prefix) || !/^\d+-\d+(?:\.[a-zA-Z0-9]{1,10})?$/.test(uri.slice(prefix.length))) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}
