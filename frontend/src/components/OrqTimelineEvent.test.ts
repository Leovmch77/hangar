// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import type { ChatEvent, OrqDecidedBy, OrqEntry } from '@hangar/core';
import * as m from '../paraglide/messages';
import { dec } from '../lib/fmt';
import OrqTimelineEvent from './OrqTimelineEvent.svelte';

const NOW = Math.floor(Date.now() / 1000);
const BASE: OrqEntry = {
  kind: 'notice', task: null, line: null, origin: null, sender: null, mark: null, alarm: false,
  rejected_round: null, body: '', question: null, parecer: null, error: null, decided_by: null,
};
const ev = (orq: Partial<OrqEntry>, ts: number = NOW): ChatEvent =>
  ({ kind: 'notice', id: 'e1', ts, text: '', orq: { ...BASE, ...orq } });
const RULE_MARK: OrqDecidedBy = { source: 'rule', rule: 'mark', jev: null, regex: null, regex_agreed: null };
const JEV_DROP: OrqDecidedBy = {
  source: 'jev', rule: null, regex: { verdict: 'drop', category: 'status' }, regex_agreed: true,
  jev: { mode: 'live', choice: 'nothing', p: 0.97, probs: { nothing: 0.97, act: 0.02, none: 0.01 },
    veto: { context: 0.02, user: 0.01, problem: 0.03, deviation: 0.02 }, held: [], would_drop: true, error: null },
};

let alvo: HTMLElement;
let comp: ReturnType<typeof mount> | null = null;
async function montar(props: { ev: ChatEvent; dayTs?: number }) {
  if (comp) await unmount(comp);
  document.body.innerHTML = '';
  alvo = document.body.appendChild(document.createElement('div'));
  comp = mount(OrqTimelineEvent, { target: alvo, props });
  await tick();
}
afterEach(async () => { if (comp) await unmount(comp); comp = null; document.body.innerHTML = ''; });

it('advance/opened vira linha curta com Task em negrito, sessões em código e hora', async () => {
  await montar({ ev: ev({ kind: 'advance', task: 4, line: { code: 'opened', sessions: [
    { name: 'proj-t4', provider: 'claude', model: 'x' },
    { name: 'proj-review4', provider: 'claude', model: 'x' }] } }) });
  const line = alvo.querySelector('.orq-line')!;
  expect(line.querySelector('b')!.textContent).toBe('T4');
  expect([...line.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['proj-t4', 'proj-review4']);
  expect(line.querySelector('.orq-time')!.textContent).toMatch(/^\d\d:\d\d$/);
  expect(alvo.querySelector('.orq-bubble')).toBeNull();
});

it('recado de decisão: cabeçalho, marcas, selo da regra, pergunta e código no corpo', async () => {
  await montar({ ev: ev({ kind: 'woke', mark: 'decisao', task: 4, question: 'autoriza o detalhe?',
    body: '`StateEvent.problema_detalhe` é cru.', decided_by: RULE_MARK }) });
  const b = alvo.querySelector('.orq-bubble')!;
  expect(b.querySelector('.orq-who')!.textContent).toBe(m.orq_label_woke());
  const tags = [...b.querySelectorAll('.orq-tag')].map((t) => t.textContent);
  expect(tags).toEqual([m.orq_tag_decision(), 'T4']);
  expect(b.querySelector('.orq-badge')!.textContent).toContain(m.orq_badge_rule_mark());
  expect(b.querySelector('.orq-time')).not.toBeNull();
  expect(b.querySelector('.orq-q b')!.textContent).toBe(m.orq_question());
  expect(b.querySelector('.orq-q')!.textContent).toContain('autoriza o detalhe?');
  expect(b.querySelector('code')!.textContent).toBe('StateEvent.problema_detalhe');
});

it('corpo longo termina em reticências e alterna ver tudo / ver menos', async () => {
  const body = 'palavra '.repeat(60).trim();
  await montar({ ev: ev({ kind: 'woke', body }) });
  const more = () => alvo.querySelector<HTMLButtonElement>('.orq-more')!;
  expect(alvo.querySelector('.orq-body')!.textContent).toContain('…');
  expect(more().textContent).toBe(m.orq_see_all());
  more().click();
  await tick();
  expect(alvo.querySelector('.orq-body')!.textContent).not.toContain('…');
  expect(more().textContent).toBe(m.orq_see_less());
});

it('parecer vira botão de arquivo citado; sem parecer não há botão', async () => {
  const path = '/home/x/task-4-r1-revisor.md';
  await montar({ ev: ev({ kind: 'woke', body: 'a', parecer: path }) });
  const btn = alvo.querySelector<HTMLButtonElement>('button.file-citation')!;
  expect(btn.dataset.filePath).toBe(path);
  expect(btn.textContent).toContain('task-4-r1-revisor.md');
  await montar({ ev: ev({ kind: 'woke', body: 'a' }) });
  expect(alvo.querySelector('button.file-citation')).toBeNull();
});

it('rodada reprovada leva a marca de perigo', async () => {
  await montar({ ev: ev({ kind: 'woke', task: 4, rejected_round: 1, body: 'a' }) });
  const tag = alvo.querySelector('.orq-tag.danger')!;
  expect(tag.textContent).toBe(m.orq_tag_rejected({ round: 1 }));
});

it('recado descartado: apagado, remetente no cabeçalho, selo do Jev e detalhe já aberto', async () => {
  await montar({ ev: ev({ kind: 'dropped', sender: 'proj-t4', body: 'sigo aguardando', decided_by: JEV_DROP }) });
  expect(alvo.querySelector('.orq-ev')!.classList.contains('faded')).toBe(true);
  expect(alvo.querySelector('.orq-who')!.textContent).toBe(m.orq_sender_to_arbiter({ sender: 'proj-t4' }));
  expect(alvo.querySelector('.orq-badge')!.textContent).toContain(m.orq_badge_jev_dropped({ p: '97%' }));
  const d = alvo.querySelector('.orq-detail')!.textContent!;
  expect(d).toContain(m.orq_detail_choice({ choice: m.orq_choice_nothing(), p: '97%' }));
  expect(d).toContain(m.orq_detail_vetoes({ context: dec(0.02, 2), user: dec(0.01, 2), problem: dec(0.03, 2), deviation: dec(0.02, 2) }));
  expect(d).toContain(m.orq_detail_regex_agreed());
});

it('selo do Jev sem probabilidade não termina em separador solto', async () => {
  const semP = { ...JEV_DROP, jev: { ...JEV_DROP.jev!, choice: 'act', probs: undefined } };
  await montar({ ev: ev({ kind: 'dropped', body: 'a', decided_by: semP }) });
  const text = alvo.querySelector('.orq-badge')!.textContent!.trim();
  expect(text).not.toMatch(/·\s*$/);
  expect(text.startsWith('Jev')).toBe(true);
});

it('registro antigo que acordou (choice act, p 0, sem probs) não mostra "0%" no detalhe', async () => {
  const antigo = { ...JEV_DROP, jev: { ...JEV_DROP.jev!, choice: 'act', p: 0, probs: undefined } };
  await montar({ ev: ev({ kind: 'dropped', body: 'a', decided_by: antigo }) });
  const d = alvo.querySelector('.orq-detail')!.textContent!;
  expect(d).toContain(m.orq_detail_choice({ choice: m.orq_choice_act(), p: '' }).trim());
  expect(d).not.toContain('0%');
});

it('acordado pelo Jev: detalhe fechado até clicar no selo', async () => {
  const jev = { ...JEV_DROP, jev: { ...JEV_DROP.jev!, would_drop: false } };
  await montar({ ev: ev({ kind: 'woke', body: 'a', decided_by: jev }) });
  const badge = alvo.querySelector<HTMLButtonElement>('button.orq-badge')!;
  expect(badge.getAttribute('aria-expanded')).toBe('false');
  expect(alvo.querySelector('.orq-detail')).toBeNull();
  badge.click();
  await tick();
  expect(badge.getAttribute('aria-expanded')).toBe('true');
  expect(alvo.querySelector('.orq-detail')).not.toBeNull();
});

it('falha de entrega e falha do orquestrador têm rótulos próprios', async () => {
  await montar({ ev: ev({ kind: 'failed', origin: 'notify', error: 'hangar-send falhou', body: 'texto' }) });
  expect(alvo.querySelector('.orq-who')!.textContent).toBe(m.orq_label_not_delivered());
  expect(alvo.textContent).toContain(m.orq_failed_reason({ error: 'hangar-send falhou' }));
  await montar({ ev: ev({ kind: 'failed', origin: 'orchestrator', error: 'boom', body: '' }) });
  expect(alvo.querySelector('.orq-who')!.textContent).toBe(m.orq_label_step_failed());
});

it('dayTs abre o separador de dia antes do evento', async () => {
  await montar({ ev: ev({ kind: 'advance', task: 1, line: { code: 'red_retry' } }), dayTs: NOW });
  const day = alvo.querySelector('.orq-day')!;
  expect(day.textContent).toMatch(new RegExp(`^${m.orq_day_today({ time: '\\d\\d:\\d\\d' })}$`));
  expect(day.compareDocumentPosition(alvo.querySelector('.orq-line')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await montar({ ev: ev({ kind: 'advance', task: 1, line: { code: 'red_retry' } }) });
  expect(alvo.querySelector('.orq-day')).toBeNull();
});

it('linha sem código conhecido mostra o texto cru sem o T{n}: do começo', async () => {
  await montar({ ev: { ...ev({ kind: 'notice', task: 3 }), text: 'T3: fechada' } });
  expect(alvo.querySelector('.orq-line')!.textContent).toContain('fechada');
  expect(alvo.querySelector('.orq-line')!.textContent).not.toContain('T3: ');
});
