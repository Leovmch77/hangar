// Decisão de "o que fazer ao soltar" no arrasto-pra-agrupar do celular (Task 6). O hit-test em si
// (document.elementFromPoint) mora na tela, porque depende do DOM real; esta função só recebe a
// CHAVE já resolvida (ou null, quando o dedo soltou fora de qualquer linha) e decide entre pedir
// grupo, pedir saída ou não fazer nada — puro, sem DOM, testável sem montar a lista inteira. Mesma
// regra da Sidebar/Board/Canvas: soltar sobre uma linha válida pede o diálogo em modo agrupar;
// soltar no fundo (nenhuma linha sob o dedo) pede saída SE a origem já tiver grupo.
import { canPair, canLeave, type SessionInfo } from '@hangar/core';

type SessaoComServidor = SessionInfo & { serverId: string };
export interface ChaveSessao { serverId: string; name: string }

export type DropDecision =
  | { kind: 'pair'; chave: string }
  | { kind: 'leave' }
  | { kind: 'none' };

export function dragChave(s: ChaveSessao): string {
  return `${s.serverId}::${s.name}`;
}

export function resolveDrop<T extends SessaoComServidor>(
  hitChave: string | null,
  origemChave: ChaveSessao | null,
  rows: T[],
): DropDecision {
  const origem = origemChave
    ? (rows.find((r) => r.serverId === origemChave.serverId && r.name === origemChave.name) ?? null)
    : null;
  if (hitChave) {
    const alvo = rows.find((r) => dragChave(r) === hitChave) ?? null;
    if (origem && alvo && canPair(origem, alvo).ok) return { kind: 'pair', chave: hitChave };
    return { kind: 'none' };
  }
  if (origem && canLeave(origem)) return { kind: 'leave' };
  return { kind: 'none' };
}

// Perto do topo/rodapé da lista -> rola sozinho enquanto o dedo fica ali (sem isso não dá pra
// alcançar uma sessão fora da tela: a lista do celular é rolagem pura, sem paginação).
export function autoScrollDir(clientY: number, rectTop: number, rectBottom: number, edge: number): -1 | 0 | 1 {
  if (clientY < rectTop + edge) return -1;
  if (clientY > rectBottom - edge) return 1;
  return 0;
}
