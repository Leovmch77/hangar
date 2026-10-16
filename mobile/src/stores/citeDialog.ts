import { create } from 'zustand';
import type { ContextRef } from '@hangar/core';

// Modal "Responder ao trecho": aberto pelo "Citar" do menu da seleção, mostrado pelo Composer da
// mesma conversa (`draftKey`). `finished` diz à lista, no fechamento, se ela volta ao ponto de
// leitura (Comentar e continuar, Cancelar) ou vai ao fim (Finalizar). `id` distingue cada abertura:
// o modal recomeça o comentário a partir dela.
export interface CiteRequest { id: number; draftKey: string; ref: ContextRef }

interface CiteDialogState {
  request: CiteRequest | null;
  finished: boolean;
}

export const useCiteDialog = create<CiteDialogState>(() => ({ request: null, finished: false }));

let nextRequestId = 0;

export function openCiteDialog(draftKey: string, ref: ContextRef) {
  useCiteDialog.setState({ request: { id: ++nextRequestId, draftKey, ref }, finished: false });
}

export function closeCiteDialog(finished = false) {
  useCiteDialog.setState({ request: null, finished });
}
