import {
  comTeto, splitContextRefs, errorDetail, parseImageMessage, parsePeerMessage,
  probeServerResponse, type AnswerItem, type AskQuestionPayload, type ChatEvent, type Server,
} from '@hangar/core';
import * as m from '../paraglide/messages';

export type DeliveryMode = 'queued' | 'direct' | 'jev';
export type QueueSendMode = 'steer' | { kind: 'direct'; terminalClaude: boolean } | { kind: 'jev'; task: string; message: string };
export type DeliveryFeedback = { text: string; warning: boolean };
export type JevStatus = 'loading' | 'ready' | 'setup' | 'unsupported' | 'error';
export type DeliveryControls = { mode: DeliveryMode; status: JevStatus; help: string };

const chars = (value: string, count: number) => Array.from(value).slice(0, count).join('');
const caption = (value: string) => {
  const body = parseImageMessage(value)?.caption ?? value;
  return splitContextRefs(body)?.typed ?? body;
};

export function queueSendMode(mode: DeliveryMode, ready: boolean, state: string, provider: string | null | undefined,
  headless: boolean, message: string, events: ChatEvent[], ask: AskQuestionPayload | null): QueueSendMode | undefined {
  if (state !== 'working' || (provider !== 'claude' && provider !== 'codex') || message.trimStart().startsWith('/')) return;
  if (mode === 'direct') return { kind: 'direct', terminalClaude: provider === 'claude' && !headless };
  if (mode !== 'jev' || !ready) return;
  let latest = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'user_msg' && !event.id.startsWith('queued-') && !event.id.startsWith('pending-') && !parsePeerMessage(caption(event.text ?? ''))) {
      latest = i; break;
    }
  }
  const task = latest < 0 ? '' : caption(events[latest].text ?? '');
  const recent = ask?.is_async ? ask.questions.map((q) => q.question).join('\n')
    : events.slice(latest + 1).reverse().find((e) => e.kind === 'assistant_msg' && e.text?.trim())?.text ?? '';
  let context = !recent.trim() ? chars(task, 1000)
    : `Pedido atual:\n${chars(task, 350)}\n\nFala recente do agente:\n${Array.from(recent).slice(-600).join('')}`;
  if (Array.from(message).length > 2000) context = '';
  return { kind: 'jev', task: context, message: chars(message, 2000) };
}

export function timingFeedback(note: string): DeliveryFeedback {
  const values: Record<string, () => string> = {
    direct: m.native_queue_jev_direct, queue: m.native_queue_jev_queued, delivered: m.native_queue_jev_delivered,
    uncertain: m.native_queue_jev_uncertain, no_context: m.native_queue_jev_no_context, timeout: m.native_queue_jev_timeout,
    work_changed: m.native_queue_jev_work_changed, refused: m.native_queue_jev_refused,
  };
  return { text: (Object.hasOwn(values, note) ? values[note] : m.native_queue_jev_unavailable)(), warning: !['direct', 'queue', 'delivered'].includes(note) };
}

async function request(server: Server, path: string, init: RequestInit): Promise<unknown> {
  const response = await probeServerResponse(server, path, init);
  if (!response.ok) throw Object.assign(new Error(`${response.status}: ${await errorDetail(response)}`), { status: response.status });
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(m.mobile_machines_invalid_response(), { cause: error });
    throw error;
  }
}

export async function readQueueJev(server: Server, signal: AbortSignal): Promise<boolean> {
  const value = await request(server, '/api/jev/delivery', { signal: comTeto(signal, 10_000) });
  if (!value || typeof value !== 'object' || typeof (value as { available?: unknown }).available !== 'boolean') {
    throw new Error(m.mobile_machines_invalid_response());
  }
  return (value as { available: boolean }).available;
}

export async function sendWithDelivery(server: Server, name: string, text: string, mode: Exclude<QueueSendMode, 'steer'>): Promise<DeliveryFeedback | null> {
  const steer = mode.kind === 'direct' && !mode.terminalClaude;
  const body = mode.kind === 'jev' ? { text, jev_task: mode.task, jev_message: mode.message }
    : steer ? { text } : { text, steer: true };
  // Sem timeout: cancelar a espera não desfaz um envio que o servidor já recebeu.
  const result = await request(server, `/api/sessions/${encodeURIComponent(name)}/${steer ? 'steer' : 'input'}`,
    { method: 'POST', signal: undefined, body: JSON.stringify(body) });
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) throw new Error(m.native_action_uncertain());
  if (mode.kind === 'direct') return steer || (result as { steered?: unknown }).steered === true
    ? { text: m.native_queue_panel_steered(), warning: false } : null;
  const note = (result as { timing_note?: unknown }).timing_note;
  return typeof note === 'string' ? timingFeedback(note) : { text: m.native_action_uncertain(), warning: true };
}

export async function answerWithDelivery(server: Server, name: string, answers: AnswerItem[], displayed: AskQuestionPayload): Promise<{ ok: boolean; fallback?: boolean }> {
  const result = await request(server, `/api/sessions/${encodeURIComponent(name)}/answer`, {
    method: 'POST', signal: undefined,
    body: JSON.stringify({ answers, request_id: displayed.request_id, interaction_id: displayed.interaction_id, steer: true }),
  });
  if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') throw new Error(m.native_action_uncertain());
  return result as { ok: boolean; fallback?: boolean };
}
