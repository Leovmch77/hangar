import { prefs } from './prefs';

export type ProjectSelection = { root: string; cwd: string };

function isProjectSelection(value: unknown): value is ProjectSelection {
  return value !== null && typeof value === 'object'
    && 'root' in value && typeof value.root === 'string' && value.root.trim().length > 0
    && 'cwd' in value && typeof value.cwd === 'string' && value.cwd.trim().length > 0;
}

export function readProject(serverId: string): ProjectSelection | null {
  const raw = prefs.getString(`create.project.v1:${serverId}`);
  if (raw === undefined) return null;

  try {
    const selection: unknown = JSON.parse(raw);
    if (isProjectSelection(selection)) return { root: selection.root, cwd: selection.cwd };
  } catch {
    // JSON e formato inválidos recebem o mesmo aviso sem expor o conteúdo.
  }
  console.warn('Preferência de projeto inválida; escolha novamente.');
  return null;
}

export function rememberProject(serverId: string, selection: ProjectSelection): void {
  if (!isProjectSelection(selection)) throw new TypeError('Seleção de projeto inválida.');
  const key = `create.project.v1:${serverId}`;
  prefs.set(key, JSON.stringify({ root: selection.root, cwd: selection.cwd }));
}
