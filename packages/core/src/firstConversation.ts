import type { CreateSessionBody } from './api';

export type FirstConversationPhase = 'draft' | 'creating' | 'create_unknown'
  | 'created' | 'sending' | 'send_unknown' | 'sent';

export type FirstConversationAttempt = {
  id: string;
  serverId: string;
  body: CreateSessionBody & { cwd: string };
  text: string;
  phase: FirstConversationPhase;
  sessionName: string | null;
};

export type FirstConversationEvent =
  | { type: 'begin' }
  | { type: 'create_ok'; sessionName: string }
  | { type: 'create_rejected' }
  | { type: 'create_unknown' }
  | { type: 'send_begin' }
  | { type: 'send_ok' }
  | { type: 'send_rejected' }
  | { type: 'send_unknown' };

export type FirstConversationEffect = 'create' | 'send' | 'recover' | 'none';

// Só draft cria e só created envia; fases incertas nunca repetem o POST, só consultam.
export function firstConversationEffect(phase: FirstConversationPhase): FirstConversationEffect {
  if (phase === 'draft') return 'create';
  if (phase === 'created') return 'send';
  if (phase === 'create_unknown' || phase === 'send_unknown') return 'recover';
  return 'none';
}

// Evento fora da fase devolve a MESMA tentativa: quem chama compara referência para saber que nada mudou.
export function transitionFirstConversation(
  attempt: FirstConversationAttempt, event: FirstConversationEvent,
): FirstConversationAttempt {
  const to = (phase: FirstConversationPhase, sessionName = attempt.sessionName) =>
    ({ ...attempt, phase, sessionName });
  const { phase } = attempt;
  switch (event.type) {
    case 'begin':
      return phase === 'draft' ? to('creating') : attempt;
    case 'create_ok':
      return phase === 'creating' || phase === 'create_unknown' ? to('created', event.sessionName) : attempt;
    case 'create_rejected':
      return phase === 'creating' ? to('draft', null) : attempt;
    case 'create_unknown':
      return phase === 'creating' ? to('create_unknown') : attempt;
    case 'send_begin':
      return phase === 'created' ? to('sending') : attempt;
    case 'send_ok':
      // O snapshot (texto) fica até o handoff confirmar: limpar aqui apagaria o rascunho errado.
      return phase === 'sending' ? to('sent') : attempt;
    case 'send_rejected':
      return phase === 'sending' ? to('created') : attempt;
    case 'send_unknown':
      return phase === 'sending' ? to('send_unknown') : attempt;
  }
}
