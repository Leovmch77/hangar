<script lang="ts">
  import * as m from '../paraglide/messages';

  let { browser = false, headless = false }: { browser?: boolean; headless?: boolean } = $props();
</script>

{#if browser || headless}
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
  </span>
{/if}

<style>
  .session-signals { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
  .session-signal { display: inline-flex; color: var(--text-muted); opacity: .72; }
  .session-signal--browser { color: var(--accent); opacity: .82; }
  .session-signal svg {
    width: 11px; height: 11px; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
  }
</style>
