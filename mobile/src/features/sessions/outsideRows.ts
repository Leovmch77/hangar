import { projectKey, projectLabel, type AggSession, type GroupBy, type GrupoSessoes } from '@hangar/core';

// A sessão de fora não é grupo próprio: fica logo abaixo da sessão do par, no grupo dela (mesma
// regra de chave do `agruparSessoes`). `all` acha a sessão do par quando ela está em "Precisa de você".
export function placeOutside(groups: GrupoSessoes[], outside: AggSession[], modo: GroupBy, all: AggSession[]): GrupoSessoes[] {
  if (!outside.length) return groups;
  const out = groups.map((g) => ({ ...g, sessions: [...g.sessions] }));
  for (const row of outside) {
    const o = row.outside!;
    const isAnchor = (s: AggSession) => s.serverId === o.localServerId && s.name === o.localSession;
    let g = out.find((x) => x.sessions.some(isAnchor));
    if (g) {
      // Depois da sessão do par e das de fora que já entraram abaixo dela.
      let i = g.sessions.findIndex(isAnchor) + 1;
      while (g.sessions[i]?.outside?.localSession === o.localSession && g.sessions[i]?.outside?.localServerId === o.localServerId) i++;
      g.sessions.splice(i, 0, row);
      continue;
    }
    const anchor = all.find(isAnchor);
    // ponytail: sessão do par escondida pela busca leva a de fora junto
    if (!anchor) continue;
    const id = modo === 'server' ? anchor.serverId : modo === 'project' ? projectKey(anchor.cwd) : 'todas';
    g = out.find((x) => x.id === id);
    if (g) { g.sessions.push(row); continue; }
    out.push({
      id,
      label: modo === 'server' ? anchor.serverLabel : modo === 'project' ? projectLabel(anchor.cwd) : '',
      color: modo === 'server' ? anchor.serverColor : null,
      sessions: [row],
    });
  }
  return out;
}
