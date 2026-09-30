import { create } from 'zustand';
import {
  basename, createSessionForServer, fetchSessionsForServer, getCreationProgress, getHistory,
  sendInputForServer, transitionFirstConversation,
} from '@hangar/core';
import type {
  ChatEvent, CreateSessionBody, FirstConversationAttempt, FirstConversationEvent, Server, SessionInfo,
} from '@hangar/core';
import { prefs } from './prefs';
import { useServers } from './servers';
import { readDraft, writeDraft } from './drafts';
import { submitConversationDraft } from './chat';
import * as m from '../paraglide/messages';

export type NewConversationIssue =
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; message: string; events?: ChatEvent[] }
  | { kind: 'in_progress'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'candidate'; message: string; session: SessionInfo }
  | { kind: 'recover_failed'; message: string }
  | { kind: 'local'; message: string };

export type NewConversationInput = {
  // Sem `name`, o store gera o nome estável; com ele, o nome escolhido fica congelado na tentativa.
  body: Omit<CreateSessionBody, 'name' | 'cwd'> & { cwd: string; name?: string };
  text: string;
};

type State = {
  attempts: Record<string, FirstConversationAttempt>;
  issues: Record<string, NewConversationIssue | null>;
  busy: Record<string, boolean>;
};

const KEY = (serverId: string) => `create.attempt.v1:${serverId}`;
const PHASES = new Set(['draft', 'creating', 'create_unknown', 'created', 'sending', 'send_unknown', 'sent']);
// Promessas em voo por servidor: dois toques (ou remontagem) no meio do GET/POST recebem a mesma.
const inFlight = new Map<string, Promise<void>>();

export const useNewConversation = create<State>(() => ({ attempts: {}, issues: {}, busy: {} }));

function setIssue(serverId: string, issue: NewConversationIssue | null) {
  useNewConversation.setState((s) => ({ issues: { ...s.issues, [serverId]: issue } }));
}

function isAttempt(value: unknown, serverId: string): value is FirstConversationAttempt {
  if (value === null || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  const body = a.body as Record<string, unknown> | null;
  return typeof a.id === 'string' && a.serverId === serverId && typeof a.text === 'string'
    && typeof a.phase === 'string' && PHASES.has(a.phase)
    && (a.sessionName === null || typeof a.sessionName === 'string')
    && body !== null && typeof body === 'object'
    && typeof body.name === 'string' && typeof body.cwd === 'string';
}

// Grava antes de publicar na memória: o que a tela mostra sempre existe no disco.
function persist(attempt: FirstConversationAttempt): void {
  prefs.set(KEY(attempt.serverId), JSON.stringify(attempt));
  // O ACK da criação fica guardado mesmo se a transferência ao rascunho falhar.
  if (attempt.sessionName && !readDraft(attempt.serverId, attempt.sessionName)) {
    writeDraft(attempt.serverId, attempt.sessionName, {
      version: 1, text: attempt.phase === 'sent' ? '' : attempt.text, revision: 1,
      transcript: null, attachment: null, submission: null,
    });
  }
  useNewConversation.setState((s) => ({ attempts: { ...s.attempts, [attempt.serverId]: attempt } }));
}

// Só aplica o evento se a tentativa gravada ainda é a mesma: resultado antigo nunca pisa na nova.
function apply(attempt: FirstConversationAttempt, event: FirstConversationEvent): FirstConversationAttempt | null {
  const current = useNewConversation.getState().attempts[attempt.serverId];
  if (!current || current.id !== attempt.id) return null;
  const next = transitionFirstConversation(current, event);
  if (next !== current) persist(next);
  return next;
}

function serverById(serverId: string): Server | null {
  return useServers.getState().servers.find((s) => s.id === serverId) ?? null;
}

function statusOf(cause: unknown): number | null {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : m.criar_sessao_erro();
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function stableName(cwd: string, id: string): string {
  const clean = basename(cwd).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'sessao';
  return `${clean}-${id.slice(-4)}`;
}

// Processo reaberto: creating/sending não voltam a disparar POST, viram incertos.
export function restoreAttempt(serverId: string): FirstConversationAttempt | null {
  const raw = prefs.getString(KEY(serverId));
  if (raw === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!isAttempt(parsed, serverId)) {
    console.warn('Tentativa de nova conversa inválida; descartada.');
    prefs.remove(KEY(serverId));
    return null;
  }
  const memory = useNewConversation.getState().attempts[serverId];
  if (memory?.id === parsed.id && inFlight.has(serverId)) return memory;
  let attempt = parsed;
  if (attempt.phase === 'creating') attempt = transitionFirstConversation(attempt, { type: 'create_unknown' });
  if (attempt.phase === 'sending') attempt = transitionFirstConversation(attempt, { type: 'send_unknown' });
  try { persist(attempt); } catch {
    setIssue(serverId, { kind: 'local', message: m.nova_conversa_salvar_erro() });
    return null;
  }
  if (attempt.phase === 'create_unknown' && !useNewConversation.getState().issues[serverId]) {
    setIssue(serverId, { kind: 'unknown', message: m.nova_conversa_criacao_incerta() });
  }
  if (attempt.phase === 'send_unknown' && !useNewConversation.getState().issues[serverId]) {
    setIssue(serverId, { kind: 'unknown', message: m.nova_conversa_envio_incerto() });
  }
  return attempt;
}

async function runCreate(serverId: string, input: NewConversationInput): Promise<void> {
  const current = useNewConversation.getState().attempts[serverId] ?? restoreAttempt(serverId);
  if (!current && prefs.getString(KEY(serverId)) !== undefined) return;
  if (current && current.phase !== 'draft') return;

  const server = serverById(serverId);
  if (!server) { setIssue(serverId, { kind: 'local', message: m.nova_conversa_servidor_ausente() }); return; }

  // Nome escolhido pela pessoa não ganha sufixo: conflito volta como 409 e ela decide.
  const explicit = input.body.name?.trim();
  let id = newId();
  if (!explicit) {
    // O backend ainda arbitra o conflito; a lista só evita um nome já visível.
    let taken = new Set<string>();
    try { taken = new Set((await fetchSessionsForServer(server)).map((s) => s.name)); } catch { /* backend decide */ }
    while (taken.has(stableName(input.body.cwd, id))) id = newId();
  }
  const draft: FirstConversationAttempt = {
    id, serverId, text: input.text, phase: 'draft', sessionName: null,
    body: { ...input.body, name: explicit || stableName(input.body.cwd, id) },
  };
  const creating = transitionFirstConversation(draft, { type: 'begin' });
  try { persist(creating); } catch {
    setIssue(serverId, { kind: 'local', message: m.nova_conversa_salvar_erro() });
    return;
  }
  setIssue(serverId, null);

  let session: SessionInfo;
  try {
    session = await createSessionForServer(server, creating.body);
  } catch (cause) {
    const status = statusOf(cause);
    // 4xx definitivo não criou nada; 409, 408, 5xx e rede podem ter criado.
    const rejected = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409;
    if (!apply(creating, { type: rejected ? 'create_rejected' : 'create_unknown' })) return;
    setIssue(serverId, rejected
      ? { kind: 'rejected', message: messageOf(cause) }
      : status === 409
        ? { kind: 'conflict', message: messageOf(cause) }
        : { kind: 'unknown', message: m.nova_conversa_criacao_incerta() });
    return;
  }
  try { apply(creating, { type: 'create_ok', sessionName: session.name }); } catch {
    // Mantém uma recuperação por leitura disponível, sem publicar destino sem rascunho durável.
    useNewConversation.setState((s) => ({ attempts: { ...s.attempts, [serverId]: {
      ...creating, phase: 'create_unknown',
    } } }));
    setIssue(serverId, { kind: 'local', message: m.nova_conversa_salvar_erro() });
  }
}

function exclusive(serverId: string, work: () => Promise<void>): Promise<void> {
  const running = inFlight.get(serverId);
  if (running) return running;
  useNewConversation.setState((s) => ({ busy: { ...s.busy, [serverId]: true } }));
  const run = work().finally(() => {
    inFlight.delete(serverId);
    useNewConversation.setState((s) => ({ busy: { ...s.busy, [serverId]: false } }));
  });
  inFlight.set(serverId, run);
  return run;
}

// Único caminho que cria. Só sai POST quando não há tentativa ou ela ainda é rascunho.
export function beginAttempt(serverId: string, input: NewConversationInput): Promise<void> {
  return exclusive(serverId, () => runCreate(serverId, input));
}

// A criação e o input são ações separadas; só a sessão já gravada recebe este snapshot.
export function sendFirstInput(serverId: string, attemptId: string): Promise<void> {
  return exclusive(serverId, async () => {
    const attempt = useNewConversation.getState().attempts[serverId] ?? restoreAttempt(serverId);
    if (!attempt || attempt.id !== attemptId || attempt.phase !== 'created' || !attempt.sessionName) return;
    const server = serverById(serverId);
    if (!server) { setIssue(serverId, { kind: 'local', message: m.nova_conversa_servidor_ausente() }); return; }
    let sending: FirstConversationAttempt | null;
    try { sending = apply(attempt, { type: 'send_begin' }); } catch {
      setIssue(serverId, { kind: 'local', message: m.nova_conversa_salvar_erro() });
      return;
    }
    if (!sending) return;
    setIssue(serverId, null);

    // O catch da rede não pode interpretar uma falha posterior no disco como recusa do servidor.
    let posted = false;
    let acked = false;
    try {
      await submitConversationDraft(serverId, attempt.sessionName, sending.text,
        async () => {
          posted = true;
          await sendInputForServer(server, attempt.sessionName!, sending.text);
          acked = true;
        });
    } catch (cause) {
      if (!posted) {
        try { apply(sending, { type: 'send_rejected' }); } catch {
          // A tentativa durável permanece disponível quando o próprio rollback não pode ser salvo.
        }
        setIssue(serverId, { kind: 'local', message: messageOf(cause) });
        return;
      }
      if (acked) {
        try { apply(sending, { type: 'send_ok' }); } catch {
          setIssue(serverId, { kind: 'local', message: m.nova_conversa_resultado_salvar_erro() });
          return;
        }
        setIssue(serverId, { kind: 'local', message: messageOf(cause) });
        return;
      }
      const status = statusOf(cause);
      const rejected = status !== null && status >= 400 && status < 500 && status !== 408;
      try {
        if (!apply(sending, { type: rejected ? 'send_rejected' : 'send_unknown' })) return;
      } catch {
        setIssue(serverId, { kind: 'local', message: m.nova_conversa_resultado_salvar_erro() });
        return;
      }
      setIssue(serverId, rejected
        ? { kind: 'rejected', message: m.nova_conversa_envio_recusado({ erro: messageOf(cause) }) }
        : { kind: 'unknown', message: m.nova_conversa_envio_incerto() });
      return;
    }
    try { apply(sending, { type: 'send_ok' }); } catch {
      setIssue(serverId, { kind: 'local', message: m.nova_conversa_resultado_salvar_erro() });
    }
  });
}

// A rota lê sem consumir: sent não vira draft; sending/incerto exigem conferir antes de reenviar.
export function readFirstInput(serverId: string, name: string): FirstConversationAttempt | null {
  const attempt = useNewConversation.getState().attempts[serverId] ?? restoreAttempt(serverId);
  if (!attempt || attempt.sessionName !== name || attempt.phase === 'draft'
    || attempt.phase === 'creating' || attempt.phase === 'create_unknown') return null;
  return attempt;
}

// Finaliza somente o snapshot cujo ACK já foi gravado, nunca uma tentativa nova ou incerta.
export function confirmFirstInput(attemptId: string): void {
  const attempt = Object.values(useNewConversation.getState().attempts).find((a) => a.id === attemptId);
  if (attempt?.phase !== 'sent') return;
  try { persist(attempt); } catch {
    setIssue(attempt.serverId, { kind: 'local', message: m.nova_conversa_resultado_salvar_erro() });
    return;
  }
  discardAttempt(attempt.serverId, attemptId);
}

// Consulta lista e progresso do MESMO servidor e nome; nunca cria e nunca troca de nome.
export function recoverAttempt(serverId: string): Promise<void> {
  return exclusive(serverId, async () => {
    const attempt = useNewConversation.getState().attempts[serverId];
    if (!attempt || (attempt.phase !== 'create_unknown' && attempt.phase !== 'send_unknown')) return;
    const server = serverById(serverId);
    if (!server) { setIssue(serverId, { kind: 'local', message: m.nova_conversa_servidor_ausente() }); return; }
    const name = attempt.body.name;
    if (attempt.phase === 'send_unknown' && attempt.sessionName) {
      try {
        const events = await getHistory(attempt.sessionName, 120, undefined, 10000, server);
        // Histórico inclui fila, mas texto igual não identifica este POST.
        setIssue(serverId, { kind: 'unknown', message: m.nova_conversa_envio_incerto(), events });
      } catch (cause) {
        setIssue(serverId, { kind: 'recover_failed', message: m.nova_conversa_envio_conferir_erro({ erro: messageOf(cause) }) });
      }
      return;
    }
    try {
      const found = (await fetchSessionsForServer(server)).find((s) => s.name === name);
      if (found) {
        const compatible = found.cwd === attempt.body.cwd
          && (found.provider ?? 'claude') === (attempt.body.provider ?? 'claude');
        setIssue(serverId, compatible
          ? { kind: 'candidate', message: m.nova_conversa_candidata({ nome: name }), session: found }
          : { kind: 'conflict', message: m.nova_conversa_nome_conflito({ nome: name }) });
        return;
      }
      // Lista vazia não prova que falhou: a criação pode estar em curso ou a lista atrasada.
      const progress = await getCreationProgress(name, server);
      setIssue(serverId, progress.step
        ? { kind: 'in_progress', message: m.nova_conversa_criando() }
        : { kind: 'not_found', message: m.nova_conversa_nao_encontrada() });
    } catch (cause) {
      setIssue(serverId, { kind: 'recover_failed', message: m.nova_conversa_conferir_erro({ erro: messageOf(cause) }) });
    }
  });
}

// Ação explícita da pessoa depois de revisar a candidata: adota a sessão como criada.
export function adoptCandidate(serverId: string, attemptId: string): boolean {
  const issue = useNewConversation.getState().issues[serverId];
  const attempt = useNewConversation.getState().attempts[serverId];
  if (issue?.kind !== 'candidate' || attempt?.id !== attemptId) return false;
  let next: FirstConversationAttempt | null;
  try { next = apply(attempt, { type: 'create_ok', sessionName: issue.session.name }); } catch {
    setIssue(serverId, { kind: 'local', message: m.nova_conversa_salvar_erro() });
    return false;
  }
  if (!next) return false;
  setIssue(serverId, null);
  return true;
}

// Descartar é sempre pedido explícito; nada aqui avisa o servidor nem apaga sessão remota.
export function discardAttempt(serverId: string, attemptId: string): void {
  if (inFlight.has(serverId)) return;
  const attempt = useNewConversation.getState().attempts[serverId];
  if (attempt?.id !== attemptId) return;
  prefs.remove(KEY(serverId));
  useNewConversation.setState((s) => {
    const attempts = { ...s.attempts };
    delete attempts[serverId];
    return { attempts, issues: { ...s.issues, [serverId]: null } };
  });
}

export function _resetNewConversationForTests(): void {
  inFlight.clear();
  useNewConversation.setState({ attempts: {}, issues: {}, busy: {} });
}
