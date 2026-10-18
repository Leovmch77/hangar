import { derivedQueuePanel, pendingAskFromEvents, pendingProposedPlan, pendingReplyPlan } from '@hangar/core';
import type { ChatEvent, Provider, QueuePanel } from '@hangar/core';

type Plan = ReturnType<typeof pendingProposedPlan>;
type Projection = { queuePanel: QueuePanel; pendingAsk: ChatEvent | null; proposedPlan: Plan; replyPlan: Plan };
const samePlan = (a: Plan, b: Plan) => a?.id === b?.id && a?.plan === b?.plan;

export function createEventProjection() {
  let cursor: { length: number; revision: number } | null = null;
  let queue: QueuePanel = { entries: [], actions: false };
  let lastPi: ChatEvent | null = null;
  let lastKimi: ChatEvent | null = null;
  const answered = new Set<string>();
  let proposed: Plan = null;
  let reply: Plan = null;
  let snapshot: Projection = { queuePanel: queue, pendingAsk: null, proposedPlan: null, replyPlan: null };

  return (events: ChatEvent[], revision: number, provider: Provider | null, serverQueue: QueuePanel | null = null): Projection => {
    const previousQueue = queue;
    const append = cursor !== null && cursor.revision === revision && events.length >= cursor.length;
    const start = append ? cursor!.length : 0;
    if (!append) {
      queue = { entries: [], actions: false };
      lastPi = lastKimi = null;
      answered.clear();
      proposed = reply = null;
    }
    for (let index = start; index < events.length; index++) {
      const ev = events[index];
      const entry = derivedQueuePanel([ev]).entries;
      if (entry.length) queue = { entries: [...queue.entries, ...entry], actions: false };
      if (ev.kind === 'tool_result' && ev.tool_use_id) answered.add(ev.tool_use_id);
      if (ev.kind === 'tool_use') {
        lastPi = pendingAskFromEvents([ev], 'pi') ?? lastPi;
        lastKimi = pendingAskFromEvents([ev], 'kimi') ?? lastKimi;
      }
      if (ev.kind === 'user_msg' && !ev.id.startsWith('queued-')) {
        proposed = reply = null;
      } else {
        proposed = pendingProposedPlan([ev]) ?? proposed;
        reply = pendingReplyPlan([ev]) ?? reply;
      }
    }
    if (!append && queue.entries.length === previousQueue.entries.length && queue.entries.every((entry, index) => {
      const previous = previousQueue.entries[index];
      return entry.id === previous.id && entry.text === previous.text && entry.ts === previous.ts;
    })) queue = previousQueue;
    cursor = { length: events.length, revision };
    const lastAsk = provider === 'pi' ? lastPi : provider === 'kimi' ? lastKimi : null;
    const pendingAsk = lastAsk && !answered.has(lastAsk.tool_use_id!) ? lastAsk : null;
    const queuePanel = serverQueue ?? queue;
    if (snapshot.queuePanel !== queuePanel || snapshot.pendingAsk !== pendingAsk
        || !samePlan(snapshot.proposedPlan, proposed) || !samePlan(snapshot.replyPlan, reply)) {
      snapshot = {
        queuePanel, pendingAsk,
        proposedPlan: samePlan(snapshot.proposedPlan, proposed) ? snapshot.proposedPlan : proposed,
        replyPlan: samePlan(snapshot.replyPlan, reply) ? snapshot.replyPlan : reply,
      };
    }
    return snapshot;
  };
}
