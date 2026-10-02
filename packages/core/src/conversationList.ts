import type { ArchiveEntry } from './api';

export interface LiveInput {
  serverId: string;
  name: string;
  last_activity?: number | null;
  last_reply?: string | null;
  jsonl?: string | null;
  state: string;
}
export type ConversationRow =
  | { kind: 'live'; serverId: string; name: string; title: string; at: number; state: string }
  | { kind: 'closed'; serverId: string; entry: ArchiveEntry; title: string; at: number };

// Nome do transcript sem pasta nem extensão: é o session_id da entrada do arquivo.
function jsonlStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.jsonl$/, '');
}

export function mergeConversations(live: LiveInput[], closedByServer: Map<string, ArchiveEntry[]>): ConversationRow[] {
  const rows: ConversationRow[] = live.map((s) => ({
    kind: 'live', serverId: s.serverId, name: s.name, title: s.name, at: s.last_activity ?? 0, state: s.state,
  }));
  const liveStems = new Map<string, Set<string>>();
  for (const s of live) {
    if (!s.jsonl) continue;
    const set = liveStems.get(s.serverId) ?? new Set<string>();
    set.add(jsonlStem(s.jsonl));
    liveStems.set(s.serverId, set);
  }
  for (const [serverId, entries] of closedByServer) {
    for (const entry of entries) {
      // A viva já está na lista pela sessão; a entrada do arquivo seria a mesma conversa duas vezes.
      // `entry.live` sozinho falha logo após retomar: o arquivo ainda não sabe da sessão nova.
      if (entry.live || liveStems.get(serverId)?.has(entry.session_id)) continue;
      rows.push({ kind: 'closed', serverId, entry, title: entry.preview || entry.ultima || entry.session_id.slice(0, 8), at: entry.mtime });
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}

// A conversa clicada segue para o leitor sem novo fetch (e sem o erro de conta ambígua da pasta).
const remembered = new Map<string, ArchiveEntry>();
const entryKey = (serverId: string, project: string, sid: string) => `${serverId}\u0000${project}\u0000${sid}`;

export function rememberEntry(serverId: string, entry: ArchiveEntry): void {
  remembered.set(entryKey(serverId, entry.project, entry.session_id), entry);
}

export function takeEntry(serverId: string, project: string, sid: string): ArchiveEntry | undefined {
  const key = entryKey(serverId, project, sid);
  const entry = remembered.get(key);
  remembered.delete(key);
  return entry;
}
