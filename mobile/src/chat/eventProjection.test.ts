import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@hangar/core';
import { createEventProjection } from './eventProjection';

const event = (id: string, kind: ChatEvent['kind'], extra: Partial<ChatEvent> = {}): ChatEvent => ({ id, kind, ...extra });

describe('eventProjection', () => {
  it('processa 200 appends sem reler os 5000 eventos aquecidos', () => {
    let historicalReads = 0;
    let events = Array.from({ length: 5000 }, (_, index): ChatEvent => ({
      id: `history-${index}`,
      get kind(): ChatEvent['kind'] { historicalReads++; return 'assistant_msg'; },
      text: 'resposta sem plano',
    }));
    const project = createEventProjection();
    project(events, 0, 'pi');
    historicalReads = 0;
    for (let index = 0; index < 200; index++) {
      events = [...events, event(`new-${index}`, 'assistant_msg', { text: `resposta ${index}` })];
      const result = project(events, 0, 'pi');
      expect(result.queuePanel.entries).toEqual([]);
      expect(result.pendingAsk).toBeNull();
      expect(result.proposedPlan).toBeNull();
      expect(result.replyPlan).toEqual({ id: `new-${index}`, plan: `resposta ${index}` });
    }
    expect(historicalReads).toBe(0);
  });

  it('reconstrói em replace, prepend, remoção, reset e redução sem confundir com append', () => {
    const project = createEventProjection();
    const head = event('head', 'notice');
    const old = event('reply', 'assistant_msg', { text: 'antiga' });
    project([head, old], 0, 'codex');
    const changed = event('reply', 'assistant_msg', { text: '<proposed_plan>\n# Novo\n</proposed_plan>' });
    expect(project([head, changed], 1, 'codex').proposedPlan).toEqual({ id: 'reply', plan: '# Novo' });
    const queued = event('queued-q', 'user_msg', { text: 'antes', queued_delivered: false });
    expect(project([queued, head, changed], 2, 'codex').queuePanel.entries).toEqual([{ id: 'q', text: 'antes', ts: null }]);
    expect(project([head, changed], 3, 'codex').queuePanel.entries).toEqual([]);
    expect(project([head], 3, 'codex').proposedPlan).toBeNull();
    const reset = project([], 4, 'codex');
    expect(reset).toEqual({ queuePanel: { entries: [], actions: false }, pendingAsk: null, proposedPlan: null, replyPlan: null });
    expect(project([old], 4, 'codex').replyPlan).toEqual({ id: 'reply', plan: 'antiga' });
  });

  it('mantém a última pergunta por provider e fecha com resultado mesmo anterior à tool', () => {
    const project = createEventProjection();
    const pi = event('pi-q', 'tool_use', { tool_name: 'question', tool_use_id: 'pi' });
    const kimi = event('kimi-q', 'tool_use', { tool_name: 'AskUserQuestion', tool_use_id: 'kimi' });
    const events = [pi, kimi];
    expect(project(events, 0, 'pi').pendingAsk).toBe(pi);
    expect(project(events, 0, 'kimi').pendingAsk).toBe(kimi);
    expect(project(events, 0, 'claude').pendingAsk).toBeNull();
    events.push(event('pi-answer', 'tool_result', { tool_use_id: 'pi' }));
    expect(project(events, 0, 'pi').pendingAsk).toBeNull();
    expect(project(events, 0, 'kimi').pendingAsk).toBe(kimi);
    events.push(event('early-answer', 'tool_result', { tool_use_id: 'future' }));
    events.push(event('future-q', 'tool_use', { tool_name: 'AskUserQuestion', tool_use_id: 'future' }));
    expect(project(events, 0, 'kimi').pendingAsk).toBeNull();
    expect(project([kimi], 1, 'kimi').pendingAsk).toBe(kimi);
    expect(project([], 2, 'kimi').pendingAsk).toBeNull();
  });

  it('conserva plano proposto sem marcador novo, ignora reply local e só encerra no usuário real', () => {
    const project = createEventProjection();
    const plan = event('plan', 'assistant_msg', { text: '<proposed_plan>\n# Plano\n</proposed_plan>' });
    const events = [plan];
    const first = project(events, 0, 'codex');
    expect(first.proposedPlan).toEqual({ id: 'plan', plan: '# Plano' });
    events.push(event('queued-next', 'user_msg', { text: 'depois', queued_delivered: false }));
    expect(project(events, 0, 'codex').proposedPlan).toBe(first.proposedPlan);
    events.push(event('reply', 'assistant_msg', { text: 'explicação sem marcador' }));
    const explained = project(events, 0, 'claude');
    expect(explained.proposedPlan).toBe(first.proposedPlan);
    expect(explained.replyPlan).toEqual({ id: 'reply', plan: 'explicação sem marcador' });
    events.push(event('local-note', 'assistant_msg', { text: 'aviso local' }));
    expect(project(events, 0, 'claude').replyPlan).toBe(explained.replyPlan);
    events.push(event('real-user', 'user_msg', { text: 'implemente' }));
    const closed = project(events, 0, 'codex');
    expect(closed.proposedPlan).toBeNull();
    expect(closed.replyPlan).toBeNull();
    expect(first.proposedPlan).toEqual({ id: 'plan', plan: '# Plano' });
  });

  it('painel do servidor vazio vence e a fila derivada segue atualizada por trás', () => {
    const project = createEventProjection();
    const server = { entries: [], actions: true };
    const events = [event('queued-a', 'user_msg', { text: 'a', queued_delivered: false })];
    expect(project(events, 0, 'pi', server).queuePanel).toBe(server);
    events.push(event('queued-b', 'user_msg', { text: 'b', queued_delivered: false }));
    expect(project(events, 0, 'pi', server).queuePanel).toBe(server);
    expect(project(events, 0, 'pi').queuePanel.entries).toEqual([
      { id: 'a', text: 'a', ts: null }, { id: 'b', text: 'b', ts: null },
    ]);
    const delivered = { ...events[0], queued_delivered: true };
    const confirmed = { ...events[1], queued_confirmed: true };
    expect(project([delivered, confirmed], 1, 'pi').queuePanel.entries).toEqual([]);
  });

  it('mantém referências e snapshots anteriores quando nada derivado muda', () => {
    const project = createEventProjection();
    const empty = project([], 0, 'pi');
    const thought = event('thought', 'thinking', { text: 'pensando' });
    expect(project([thought], 0, 'pi')).toBe(empty);
    expect(project([thought], 1, 'pi').queuePanel).toBe(empty.queuePanel);

    const queued = event('queued-q', 'user_msg', { text: 'na fila', queued_delivered: false, queued_ts: 42 });
    const waiting = project([thought, queued], 1, 'pi');
    expect(waiting.queuePanel.entries).toEqual([{ id: 'q', text: 'na fila', ts: 42 }]);
    expect(empty.queuePanel.entries).toEqual([]);
    expect(project([thought, queued, event('notice', 'notice')], 1, 'pi')).toBe(waiting);
    expect(project([queued], 2, 'pi')).toBe(waiting);
    expect(waiting.queuePanel.entries).toEqual([{ id: 'q', text: 'na fila', ts: 42 }]);
  });
});
