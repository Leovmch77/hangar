import { clampContextRefComment, type ContextRef } from '@hangar/core';

// Citações esperando envio, por sessão (`<servidor>::<sessão>`). Só em memória, como o cache de
// anexos do Composer: a bandeja sobrevive à troca de conversa, não à recarga da página.
// Cada item ganha um `draftId` ao entrar: editar o comentário troca o objeto, e o envio tira da
// bandeja pelo id, não pelo objeto que levou.
export type DraftContextRef = ContextRef & { draftId: string };

let drafts = $state<Record<string, DraftContextRef[]>>({});
let nextId = 0;

export function contextRefsKey(serverId: string | undefined, sessionName: string): string {
  return `${serverId ?? ''}::${sessionName}`;
}

function set(key: string, refs: DraftContextRef[]) {
  if (refs.length) drafts[key] = refs;
  else delete drafts[key];
}

export const contextRefsDraft = {
  get(key: string): DraftContextRef[] {
    return drafts[key] ?? [];
  },
  add(key: string, ref: ContextRef) {
    set(key, [...(drafts[key] ?? []), { ...ref, draftId: `cref-${++nextId}` }]);
  },
  remove(key: string, index: number) {
    set(key, (drafts[key] ?? []).filter((_, i) => i !== index));
  },
  // Guarda o que a pessoa digitou, sem aparar (aparar a cada tecla comeria o espaço entre palavras):
  // quem apara é a montagem do bloco.
  setComment(key: string, index: number, comment: string) {
    const refs = drafts[key];
    if (!refs?.[index]) return;
    set(key, refs.map((r, i) => (i === index ? { ...r, comment: clampContextRefComment(comment) } : r)));
  },
  /** Tira só as que foram enviadas: o que entrou na bandeja durante o envio fica. */
  removeSent(key: string, sent: readonly DraftContextRef[]) {
    const ids = new Set(sent.map((r) => r.draftId));
    set(key, (drafts[key] ?? []).filter((r) => !ids.has(r.draftId)));
  },
};
