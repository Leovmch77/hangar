<script lang="ts">
  import * as m from '../paraglide/messages';
  import { bodyPreview, decidedByBadge, pct, type ChatEvent, type OrqLine } from '@hangar/core';
  import { renderMarkdown } from '../lib/markdown';
  import { dec } from '../lib/fmt';
  import { intlLocale } from '../lib/locale';

  interface Props {
    ev: ChatEvent;
    /** Só no primeiro evento de cada dia: abre o separador antes dele. */
    dayTs?: number;
  }
  let { ev, dayTs }: Props = $props();

  const orq = $derived(ev.orq!);
  const isLine = $derived(orq.kind === 'advance' || orq.kind === 'notice');

  const hhmm = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const time = $derived(ev.ts != null ? hhmm(ev.ts) : '');

  function dayLabel(ts: number): string {
    const d = new Date(ts * 1000);
    const at = hhmm(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return m.orq_day_today({ time: at });
    today.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return m.orq_day_yesterday({ time: at });
    const date = d.toLocaleDateString(intlLocale(), { day: '2-digit', month: '2-digit' });
    return m.orq_day_date({ date, time: at });
  }

  // Nomes e commit entram entre crases: o renderMarkdown os transforma em <code>.
  const code = (s: string) => '`' + s + '`';
  function phrase(l: OrqLine): string {
    switch (l.code) {
      case 'opened': {
        const [exec, rev] = l.sessions;
        const executor = code(exec?.name ?? '');
        return rev ? m.orq_line_opened({ executor, reviewer: code(rev.name) }) : m.orq_line_opened_solo({ executor });
      }
      case 'integrated': return l.merge ? m.orq_line_integrated() : m.orq_line_integrated_direct();
      case 'delivered':
        // Sem commit a frase termina no separador; ele sai junto.
        return m.orq_line_delivered({ round: l.round, commit: l.commit ? code(l.commit) : '' }).replace(/\s*·\s*$/, '');
      case 'red_back': return m.orq_line_red_back({ executor: code(l.executor) });
      case 'red_retry': return m.orq_line_red_retry();
    }
  }
  const lineHtml = $derived.by(() => {
    if (orq.line) return renderMarkdown(phrase(orq.line));
    const raw = ev.text ?? '';
    return renderMarkdown(orq.task != null ? raw.replace(/^T\d+:\s*/, '') : raw);
  });
  const dotColor = $derived.by(() => {
    const c = orq.line?.code;
    if (c === 'integrated') return 'var(--success)';
    if (c === 'red_back' || c === 'red_retry') return 'var(--error)';
    if (orq.kind === 'notice') return 'var(--warning)';
    return 'var(--accent)';
  });

  const label = $derived.by(() => {
    if (orq.kind === 'dropped') {
      return orq.sender ? m.orq_sender_to_arbiter({ sender: orq.sender }) : m.orq_sender_unknown();
    }
    if (orq.kind === 'failed') {
      return orq.origin === 'notify' ? m.orq_label_not_delivered() : m.orq_label_step_failed();
    }
    return m.orq_label_woke();
  });
  const avatar = $derived.by(() => {
    if (orq.rejected_round != null) return { glyph: '✕', cls: 'bad' };
    if (orq.kind === 'dropped') return { glyph: '◌', cls: 'muted' };
    if (orq.kind === 'failed') return { glyph: '!', cls: 'bad' };
    return { glyph: '⚖', cls: 'arb' };
  });

  // As mensagens do Paraglide são funções, então a chave do selo vira função aqui.
  const BADGES: Record<string, (i: { p: string; category: string }) => string> = {
    orq_badge_rule_mark: m.orq_badge_rule_mark,
    orq_badge_rule_orchestrator: m.orq_badge_rule_orchestrator,
    orq_badge_alarm: m.orq_badge_alarm,
    orq_badge_jev_woke: m.orq_badge_jev_woke,
    orq_badge_jev_woke_bare: m.orq_badge_jev_woke_bare,
    orq_badge_jev_dropped: m.orq_badge_jev_dropped,
    orq_badge_jev_would_drop: m.orq_badge_jev_would_drop,
    orq_badge_regex_woke: m.orq_badge_regex_woke,
    orq_badge_regex_dropped: m.orq_badge_regex_dropped,
    orq_badge_regex_would_drop: m.orq_badge_regex_would_drop,
  };
  const badge = $derived.by(() => {
    if (!orq.decided_by) return null;
    const b = decidedByBadge(orq.decided_by, orq.kind);
    const text = BADGES[b.key]?.({ p: b.p != null ? pct(b.p) : '', category: b.category ?? '' });
    // Sem probabilidade/categoria a frase termina no separador; ele sai junto.
    return text ? text.replace(/\s*·\s*$/, '') : null;
  });

  const CHOICES: Record<string, () => string> = {
    nothing: m.orq_choice_nothing, act: m.orq_choice_act, none: m.orq_choice_none,
  };
  const detail = $derived.by(() => {
    const d = orq.decided_by;
    if (!d) return [];
    const out: string[] = [];
    const j = d.jev;
    if (j?.choice) {
      // `p` solto é a confiança em "nada a fazer": em registro antigo que acordou seria "agir · 0%".
      const p = j.probs?.[j.choice] ?? (j.choice === 'nothing' ? j.p : undefined);
      out.push(m.orq_detail_choice({ choice: (CHOICES[j.choice] ?? (() => j.choice!))(), p: p != null ? pct(p) : '' }).trim());
    }
    const v = j?.veto;
    if (v && Object.keys(v).length) {
      const f = (k: string) => (v[k] != null ? dec(v[k]!, 2) : '–');
      out.push(m.orq_detail_vetoes({ context: f('context'), user: f('user'), problem: f('problem'), deviation: f('deviation') }));
    }
    if (d.regex_agreed != null) out.push(d.regex_agreed ? m.orq_detail_regex_agreed() : m.orq_detail_regex_disagreed());
    if (j?.error) out.push(m.orq_detail_jev_error({ error: j.error }));
    return out;
  });
  // Descartado nasce com o porquê à vista: é justamente o que a pessoa quer conferir.
  let toggled = $state<boolean | null>(null);
  const detailOpen = $derived(toggled ?? orq.kind === 'dropped');

  let expanded = $state(false);
  const preview = $derived(bodyPreview(orq.body));
  const bodyHtml = $derived(renderMarkdown(expanded ? orq.body : preview.text, { fileLinks: true }));
  const parecerName = $derived(orq.parecer?.split('/').pop() ?? '');
</script>

{#if dayTs != null}
  <div class="orq-day">{dayLabel(dayTs)}</div>
{/if}

{#if isLine}
  <div class="orq-line">
    <span class="orq-dot" style:background={dotColor}></span>
    {#if orq.task != null}<b>T{orq.task}</b>{/if}
    <span class="orq-phrase">{@html lineHtml}</span>
    {#if time}<span class="orq-time">{time}</span>{/if}
  </div>
{:else}
  <div class="orq-ev" class:faded={orq.kind === 'dropped'}>
    <div class="orq-av {avatar.cls}" aria-hidden="true">{avatar.glyph}</div>
    <div class="orq-bubble">
      <div class="orq-meta">
        <span class="orq-who">{label}</span>
        {#if orq.mark === 'decisao'}<span class="orq-tag dec">{m.orq_tag_decision()}</span>{/if}
        {#if orq.alarm}<span class="orq-tag dec">{m.orq_tag_alarm()}</span>{/if}
        {#if orq.task != null}<span class="orq-tag">T{orq.task}</span>{/if}
        {#if orq.rejected_round != null}<span class="orq-tag danger">{m.orq_tag_rejected({ round: orq.rejected_round })}</span>{/if}
        {#if badge}
          {#if detail.length}
            <button type="button" class="orq-badge" aria-expanded={detailOpen} onclick={() => (toggled = !detailOpen)}>{badge}</button>
          {:else}
            <span class="orq-badge">{badge}</span>
          {/if}
        {/if}
        {#if time}<span class="orq-time">{time}</span>{/if}
      </div>
      {#if orq.body}
        <div class="orq-body md">{@html bodyHtml}</div>
        {#if preview.cut}
          <button type="button" class="orq-more" onclick={() => (expanded = !expanded)}>{expanded ? m.orq_see_less() : m.orq_see_all()}</button>
        {/if}
      {/if}
      {#if orq.question}
        <div class="orq-q"><b>{m.orq_question()}</b> <span class="md">{@html renderMarkdown(orq.question)}</span></div>
      {/if}
      {#if orq.kind === 'failed' && orq.error}
        <div class="orq-q">{m.orq_failed_reason({ error: orq.error })}</div>
      {/if}
      {#if orq.parecer}
        <button type="button" class="file-citation orq-file" data-file-path={orq.parecer}>📄 {parecerName}</button>
      {/if}
      {#if detailOpen && detail.length}
        <div class="orq-detail">{detail.join(' · ')}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .orq-day {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.78rem;
    margin: var(--space-3) 0 var(--space-2);
  }
  .orq-line {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    color: var(--text-muted);
    font-size: 0.85rem;
    margin: var(--space-2) 0;
    padding-left: 38px;
  }
  .orq-line b { color: var(--text-primary); font-weight: 600; }
  .orq-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .orq-phrase { min-width: 0; }
  .orq-phrase :global(p), .orq-q .md :global(p) { display: inline; margin: 0; }
  .orq-time { margin-left: auto; flex: none; font-size: 0.78rem; color: var(--text-muted); }

  .orq-ev {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    max-width: 760px;
    margin: var(--space-3) 0;
  }
  /* Só o recado some; selo e detalhe do Jev são o que se confere num descarte e ficam no contraste normal. */
  .orq-ev.faded :is(.orq-av, .orq-body, .orq-who, .orq-tag, .orq-time, .orq-more, .orq-q, .orq-file) { opacity: 0.62; }
  .orq-av {
    width: 28px; height: 28px; border-radius: 50%;
    display: grid; place-items: center; flex: none; margin-top: 2px;
    font-size: 13px;
  }
  .orq-av.arb { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
  .orq-av.bad { background: color-mix(in srgb, var(--error) 18%, transparent); color: var(--error); }
  .orq-av.muted { background: var(--border-subtle); color: var(--text-muted); }
  .orq-bubble {
    min-width: 0;
    background: var(--surface-raised);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  .orq-meta {
    display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center;
    font-size: 0.78rem; color: var(--text-muted); margin-bottom: 2px;
  }
  .orq-who { color: var(--text-primary); font-weight: 600; }
  .orq-tag {
    border-radius: var(--radius-sm); padding: 0 6px; font-size: 0.72rem; font-weight: 600;
    background: var(--border-subtle); color: var(--text-primary);
  }
  .orq-tag.dec { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
  .orq-tag.danger { background: color-mix(in srgb, var(--error) 18%, transparent); color: var(--error); }
  .orq-badge {
    font: inherit; font-size: 0.72rem; color: var(--text-muted);
    border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    padding: 0 6px; background: transparent; min-height: 0;
  }
  button.orq-badge, .orq-more { position: relative; }
  /* Área de toque de 24px sem mexer no tamanho visual. */
  button.orq-badge::before, .orq-more::before { content: ''; position: absolute; inset: -5px -4px; }
  button.orq-badge { cursor: pointer; }
  button.orq-badge:hover { border-color: var(--text-muted); }
  button.orq-badge:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .orq-body :global(p) { margin: 0; }
  .orq-more {
    background: none; border: 0; padding: 0; min-height: 0; margin-top: 2px;
    color: var(--accent); font-size: 0.78rem; cursor: pointer;
  }
  .orq-q { margin-top: 6px; }
  .orq-file { margin-top: 6px; }
  .orq-detail { margin-top: 6px; font-size: 0.78rem; color: var(--text-muted); }
</style>
