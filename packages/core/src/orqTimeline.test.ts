import { describe, expect, it } from 'vitest';
import { bodyPreview, decidedByBadge, dayStarts, teamView, taskRows, pct } from './orqTimeline';

describe('bodyPreview', () => {
  it('corta no último espaço antes de 280 e marca o corte', () => {
    const p = bodyPreview('palavra '.repeat(60));
    expect(p.cut).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(281);
    expect(p.text.endsWith('…')).toBe(true);
  });
  it('não corta dentro de crase aberta', () => {
    const t = 'x '.repeat(135) + '`StateEvent.problema_detalhe` fim';
    expect((bodyPreview(t).text.match(/`/g) ?? []).length % 2).toBe(0);
  });
  it('recua até a crase quando o corte cai dentro do trecho de código', () => {
    const t = 'x '.repeat(130) + '`um trecho de codigo longo com espacos` fim';
    const p = bodyPreview(t);
    expect((p.text.match(/`/g) ?? []).length % 2).toBe(0);
    expect(p.text.endsWith('…')).toBe(true);
  });
  it('texto curto sai inteiro', () => expect(bodyPreview('curto')).toEqual({ text: 'curto', cut: false }));
});

describe('decidedByBadge', () => {
  it('regra, alarme, Jev e regex', () => {
    expect(decidedByBadge({ source: 'rule', rule: 'mark' } as never, 'woke')).toEqual({ key: 'orq_badge_rule_mark' });
    expect(decidedByBadge({ source: 'rule', rule: 'orchestrator' } as never, 'woke')).toEqual({ key: 'orq_badge_rule_orchestrator' });
    expect(decidedByBadge({ source: 'alarm' } as never, 'woke')).toEqual({ key: 'orq_badge_alarm' });
    expect(decidedByBadge({ source: 'jev', jev: { choice: 'nothing', p: 0.97, probs: { nothing: 0.97 } } } as never, 'dropped'))
      .toEqual({ key: 'orq_badge_jev_dropped', p: 0.97 });
    expect(decidedByBadge({ source: 'jev', jev: { choice: 'act', p: 0, probs: { act: 0.94 } } } as never, 'woke'))
      .toEqual({ key: 'orq_badge_jev_woke', p: 0.94 });
    expect(decidedByBadge({ source: 'jev', jev: { choice: 'nothing', p: 0.62, probs: {} } } as never, 'woke'))
      .toEqual({ key: 'orq_badge_jev_woke_bare' });
    expect(decidedByBadge({ source: 'regex', regex: { verdict: 'drop', category: 'janela' } } as never, 'would_drop'))
      .toEqual({ key: 'orq_badge_regex_would_drop', category: 'janela' });
  });
  it('probs vazio (como o backend manda) cai no p do descarte', () => {
    expect(decidedByBadge({ source: 'jev', jev: { choice: 'nothing', p: 0.9, probs: {} } } as never, 'dropped'))
      .toEqual({ key: 'orq_badge_jev_dropped', p: 0.9 });
  });
  it('sem probs, p só vale em descarte com choice nothing', () => {
    expect(decidedByBadge({ source: 'jev', jev: { choice: 'nothing', p: 0.9 } } as never, 'dropped'))
      .toEqual({ key: 'orq_badge_jev_dropped', p: 0.9 });
    expect(decidedByBadge({ source: 'jev', jev: { choice: 'act', p: 0.9 } } as never, 'woke'))
      .toEqual({ key: 'orq_badge_jev_woke_bare' });
  });
});

describe('dayStarts', () => {
  it('marca o primeiro evento de cada dia local', () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h, 0).getTime() / 1000;
    const evs = [{ id: 'a', ts: at(29, 21) }, { id: 'b', ts: at(29, 22) }, { id: 'c', ts: at(30, 9) }];
    expect([...dayStarts(evs).keys()]).toEqual(['a', 'c']);
  });
});

describe('teamView', () => {
  it('vivo trabalhando mostra o estado; parado mostra o que fez; fora da lista é encerrada', () => {
    const team = [
      { name: 'arb', role: 'arbiter', task: null, last: null, current: true },
      { name: 'rev4', role: 'reviewer', task: 4, last: { code: 'started', round: null, ts: '' }, current: true },
      { name: 't4', role: 'executor', task: 4, last: { code: 'delivered', round: 2, ts: '' }, current: true },
      { name: 't2', role: 'executor', task: 2, last: { code: 'delivered', round: 2, ts: '' }, current: true },
    ] as never;
    const live = new Map([['arb', 'awaiting_input'], ['rev4', 'working'], ['t4', 'idle']]);
    const v = teamView(team, live);
    expect(v.shown.map((r) => [r.name, r.status])).toEqual([
      ['arb', { key: 'orq_live_waiting' }], ['rev4', { key: 'orq_live_working' }],
      ['t4', { key: 'orq_last_delivered', round: 2 }]]);
    expect(v.ended.map((r) => [r.name, r.status])).toEqual([['t2', { key: 'orq_live_ended' }]]);
  });
  it('árbitro atual fora do mapa continua na lista', () => {
    const team = [{ name: 'arb', role: 'arbiter', task: null, last: null, current: true }] as never;
    const v = teamView(team, new Map());
    expect(v.shown.map((r) => [r.name, r.status])).toEqual([['arb', { key: 'orq_live_idle' }]]);
    expect(v.ended).toEqual([]);
  });
});

describe('taskRows', () => {
  it('ativas e fechadas sempre; fila recolhida com a contagem', () => {
    const rows = [
      { n: 1, state: 'integrated' }, { n: 5, state: 'in_review' }, { n: 6, state: 'queued' }, { n: 7, state: 'queued' },
    ] as never;
    const r = taskRows(rows);
    expect(r.visible.map((t: { n: number }) => t.n)).toEqual([1, 5]);
    expect(r.queued.map((t: { n: number }) => t.n)).toEqual([6, 7]);
    expect(r.queuedCount).toBe(2);
  });
});

it('pct formata 0,97 como 97%', () => expect(pct(0.97)).toBe('97%'));
