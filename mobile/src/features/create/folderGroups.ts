import type { FsEntry, WorktreeRepo, WorktreeStatus } from '@hangar/core';

export type WorktreeRow = { entry: FsEntry; status: WorktreeStatus };
// `visible`: worktrees que ainda importam (com sessão ou não mescladas); `merged` fica atrás de um toque.
export type FolderRow = { entry: FsEntry; visible: WorktreeRow[]; merged: WorktreeRow[] };

const time = (e: FsEntry) => e.mtime ?? -Infinity;

// Worktrees soltas na raiz enchiam a lista (dezenas de pastas por repositório): elas entram dentro do
// repositório principal quando ele está na mesma lista; o grupo ordena pelo uso mais recente dele.
export function groupFolders(entries: FsEntry[], repos: WorktreeRepo[]): FolderRow[] {
  const statusByPath = new Map<string, WorktreeStatus>();
  for (const r of repos) for (const w of r.worktrees) statusByPath.set(w.path, w);
  const listed = new Set(entries.map((e) => e.path));
  const rows = new Map<string, FolderRow>();
  const nested: WorktreeRow[] = [];
  for (const entry of entries) {
    const status = statusByPath.get(entry.path);
    if (status && listed.has(status.repo) && status.repo !== entry.path) nested.push({ entry, status });
    else rows.set(entry.path, { entry, visible: [], merged: [] });
  }
  for (const w of nested.sort((a, b) => time(b.entry) - time(a.entry))) {
    const row = rows.get(w.status.repo)!;
    (w.status.sessions.length || !w.status.merged ? row.visible : row.merged).push(w);
  }
  for (const row of rows.values()) row.visible.sort((a, b) => Number(!!b.status.sessions.length) - Number(!!a.status.sessions.length));
  const latest = (r: FolderRow) => Math.max(time(r.entry), ...r.visible.map((w) => time(w.entry)), ...r.merged.map((w) => time(w.entry)));
  return [...rows.values()].sort((a, b) => latest(b) - latest(a));
}
