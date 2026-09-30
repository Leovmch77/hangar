<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import * as m from '../paraglide/messages';
  import { getOrqPanelForServer, pct, taskRows, teamView } from '@hangar/core';
  import type { OrqPanel, OrqPanelTask, OrqTeamMember, OrqTeamRow, OrqTeamStatus, Server } from '@hangar/core';
  import Spinner from './Spinner.svelte';
  import { sessionsStore } from '../lib/sessionsStore.svelte';
  import { money, tok } from '../lib/fmt';
  import { moeda } from '../lib/moeda.svelte';
  import { intlLocale } from '../lib/locale';

  interface Props {
    server: Server;
    sessionName: string;
    arbiter: string | null;
    onOpenSession: (name: string) => void;
    onOpenFile: (path: string) => void;
    actions?: Snippet;
  }
  let { server, sessionName, arbiter, onOpenSession, onOpenFile, actions }: Props = $props();

  let panel = $state<OrqPanel | null>(null);
  let error = $state('');
  let showQueued = $state(false);
  let showEnded = $state(false);

  // Um pedido por vez por sessão; resposta de uma sessão que já foi trocada é descartada.
  let inflight: string | null = null;
  async function load() {
    const name = sessionName;
    if (inflight === name) return;
    inflight = name;
    try {
      const p = await getOrqPanelForServer(server, name);
      if (name !== sessionName) return;
      panel = p;
      error = '';
    } catch (e) {
      if (name === sessionName) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (inflight === name) inflight = null;
    }
  }

  $effect(() => {
    void sessionName; void server.id;
    untrack(() => {
      panel = null; error = ''; showQueued = false; showEnded = false;
      void load();
    });
  });

  onMount(() => {
    sessionsStore.retain();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10_000);
    return () => { clearInterval(t); sessionsStore.release(); };
  });

  // Só quem vai mostrar custo pede a cotação.
  $effect(() => { if (panel?.consumption?.totals.usd != null) moeda.garantirCotacao(); });

  const live = $derived(new Map(sessionsStore.sessionsForServer(server.id).map((s) => [s.name, s.state as string])));
  const team = $derived(panel ? teamView(panel.team, live) : { shown: [], ended: [] });
  const rows = $derived(panel ? taskRows(panel.tasks.rows) : { visible: [], queued: [], queuedCount: 0 });
  const barWidth = $derived.by(() => {
    const t = panel?.tasks;
    return t && t.total_known && t.total > 0 ? Number(((t.integrated / t.total) * 100).toFixed(2)) : 0;
  });

  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  const dayTime = (iso: string) => new Date(iso).toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function taskState(t: OrqPanelTask): string {
    const round = t.round ?? '—';
    switch (t.state) {
      case 'queued': return m.orq_state_queued();
      case 'executing': return m.orq_state_executing();
      case 'in_review': return m.orq_state_in_review({ round });
      case 'rejected': return m.orq_state_rejected({ round });
      case 'approved': return m.orq_state_approved({ round });
      case 'integrated': return m.orq_state_integrated();
      case 'integration_red': return m.orq_state_integration_red();
    }
  }
  function role(t: OrqTeamMember): string {
    if (t.role === 'arbiter') return m.orq_role_arbiter();
    const task = t.task ?? '—';
    return t.role === 'executor' ? m.orq_role_executor({ task }) : m.orq_role_reviewer({ task });
  }
  function status(s: OrqTeamStatus): string {
    const round = s.round ?? '—';
    switch (s.key) {
      case 'orq_live_working': return m.orq_live_working();
      case 'orq_live_waiting': return m.orq_live_waiting();
      case 'orq_live_ended': return m.orq_live_ended();
      case 'orq_last_started': return m.orq_last_started();
      case 'orq_last_delivered': return m.orq_last_delivered({ round });
      case 'orq_last_approved': return m.orq_last_approved({ round });
      case 'orq_last_rejected': return m.orq_last_rejected({ round });
      case 'orq_last_swapped_in': return m.orq_last_swapped_in();
      default: return m.orq_live_idle();
    }
  }
  function dot(key: string): string {
    if (key === 'orq_live_working') return 'working';
    if (key === 'orq_live_waiting') return 'waiting';
    return 'idle';
  }
  function mode(v: string): string {
    return v === 'on' ? m.orq_mode_on() : v === 'shadow' ? m.orq_mode_shadow() : m.orq_mode_off();
  }
  const cost = (usd: number | null) => (usd == null ? '—' : money(usd, moeda.cur, moeda.rate));
  const outcomeText = (o: NonNullable<OrqPanel['integration']['outcome']>) =>
    o === 'green' ? m.orq_int_green() : o === 'red' ? m.orq_int_red() : o === 'conflict' ? m.orq_int_conflict() : m.orq_int_failed();
</script>

{#snippet member(t: OrqTeamRow)}
  <button type="button" class="member" onclick={() => onOpenSession(t.name)}>
    <b><span class="dot {dot(t.status.key)}"></span>{t.name}</b>
    <span class="sub">{role(t)} · {status(t.status)}</span>
  </button>
{/snippet}

<div class="orq-panel">
  {#if !panel}
    {#if error}
      <p class="warn">{m.orq_panel_fetch_error({ error })}</p>
      <button type="button" class="link" onclick={() => void load()}>{m.orq_panel_retry()}</button>
    {:else}
      <Spinner label={m.orq_panel_loading()} />
    {/if}
  {:else}
    <!-- Falha numa revalidação não derruba o retrato que já está na tela. -->
    {#if error}
      <p class="warn">{m.orq_panel_fetch_error({ error })}</p>
      <button type="button" class="link" onclick={() => void load()}>{m.orq_panel_retry()}</button>
    {/if}
    {#each panel.errors as e (e.file)}
      <p class="warn">{m.orq_panel_file_error({ file: e.file, error: e.error })}</p>
    {/each}

    {#if panel.empty}
      <p class="muted">{m.orq_panel_empty()}</p>
    {:else}
      <section>
        <h3>
          <span>{m.orq_tasks_title()}</span>
          <span>{panel.tasks.total_known
            ? m.orq_tasks_count({ n: panel.tasks.integrated, total: panel.tasks.total })
            : m.orq_tasks_count_unknown({ n: panel.tasks.integrated })}</span>
        </h3>
        {#if panel.tasks.total_known}
          <div class="bar"><i style:width={`${barWidth}%`}></i></div>
        {/if}
        {#each rows.visible as t (t.n)}
          {@render taskRow(t)}
        {/each}
        {#if rows.queuedCount > 0}
          <button type="button" class="link" aria-expanded={showQueued} onclick={() => (showQueued = !showQueued)}>
            {m.orq_tasks_queued({ n: rows.queuedCount })}
          </button>
          {#if showQueued}
            {#each rows.queued as t (t.n)}
              {@render taskRow(t)}
            {/each}
          {/if}
        {/if}
      </section>

      <section>
        <h3><span>{m.orq_team_title()}</span></h3>
        <div class="team">
          {#each team.shown as t (t.name)}{@render member(t)}{/each}
          {#if showEnded}
            {#each team.ended as t (t.name)}{@render member(t)}{/each}
          {/if}
        </div>
        {#if team.ended.length > 0}
          <button type="button" class="link" aria-expanded={showEnded} onclick={() => (showEnded = !showEnded)}>
            {showEnded ? m.orq_team_hide_ended() : m.orq_team_show_ended({ n: team.ended.length })}
          </button>
        {/if}
      </section>

      <section>
        <h3><span>{m.orq_decisions_title()}</span><span>{panel.decisions.length}</span></h3>
        {#each panel.decisions as d (d.event_id)}
          <div class="decision">
            <div class="head">
              {#if d.task != null}<span class="tag">T{d.task}</span>{/if}
              <span class="muted">{m.orq_decision_unanswered({ time: hhmm(d.ts) })}</span>
            </div>
            <p class="question">{d.question}</p>
            <div class="row">
              {#if d.parecer}
                {@const parecer = d.parecer}
                <button type="button" class="link" onclick={() => onOpenFile(parecer)}>{m.orq_open_parecer()}</button>
              {/if}
              <button type="button" class="link" disabled={!arbiter} onclick={() => { if (arbiter) onOpenSession(arbiter); }}>{m.orq_talk_to_arbiter()}</button>
            </div>
          </div>
        {:else}
          <p class="muted">{m.orq_decisions_none()}</p>
        {/each}
      </section>

      {@const a = panel.automation}
      <section class="auto">
        <h3>
          <span>{m.orq_auto_title()}</span>
          <span>{m.orq_auto_mode({ jev: mode(a.mode.jev), regex: mode(a.mode.regex) })}</span>
        </h3>
        <div class="tiles">
          <div class="tile"><b>{a.woke.total}</b><span>{m.orq_auto_woke()}</span></div>
          <div class="tile"><b>{a.alone.total}</b><span>{m.orq_auto_alone()}</span></div>
          <div class="tile"><b>{a.dropped_by_jev}</b><span>{m.orq_auto_dropped()}</span></div>
        </div>
        <p class="note">{m.orq_auto_woke_detail({ decisions: a.woke.decisions, alarms: a.woke.alarms, messages: a.woke.messages })}</p>
        <p class="note">{m.orq_auto_alone_detail({ opened: a.alone.opened, integrated: a.alone.integrated, dropped: a.alone.dropped })}</p>
        <details class="adv">
          <summary>{m.orq_adv_title()}</summary>
          <div class="adv-row"><span>{m.orq_adv_false_positive()}</span><b>{a.advanced.would_drop}</b></div>
          <p class="note">{m.orq_adv_false_positive_hint()}</p>
          <div class="adv-row"><span>{m.orq_adv_disagree()}</span><b>{m.orq_adv_disagree_value({ n: a.advanced.disagree, m: a.advanced.judged })}</b></div>
          <p class="note">{m.orq_adv_disagree_hint()}</p>
          <div class="adv-row"><span>{m.orq_adv_min_conf()}</span><b>{a.advanced.min_confidence ? pct(a.advanced.min_confidence.p) : '—'}</b></div>
          <p class="note">{m.orq_adv_min_conf_hint()}</p>
          <div class="adv-row"><span>{m.orq_adv_by_rule()}</span><b>{a.advanced.by_rule}</b></div>
          <p class="note">{m.orq_adv_by_rule_hint()}</p>
        </details>
      </section>

      {@const c = panel.consumption}
      <section class="use">
        <h3>
          <span>{m.orq_use_title()}</span>
          {#if c}<span>{m.orq_use_sessions({ measured: c.sessions.measured, team: c.sessions.team })}</span>{/if}
        </h3>
        {#if !c}
          <p class="muted">{m.orq_use_computing()}</p>
        {:else}
          <div class="tiles">
            <div class="tile"><b>{tok(c.totals.new)}</b><span>{m.orq_use_new()}</span></div>
            <div class="tile"><b>{tok(c.totals.cache_read)}</b><span>{m.orq_use_cache()}</span></div>
            <div class="tile"><b>{cost(c.totals.usd)}{c.totals.usd_partial ? '*' : ''}</b><span>{m.orq_use_cost()}</span></div>
          </div>
          <table class="use-table">
            <thead>
              <tr><th></th><th>{m.orq_use_col_new()}</th><th>{m.orq_use_col_cache()}</th><th>{m.orq_use_col_cost()}</th></tr>
            </thead>
            <tbody>
              {#each c.providers as p (p.provider)}
                <tr class="prov"><td>{p.provider}</td><td>{tok(p.new)}</td><td>{tok(p.cache_read)}</td><td>{cost(p.usd)}</td></tr>
                {#each p.models as md (md.model)}
                  <tr class="mdl"><td>{m.orq_use_model_sessions({ model: md.model, n: md.sessions })}</td><td>{tok(md.new)}</td><td>{tok(md.cache_read)}</td><td>{cost(md.usd)}</td></tr>
                {/each}
              {/each}
            </tbody>
          </table>
          <p class="note">{m.orq_use_method({ since: c.since ? dayTime(c.since) : '—' })}</p>
          {#if c.sessions.missing.length}<p class="note">{m.orq_use_missing({ names: c.sessions.missing.join(', ') })}</p>{/if}
          {#if c.missing_prices.length}<p class="note">{m.orq_use_no_price({ models: c.missing_prices.join(', ') })}</p>{/if}
        {/if}
      </section>

      {@const it = panel.integration}
      <section class="int">
        <h3><span>{m.orq_int_title()}</span></h3>
        <p><span class="muted">{m.orq_int_branch()}</span> {#if it.branch}<code>{it.branch}</code>{:else}—{/if}</p>
        <p>
          <span class="muted">{m.orq_int_last()}</span>
          {#if it.last}
            T{it.last.task} · <code>{it.last.commit.slice(0, 7)}</code> · {hhmm(it.last.ts)}
          {:else}
            {m.orq_int_none()}
          {/if}
        </p>
        {#if it.outcome}
          <p class="outcome {it.outcome}"><span class="dot"></span>{outcomeText(it.outcome)}</p>
        {/if}
        {#if it.delivery_checks.total > 0}
          {@const ch = it.delivery_checks}
          <p class="outcome {ch.failing.length ? 'red' : 'green'}">
            <span class="dot"></span>{ch.failing.length
              ? m.orq_int_checks_red({ ok: ch.ok, total: ch.total, tasks: ch.failing.join(', ') })
              : m.orq_int_checks_green({ ok: ch.ok, total: ch.total })}
          </p>
        {/if}
      </section>
    {/if}
  {/if}

  {#if actions}
    <section class="actions">
      <h3><span>{m.ctx_acoes()}</span></h3>
      {@render actions()}
    </section>
  {/if}
</div>

{#snippet taskRow(t: OrqPanelTask)}
  <div class="task-row">
    <span class="n">T{t.n}</span>
    <span class="title" title={t.title}>{t.title}</span>
    <span class="st {t.state}">{taskState(t)}</span>
  </div>
{/snippet}

<style>
  .orq-panel { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  section { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; background: transparent; }
  h3 {
    display: flex; justify-content: space-between; gap: var(--space-2); margin: 0;
    color: var(--text-muted); font-size: var(--text-xs); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  p { margin: 0; font-size: var(--text-sm); }
  .warn { color: var(--warning); }
  .muted, .note { color: var(--text-muted); }
  .note { font-size: var(--text-xs); }
  .link {
    align-self: flex-start; min-height: 0; padding: 0; background: transparent;
    color: var(--accent); font-size: var(--text-xs);
  }
  .link:disabled { color: var(--text-muted); }
  code { font-family: var(--font-mono); font-size: var(--text-xs); }

  .bar { height: 6px; border-radius: 4px; overflow: hidden; background: var(--surface-inset); }
  .bar i { display: block; height: 100%; background: var(--success); }
  .task-row {
    display: grid; grid-template-columns: 2.4em minmax(0, 1fr) auto; gap: var(--space-2); align-items: center;
    padding: 4px 0; border-bottom: 1px solid var(--border-subtle); font-size: var(--text-sm);
  }
  .task-row .n { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
  .task-row .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { padding: 1px 7px; border-radius: 6px; background: var(--surface-inset); color: var(--text-muted); font-size: var(--text-xs); font-weight: 600; white-space: nowrap; }
  .st.integrated, .st.approved { background: var(--success-dim, var(--surface-inset)); color: var(--success); }
  .st.in_review, .st.executing { background: var(--accent-dim); color: var(--accent); }
  .st.rejected, .st.integration_red { color: var(--error, var(--warning)); }

  .team { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
  .member {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 0; min-width: 0;
    padding: var(--space-2); text-align: left;
    border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
    background: var(--surface-raised); color: var(--text-primary);
  }
  .member b { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); }
  .member .sub { color: var(--text-muted); font-size: var(--text-xs); }
  .dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: var(--text-muted); }
  .dot.working { background: var(--accent); }
  .dot.waiting { background: var(--warning); }

  .decision {
    display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-2) var(--space-3);
    border: 1px solid var(--warning); border-radius: var(--radius-lg);
    background: var(--surface-raised);
  }
  .decision .head { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); }
  .decision .row { display: flex; gap: var(--space-3); }
  .question { overflow-wrap: anywhere; }
  .tag { padding: 0 6px; border-radius: 6px; background: var(--surface-inset); font-size: var(--text-xs); font-weight: 600; }

  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
  .tile {
    display: flex; flex-direction: column; padding: var(--space-2);
    border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised);
  }
  .tile b { font-size: var(--text-base); }
  .tile span { color: var(--text-muted); font-size: var(--text-xs); }

  .adv { padding: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); font-size: var(--text-xs); }
  .adv summary { cursor: pointer; color: var(--text-muted); }
  .adv-row { display: flex; justify-content: space-between; gap: var(--space-2); padding-top: var(--space-1); }

  .use-table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
  .use-table th { color: var(--text-muted); font-weight: 500; text-align: right; padding: 2px 4px; }
  .use-table td { padding: 3px 4px; border-top: 1px solid var(--border-subtle); text-align: right; }
  .use-table td:first-child { text-align: left; overflow-wrap: anywhere; }
  .use-table .prov td:first-child { font-weight: 700; text-transform: capitalize; }
  .use-table .mdl td:first-child { padding-left: var(--space-3); color: var(--text-secondary); }

  .int p { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
  .outcome .dot { background: var(--text-muted); }
  .outcome.green .dot { background: var(--success); }
  .outcome.red .dot, .outcome.conflict .dot, .outcome.failed .dot { background: var(--warning); }
</style>
