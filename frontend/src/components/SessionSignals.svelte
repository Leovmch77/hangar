<script lang="ts">
  import * as m from '../paraglide/messages';

  let { browser = false, headless = false, shared = false, guest = false }:
    { browser?: boolean; headless?: boolean; shared?: boolean; guest?: boolean } = $props();
</script>

{#if browser || headless || shared || guest}
  <span class="session-signals">
    {#if browser}
      <span class="session-signal session-signal--browser" role="img" aria-label={m.nav_remoto_titulo()} title={m.nav_remoto_titulo()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9s1.4-6.4 3.9-9z"/>
        </svg>
      </span>
    {/if}
    {#if headless}
      <span class="session-signal session-signal--headless" role="img" aria-label={m.criar_modo_exec_headless()} title={m.criar_modo_exec_headless()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 10 2 2-2 2M12 14h4M4 4l16 16"/>
        </svg>
      </span>
    {/if}
    {#if shared}
      <span class="session-signal session-signal--shared" role="img" aria-label={m.sessao_compartilhada()} title={m.sessao_compartilhada()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>
        </svg>
      </span>
    {/if}
    {#if guest}
      <span class="session-signal session-signal--guest" role="img" aria-label={m.sessao_convidado()} title={m.sessao_convidado()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>
        </svg>
      </span>
    {/if}
  </span>
{/if}

<style>
  .session-signals { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
  .session-signal { display: inline-flex; color: var(--text-muted); opacity: .72; }
  .session-signal--browser,
  .session-signal--shared,
  .session-signal--guest { color: var(--accent); opacity: .82; }
  .session-signal svg {
    width: 11px; height: 11px; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
  }
</style>
