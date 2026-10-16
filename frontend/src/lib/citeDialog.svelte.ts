import type { ContextRef } from '@hangar/core';

// Pedido aberto do modal "Responder ao trecho", vindo da pílula Citar. Quem mostra o modal é o Chat.
export interface CiteDialogRequest {
  draftKey: string;
  ref: ContextRef;
}

let request = $state<CiteDialogRequest | null>(null);

function openRequest(p: CiteDialogRequest) {
  // Campo de mensagem focado receberia o foco de volta ao close e abriria o teclado do celular.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('textarea, input')) active.blur();
  request = p;
}

export const citeDialog = {
  get request() { return request; },
  open(draftKey: string, ref: ContextRef) { openRequest({ draftKey, ref }); },
  close() { request = null; },
};
