import { create } from 'zustand';
import { clampContextRefComment, type ContextRef } from '@hangar/core';

// Citações esperando envio, por conversa (`<servidor>::<sessão>`). Só em memória, como na PWA: o
// toque em "Citar" da resposta põe aqui, a bandeja do Composer lê e o envio tira o que foi.
// Cada item ganha um `draftId` ao entrar: editar o comentário troca o objeto, e o envio tira da
// bandeja pelo id, não pelo objeto que levou.
export type DraftContextRef = ContextRef & { draftId: string };

interface ContextRefsState {
  drafts: Record<string, DraftContextRef[]>;
}

export const useContextRefs = create<ContextRefsState>(() => ({ drafts: {} }));

const EMPTY: DraftContextRef[] = [];
let nextId = 0;

export function contextRefsKey(serverId: string | undefined, name: string | undefined): string {
  return `${serverId ?? ''}::${name ?? ''}`;
}

export function useContextRefsFor(key: string): DraftContextRef[] {
  return useContextRefs((s) => s.drafts[key] ?? EMPTY);
}

/** A bandeja agora, fora de um componente (o envio automático do ditado lê na hora de enviar). */
export function contextRefsSnapshot(key: string): DraftContextRef[] {
  return useContextRefs.getState().drafts[key] ?? EMPTY;
}

function set(key: string, next: (refs: DraftContextRef[]) => DraftContextRef[]) {
  useContextRefs.setState((s) => {
    const refs = next(s.drafts[key] ?? EMPTY);
    const drafts = { ...s.drafts };
    if (refs.length) drafts[key] = refs;
    else delete drafts[key];
    return { drafts };
  });
}

export function addContextRef(key: string, ref: ContextRef) {
  set(key, (refs) => [...refs, { ...ref, draftId: `cref-${++nextId}` }]);
}

export function removeContextRef(key: string, index: number) {
  set(key, (refs) => refs.filter((_, i) => i !== index));
}

// Guarda o que a pessoa digitou, sem aparar (aparar a cada tecla comeria o espaço entre palavras no
// campo controlado): quem apara é a montagem do bloco.
export function setContextRefComment(key: string, index: number, comment: string) {
  set(key, (refs) => refs.map((r, i) => (i === index ? { ...r, comment: clampContextRefComment(comment) } : r)));
}

/** Tira só as enviadas: o que entrou na bandeja durante o envio fica. */
export function removeSentContextRefs(key: string, sent: readonly DraftContextRef[]) {
  const ids = new Set(sent.map((r) => r.draftId));
  set(key, (refs) => refs.filter((r) => !ids.has(r.draftId)));
}
