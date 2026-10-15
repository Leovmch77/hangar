import type { AggSession } from './types';
import { projectKey, projectLabel, sortSessions, type GroupBy } from './format';

export interface GrupoSessoes {
  id: string;
  label: string;
  color: string | null;
  sessions: AggSession[];
}

/** Grupo de uma linha no modo dado: chave, rótulo e cor. */
export function grupoDaSessao(r: AggSession, modo: GroupBy): Omit<GrupoSessoes, 'sessions'> {
  if (modo === 'none') return { id: 'todas', label: '', color: null };
  return modo === 'server'
    ? { id: r.serverId, label: r.serverLabel, color: r.serverColor }
    : { id: projectKey(r.cwd), label: projectLabel(r.cwd), color: null };
}

// Agrupamento da lista de sessões (toggle Nenhum|Servidor|Projeto). Ordena UMA vez com
// sortSessions e depois só reparte: assim a ordem dentro de cada grupo e a ordem dos próprios
// grupos (nascem na posição do 1º membro) saem da mesma regra da lista lisa.
export function agruparSessoes(rows: AggSession[], modo: GroupBy): GrupoSessoes[] {
  const ordenadas = sortSessions(rows);
  if (modo === 'none') return [{ id: 'todas', label: '', color: null, sessions: ordenadas }];
  const por = new Map<string, GrupoSessoes>();
  for (const r of ordenadas) {
    const k = grupoDaSessao(r, modo);
    const g = por.get(k.id) ?? { ...k, sessions: [] };
    g.sessions.push(r);
    por.set(k.id, g);
  }
  return [...por.values()];
}
