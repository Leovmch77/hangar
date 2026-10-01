// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import type { OrqPanel as Data, Server } from '@hangar/core';
import * as m from '../paraglide/messages';
import { money, tok } from '../lib/fmt';
import { moeda } from '../lib/moeda.svelte';
import { intlLocale } from '../lib/locale';

const { getPanel, getHistoryPanel, store } = vi.hoisted(() => ({
  getPanel: vi.fn(),
  getHistoryPanel: vi.fn(),
  store: { retain: vi.fn(), release: vi.fn(), sessionsForServer: vi.fn((_id: string): { name: string; state: string }[] => []) },
}));
vi.mock('@hangar/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hangar/core')>()),
  getOrqPanelForServer: getPanel,
  getOrqHistoryPanelForServer: getHistoryPanel,
}));
vi.mock('../lib/sessionsStore.svelte', () => ({ sessionsStore: store }));

import OrqPanel from './OrqPanel.svelte';

const SERVER: Server = { id: 's1', label: 'local', baseUrl: 'http://x', token: 't' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });

function row(n: number, state: Data['tasks']['rows'][number]['state'], round: number | null = null) {
  return { n, title: `Task ${n}`, state, round };
}
function panel(over: Partial<Data> = {}): Data {
  return {
    run: 'r', gid: 'g', errors: [], empty: false,
    tasks: { integrated: 1, total: 2, total_known: true, rows: [row(1, 'integrated'), row(2, 'queued')] },
    team: [], decisions: [],
    automation: {
      mode: { jev: 'on', regex: 'shadow' },
      woke: { total: 0, decisions: 0, alarms: 0, messages: 0 },
      alone: { total: 0, opened: 0, integrated: 0, dropped: 0 },
      dropped_by_jev: 0,
      advanced: { would_drop: 0, disagree: 0, judged: 0, min_confidence: null, by_rule: 0 },
    },
    consumption: null,
    integration: { branch: 'b', last: null, outcome: null, red_log: null, delivery_checks: { ok: 0, total: 0, failing: [] } },
    ...over,
  };
}

let alvo: HTMLElement;
let comp: ReturnType<typeof mount> | null = null;
async function montar(extra: Partial<{ runId: string; arbiter: string | null; onOpenSession: (n: string) => void; onOpenFile: (p: string) => void }> = {}) {
  document.body.innerHTML = '';
  alvo = document.body.appendChild(document.createElement('div'));
  comp = mount(OrqPanel, {
    target: alvo,
    props: { server: SERVER, sessionName: 'g-orq', arbiter: 'g-arbiter', onOpenSession: () => {}, onOpenFile: () => {}, ...extra },
  });
  await vi.waitFor(() => expect(getPanel.mock.calls.length + getHistoryPanel.mock.calls.length).toBeGreaterThan(0));
  await tick(); await tick();
}
const text = () => alvo.textContent ?? '';
const byText = (sel: string, t: string) =>
  [...alvo.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(t));

beforeEach(() => { getPanel.mockReset(); getHistoryPanel.mockReset(); store.retain.mockReset(); store.release.mockReset(); store.sessionsForServer.mockReset(); store.sessionsForServer.mockReturnValue([]); });
afterEach(async () => {
  if (comp) await unmount(comp);
  comp = null; document.body.innerHTML = '';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.useRealTimers();
});

it('antes da resposta mostra o Spinner com o texto de leitura', async () => {
  getPanel.mockReturnValue(new Promise(() => {}));
  await montar();
  expect(alvo.querySelector('.spinner')).not.toBeNull();
  expect(text()).toContain(m.orq_panel_loading());
});

it('recém-criada mostra só a frase e nenhum bloco', async () => {
  getPanel.mockResolvedValue(panel({ empty: true }));
  await montar();
  expect(text()).toContain(m.orq_panel_empty());
  expect(text()).not.toContain(m.orq_tasks_title());
  expect(text()).not.toContain(m.orq_use_title());
});

it('falha do pedido mostra o erro e Tentar de novo refaz', async () => {
  getPanel.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(panel());
  await montar();
  expect(text()).toContain(m.orq_panel_fetch_error({ error: 'boom' }));
  byText('button', m.orq_panel_retry())!.click();
  await vi.waitFor(() => expect(getPanel).toHaveBeenCalledTimes(2));
  await tick(); await tick();
  expect(text()).not.toContain(m.orq_panel_fetch_error({ error: 'boom' }));
  expect(text()).toContain(m.orq_tasks_title());
});

it('arquivo ilegível avisa em cima e os outros blocos continuam', async () => {
  getPanel.mockResolvedValue(panel({ errors: [{ file: 'eventos.jsonl', error: 'PermissionError: x' }] }));
  await montar();
  expect(text()).toContain(m.orq_panel_file_error({ file: 'eventos.jsonl', error: 'PermissionError: x' }));
  expect(text()).toContain(m.orq_tasks_title());
  expect(text()).toContain(m.orq_int_title());
});

it('retrato da execução real: Tasks, fila recolhida, Automação e Avançado', async () => {
  const rows = [
    ...[1, 2, 3, 4].map((n) => row(n, 'integrated')), row(5, 'in_review', 1),
    ...Array.from({ length: 39 }, (_, i) => row(i + 6, 'queued')),
  ];
  const base = panel();
  getPanel.mockResolvedValue(panel({
    tasks: { integrated: 4, total: 44, total_known: true, rows },
    automation: {
      ...base.automation,
      woke: { total: 4, decisions: 3, alarms: 1, messages: 0 },
      alone: { total: 9, opened: 4, integrated: 4, dropped: 1 },
      advanced: { would_drop: 0, disagree: 0, judged: 0, min_confidence: null, by_rule: 4 },
    },
  }));
  await montar();
  expect(text()).toContain(m.orq_tasks_count({ n: 4, total: 44 }));
  expect(alvo.querySelector<HTMLElement>('.bar i')!.style.width).toBe('9.09%');
  expect(alvo.querySelectorAll('.task-row')).toHaveLength(5);
  expect(text()).toContain(m.orq_state_in_review({ round: 1 }));
  const queued = byText('button', m.orq_tasks_queued({ n: 39 }))!;
  queued.click(); await tick();
  expect(alvo.querySelectorAll('.task-row')).toHaveLength(44);

  const tiles = [...alvo.querySelectorAll('.auto .tile b')].map((e) => e.textContent);
  expect(tiles).toEqual(['4', '9', '0']);
  expect(text()).toContain(m.orq_auto_woke_detail({ decisions: 3, alarms: 1, messages: 0 }));
  const adv = alvo.querySelector<HTMLDetailsElement>('details.adv')!;
  expect(adv.open).toBe(false);
  adv.open = true; await tick();
  expect([...adv.querySelectorAll('.adv-row b')].map((e) => e.textContent)).toEqual(['0', m.orq_adv_disagree_value({ n: 0, m: 0 }), '—', '4']);
  expect(text()).toContain(m.orq_auto_mode({ jev: m.orq_mode_on(), regex: m.orq_mode_shadow() }));
});

it('Time: estado ao vivo, encerradas recolhidas e clique abre a sessão', async () => {
  store.sessionsForServer.mockReturnValue([{ name: 'g-arbiter', state: 'awaiting_input' }]);
  getPanel.mockResolvedValue(panel({
    team: [
      { name: 'g-arbiter', role: 'arbiter', task: null, current: true, last: null },
      { name: 'g-t2', role: 'executor', task: 2, current: false, last: { code: 'delivered', round: 1, ts: '2026-09-29T22:00:00-03:00' } },
    ],
  }));
  const onOpenSession = vi.fn();
  await montar({ onOpenSession });
  const card = byText('.member', 'g-arbiter')!;
  expect(card.textContent).toContain(`${m.orq_role_arbiter()} · ${m.orq_live_waiting()}`);
  expect(alvo.querySelectorAll('.member')).toHaveLength(1);
  expect(text()).toContain(m.orq_team_show_ended({ n: 1 }));
  card.click();
  expect(onOpenSession).toHaveBeenCalledWith('g-arbiter');
  byText('button', m.orq_team_show_ended({ n: 1 }))!.click(); await tick();
  expect(byText('.member', 'g-t2')!.textContent).toContain(m.orq_live_ended());
});

it('Decisões: parecer abre o arquivo, sem parecer o botão some, falar abre o árbitro', async () => {
  const ts = '2026-09-29T22:12:00-03:00';
  getPanel.mockResolvedValue(panel({
    decisions: [
      { task: 4, ts, question: 'Autoriza o detalhe?', parecer: '/x/task-4-r1-revisor.md', event_id: 'a' },
      { task: 5, ts, question: 'Sem parecer?', parecer: null, event_id: 'b' },
    ],
  }));
  const onOpenFile = vi.fn(); const onOpenSession = vi.fn();
  await montar({ onOpenFile, onOpenSession });
  const cards = alvo.querySelectorAll<HTMLElement>('.decision');
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain(m.orq_decision_unanswered({ time: hhmm(ts) }));
  expect(cards[0].textContent).toContain('Autoriza o detalhe?');
  expect(byText('.decision button', m.orq_open_parecer())).toBeTruthy();
  expect(cards[1].textContent).not.toContain(m.orq_open_parecer());
  byText('.decision button', m.orq_open_parecer())!.click();
  expect(onOpenFile).toHaveBeenCalledWith('/x/task-4-r1-revisor.md');
  byText('.decision button', m.orq_talk_to_arbiter())!.click();
  expect(onOpenSession).toHaveBeenCalledWith('g-arbiter');
});

it('Consumo: três números, tabela por provider e modelo, cobertura e metodologia; null = somando', async () => {
  const since = '2026-09-29T21:00:00-03:00';
  getPanel.mockResolvedValue(panel({
    consumption: {
      computed_at: since, since,
      sessions: { team: 11, measured: 7, missing: ['g-t1', 'g-review1'] },
      totals: { new: 4_800_000, cache_read: 61_200_000, usd: 38.4, usd_partial: false },
      providers: [{ provider: 'claude', sessions: 8, new: 4_100_000, cache_read: 58_900_000, usd: 35.1,
        models: [{ model: 'claude-opus-5-5', sessions: 8, new: 3_900_000, cache_read: 57_000_000, usd: 33.8 }] }],
      missing_prices: [], subagents: true,
    },
  }));
  await montar();
  const nums = [...alvo.querySelectorAll('.use .tile b')].map((e) => e.textContent);
  expect(nums).toEqual([tok(4_800_000), tok(61_200_000), money(38.4, moeda.cur, moeda.rate)]);
  expect(alvo.querySelector('.use-table .prov')!.textContent).toContain('Claude');
  expect(text()).toContain(m.orq_use_model_sessions({ model: 'claude-opus-5-5', n: 8 }));
  expect(text()).toContain(m.orq_use_sessions({ measured: 7, team: 11 }));
  expect(text()).toContain(m.orq_use_missing({ names: 'g-t1, g-review1' }));
  const inicio = new Date(since).toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  expect(text()).toContain(m.orq_use_method({ since: inicio }));
});

it('Consumo null mostra que está somando', async () => {
  getPanel.mockResolvedValue(panel());
  await montar();
  expect(text()).toContain(m.orq_use_computing());
});

it('Consumo que falhou mostra o erro e não fica em "calculando"', async () => {
  getPanel.mockResolvedValue(panel({ errors: [{ file: 'consumption', error: 'boom' }] }));
  await montar();
  expect(text()).toContain(m.orq_panel_file_error({ file: 'consumption', error: 'boom' }));
  expect(text()).not.toContain(m.orq_use_computing());
});

it('Integração: checks vermelhos listam as Tasks como T3, T5', async () => {
  const base = panel();
  getPanel.mockResolvedValue(panel({
    integration: { ...base.integration, delivery_checks: { ok: 3, total: 5, failing: [3, 5] } },
  }));
  await montar();
  expect(text()).toContain(m.orq_int_checks_red({ ok: 3, total: 5, tasks: 'T3, T5' }));
});

it('Integração: branch, último merge, resultado e checks', async () => {
  const ts = '2026-09-29T22:19:00-03:00';
  getPanel.mockResolvedValue(panel({
    integration: { branch: 'mobile-deliveries-orq', last: { task: 4, commit: '538ac4d1234', ts }, outcome: 'green',
      red_log: null, delivery_checks: { ok: 5, total: 5, failing: [] } },
  }));
  await montar();
  expect(text()).toContain('mobile-deliveries-orq');
  expect(text()).toContain(`T4 · 538ac4d · ${hhmm(ts)}`);
  expect(text()).toContain(m.orq_int_green());
  expect(text()).toContain(m.orq_int_checks_green({ ok: 5, total: 5 }));
});

it('execução sem início: branch e "desde" viram traço e o custo parcial leva asterisco', async () => {
  const base = panel();
  getPanel.mockResolvedValue(panel({
    integration: { ...base.integration, branch: null },
    consumption: {
      computed_at: '2026-09-29T22:00:00-03:00', since: null,
      sessions: { team: 1, measured: 1, missing: [] },
      totals: { new: 1, cache_read: 2, usd: 1.5, usd_partial: true },
      providers: [], missing_prices: ['x-model'], subagents: false,
    },
  }));
  await montar();
  expect(text()).toContain(m.orq_use_method({ since: '—' }));
  expect(text()).toContain(money(1.5, moeda.cur, moeda.rate) + '*');
  expect(text()).toContain(m.orq_use_no_price({ models: 'x-model' }));
  expect(alvo.querySelector('.int code')).toBeNull();
});

it('aba escondida não pede a cada 10 s e desmontar solta o store', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  getPanel.mockResolvedValue(panel());
  await montar();
  expect(store.retain).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  vi.advanceTimersByTime(10_000);
  await tick();
  expect(getPanel).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.advanceTimersByTime(10_000);
  expect(getPanel).toHaveBeenCalledTimes(2);
  await unmount(comp!); comp = null;
  expect(store.release).toHaveBeenCalledTimes(1);
});


it('mostra o tempo total e de cada task sem somar tarefas paralelas', async () => {
  const timing = { started_at: '2026-09-30T10:00:00Z', finished_at: '2026-09-30T11:30:00Z', elapsed_seconds: 5400 };
  getPanel.mockResolvedValue(panel({ timing, tasks: { integrated: 1, total: 2, total_known: true, rows: [
    { ...row(1, 'integrated'), timing: { ...timing, elapsed_seconds: 1200 } }, row(2, 'queued'),
  ] } }));
  await montar();
  expect(text()).toContain(m.orq_elapsed_hours({ h: 1, m: 30 }));
  expect(text()).toContain(m.orq_task_elapsed({ time: m.orq_elapsed_minutes({ n: 20 }) }));
  byText('button', m.orq_tasks_queued({ n: 1 }))!.click();
  await tick();
  expect(text()).toContain(m.orq_task_elapsed({ time: '—' }));
  expect(text()).toContain(m.orq_time_method());
});


it('filtra tasks pendentes e recolhe todas as seções', async () => {
  getPanel.mockResolvedValue(panel());
  await montar();
  byText('button', m.orq_show_pending_tasks())!.click();
  await tick();
  expect([...alvo.querySelectorAll('.task-row .n')].map((e) => e.textContent)).toEqual(['T2']);
  byText('button', m.orq_collapse_all())!.click();
  await tick();
  expect(alvo.querySelectorAll('.orq-panel > details[open]')).toHaveLength(0);
  byText('button', m.orq_expand_all())!.click();
  await tick();
  expect(alvo.querySelectorAll('.orq-panel > details[open]')).toHaveLength(7);
  byText('button', m.orq_show_all_tasks())!.click();
  await tick();
  expect([...alvo.querySelectorAll('.task-row .n')].map((e) => e.textContent)).toEqual(['T1']);
});


it('abre execução arquivada sem consultar nem assinar uma sessão viva', async () => {
  getHistoryPanel.mockResolvedValue(panel({ metadata: { title: 'historical-plan', plan: '/plan.md', repo: '/project', total_tasks: 2, error: null } }));
  await montar({ runId: 'finished-run' });
  expect(getHistoryPanel).toHaveBeenCalledWith(SERVER, 'finished-run');
  expect(getPanel).not.toHaveBeenCalled();
  expect(store.retain).not.toHaveBeenCalled();
  expect(text()).toContain('historical-plan');
});
