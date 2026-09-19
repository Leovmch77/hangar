// Decisão de "o que fazer ao soltar" no arrasto-pra-agrupar do celular (Task 6). O hit-test em si
// (document.elementFromPoint) mora na tela, porque depende do DOM real; esta função só recebe a
// CHAVE já resolvida (ou null, quando o dedo soltou fora de qualquer linha) e decide entre pedir
// grupo, pedir saída ou não fazer nada — puro, sem DOM, testável sem montar a lista inteira. Mesma
// regra da Sidebar/Board/Canvas: soltar sobre uma linha válida pede o diálogo em modo agrupar;
// soltar no fundo (nenhuma linha sob o dedo) pede saída SE a origem já tiver grupo.
import { canPair, canLeave, type SessionInfo, type DropResult } from '@hangar/core';
import type { ChaveSessao } from './arrastarGrupo.svelte';

type SessaoComServidor = SessionInfo & { serverId: string };

export type DropDecision =
  | { kind: 'pair'; chave: string }
  | { kind: 'leave' }
  | { kind: 'none' };

export function dragChave(s: ChaveSessao): string {
  return `${s.serverId}::${s.name}`;
}

// T não aparece no retorno (DropDecision) — não precisa ser genérico, só SessaoComServidor[].
export function resolveDrop(
  hitChave: string | null,
  origemChave: ChaveSessao | null,
  rows: SessaoComServidor[],
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

// Formato mínimo de arrastarGrupo.svelte.ts que o arrasto HTML5 precisa — interface, não import,
// pra este módulo continuar sem Svelte e testável passando um store falso.
export interface DragGroupStore {
  origem: ChaveSessao | null;
  alvo: string | null;
  pedido: unknown;
  comecar(s: ChaveSessao): void;
  entrarEm(chave: string): void;
  sairDe(chave: string): void;
  soltar(alvoChave: string): void;
  pedirSaida(s: ChaveSessao): void;
  cancelar(): void;
}

// Mecânica do arrasto HTML5 nativo (Sidebar/Board): estava duplicada quase linha a linha nas duas
// telas (~60 linhas cada) — cada uma só monta as LISTAS (linhas + cabeçalho de cluster pareado,
// que mira o 1º membro do grupo) e pluga estes handlers no template.
export function createDragToGroup<T extends SessaoComServidor>(store: DragGroupStore, rows: () => T[]) {
  function sessionByKey(c: ChaveSessao | null): T | null {
    if (!c) return null;
    return rows().find((x) => x.serverId === c.serverId && x.name === c.name) ?? null;
  }
  function origemAtual(): T | null {
    return sessionByKey(store.origem);
  }
  function avaliarDrop(alvo: T | null): DropResult | null {
    const origem = origemAtual();
    return origem && alvo ? canPair(origem, alvo) : null;
  }
  function onDragStart(e: DragEvent, s: T) {
    store.comecar({ serverId: s.serverId, name: s.name });
    e.dataTransfer?.setData('text/plain', s.name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function onDragEnd() {
    // soltar()/pedirSaida() já abriram o pedido; só limpa quando o drop saiu fora de qualquer alvo.
    if (!store.pedido) store.cancelar();
  }
  function onTargetDragEnter(e: DragEvent, targetKey: string, alvo: T | null) {
    store.entrarEm(targetKey);
    if (avaliarDrop(alvo)?.ok) e.preventDefault();
  }
  // dragenter/dragleave borbulham dos FILHOS do alvo — mover o ponteiro de um filho pro outro
  // apagava o realce (sairDe do filho antigo) sem o dragenter do vizinho religar, e o dragover, que
  // segue disparando o tempo todo, não o recolocava. Reancorar AQUI a cada dragover mantém o alvo
  // aceso enquanto o ponteiro estiver dentro dele, não só na borda de entrada.
  function onTargetDragOver(e: DragEvent, targetKey: string, alvo: T | null) {
    if (!avaliarDrop(alvo)?.ok) return; // sem preventDefault o navegador já mostra o cursor de recusa
    e.preventDefault();
    if (store.alvo !== targetKey) store.entrarEm(targetKey);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function onTargetDragLeave(targetKey: string) {
    store.sairDe(targetKey);
  }
  function onTargetDrop(e: DragEvent, targetKey: string, alvo: T | null) {
    e.preventDefault();
    // dragover já filtrou; reconfere pra não confiar cego no gesto do SO.
    if (!avaliarDrop(alvo)?.ok) return;
    store.soltar(targetKey);
  }
  // Fundo (fora de qualquer linha/card/cabeçalho): soltar aqui pede saída do grupo da origem.
  function onBackgroundDragOver(e: DragEvent, isFundo: (e: DragEvent) => boolean) {
    if (!isFundo(e)) return;
    const origem = origemAtual();
    if (!origem || !canLeave(origem)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function onBackgroundDrop(e: DragEvent, isFundo: (e: DragEvent) => boolean) {
    if (!isFundo(e)) return;
    const chave = store.origem;
    const origem = origemAtual();
    if (!chave || !origem || !canLeave(origem)) return;
    e.preventDefault();
    store.pedirSaida(chave);
  }
  return {
    sessionByKey, avaliarDrop, onDragStart, onDragEnd,
    onTargetDragEnter, onTargetDragOver, onTargetDragLeave, onTargetDrop,
    onBackgroundDragOver, onBackgroundDrop,
  };
}
