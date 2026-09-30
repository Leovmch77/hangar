import type { OrqDecidedBy, OrqEntry, OrqPanelTask, OrqTeamMember } from './types';

export function bodyPreview(body: string, max = 280): { text: string; cut: boolean } {
  if (body.length <= max) return { text: body, cut: false };
  let t = body.slice(0, max);
  const sp = t.lastIndexOf(' ');
  if (sp > 0) t = t.slice(0, sp);
  // Crase aberta viraria código sem fim na renderização.
  while ((t.match(/`/g) ?? []).length % 2 === 1) t = t.slice(0, t.lastIndexOf('`'));
  return { text: t.trimEnd() + '…', cut: true };
}

export interface OrqBadge {
  key: string;
  p?: number;
  category?: string;
}

export function decidedByBadge(d: OrqDecidedBy, kind: OrqEntry['kind']): OrqBadge {
  if (d.source === 'rule') {
    return { key: d.rule === 'mark' ? 'orq_badge_rule_mark' : 'orq_badge_rule_orchestrator' };
  }
  if (d.source === 'alarm') return { key: 'orq_badge_alarm' };
  const outcome = kind === 'dropped' || kind === 'would_drop' ? kind : 'woke';
  if (d.source === 'regex') {
    const category = d.regex?.category;
    return category ? { key: `orq_badge_regex_${outcome}`, category } : { key: `orq_badge_regex_${outcome}` };
  }
  const j = d.jev;
  let p: number | undefined;
  // O backend manda `probs: {}` quando não há probabilidades; `{}` é truthy e escondia o `p`.
  if (j?.probs && Object.keys(j.probs).length) {
    const v = j.choice ? j.probs[j.choice] : null;
    if (typeof v === 'number') p = v;
  } else if (j?.choice === 'nothing' && outcome !== 'woke' && typeof j.p === 'number') {
    p = j.p;
  }
  if (p === undefined) return { key: outcome === 'woke' ? 'orq_badge_jev_woke_bare' : `orq_badge_jev_${outcome}` };
  return { key: `orq_badge_jev_${outcome}`, p };
}

export function dayStarts(events: { id: string; ts?: number | null }[]): Map<string, number> {
  const out = new Map<string, number>();
  let last = '';
  for (const e of events) {
    if (e.ts == null) continue;
    const day = new Date(e.ts * 1000).toDateString();
    if (day !== last) {
      out.set(e.id, e.ts);
      last = day;
    }
  }
  return out;
}

export interface OrqTeamStatus {
  key: string;
  round?: number;
}
export type OrqTeamRow = OrqTeamMember & { status: OrqTeamStatus };

export function teamView(
  team: OrqTeamMember[],
  live: Map<string, string>,
): { shown: OrqTeamRow[]; ended: OrqTeamRow[] } {
  const shown: OrqTeamRow[] = [];
  const ended: OrqTeamRow[] = [];
  for (const m of team) {
    const state = live.get(m.name);
    const isLive = state !== undefined;
    if (!isLive && !(m.role === 'arbiter' && m.current)) {
      ended.push({ ...m, status: { key: 'orq_live_ended' } });
      continue;
    }
    let status: OrqTeamStatus;
    if (state === 'working') status = { key: 'orq_live_working' };
    else if (state === 'awaiting_input') status = { key: 'orq_live_waiting' };
    else if (m.last) {
      status = { key: `orq_last_${m.last.code}` };
      if (m.last.round != null) status.round = m.last.round;
    } else status = { key: 'orq_live_idle' };
    shown.push({ ...m, status });
  }
  return { shown, ended };
}

export function taskRows(rows: OrqPanelTask[]): {
  visible: OrqPanelTask[];
  queued: OrqPanelTask[];
  queuedCount: number;
} {
  const queued = rows.filter((r) => r.state === 'queued');
  return { visible: rows.filter((r) => r.state !== 'queued'), queued, queuedCount: queued.length };
}

export function pct(p: number): string {
  return Math.round(p * 100) + '%';
}
