<script lang="ts">
  import { untrack } from 'svelte';
  import { folderGitActionForServer, getFolderGitForServer, type FolderGit, type Server } from '@hangar/core';
  import BottomSheet from './BottomSheet.svelte';
  import QuietPill from './newchat/QuietPill.svelte';
  import * as m from '../paraglide/messages';

  // Pílula de git da pasta (porte de `create/folder_git.rs`): some fora de repositório; o toque abre
  // a folha com o estado e os botões Fetch e Pull.
  interface Props { server: Server; cwd: string; root?: string; disabled?: boolean }
  let { server, cwd, root, disabled = false }: Props = $props();

  let git = $state<FolderGit | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let open = $state(false);
  let busy = $state<'fetch' | 'pull' | null>(null);
  let note = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let seq = 0;

  const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : m.home_usage_load_failed());

  async function load() {
    const mine = ++seq;
    loading = true;
    failed = false;
    git = null;
    note = null;
    try {
      const g = await getFolderGitForServer(server, cwd, undefined, root);
      if (mine === seq) git = g;
    } catch {
      if (mine === seq) failed = true;
    } finally {
      if (mine === seq) loading = false;
    }
  }

  // Pasta ou máquina nova: o estado anterior não vale.
  $effect(() => {
    void [server.id, cwd, root];
    untrack(() => void load());
  });

  const diverged = $derived(!!git && (git.ahead ?? 0) > 0 && (git.behind ?? 0) > 0);
  const pullBlock = $derived.by(() => {
    if (!git) return '';
    if ((git.dirty ?? 0) > 0) return m.native_folder_git_dirty({ n: String(git.dirty) });
    if (!git.upstream) return m.native_folder_git_no_upstream_pull();
    if (diverged) {
      return m.native_folder_git_diverged({
        upstream: git.upstream, ahead: String(git.ahead ?? 0), behind: String(git.behind ?? 0),
      });
    }
    return '';
  });

  const label = $derived.by(() => {
    if (!git) return m.native_folder_git_label();
    const parts = [
      (git.behind ?? 0) > 0 ? `↓${git.behind}` : '',
      (git.ahead ?? 0) > 0 ? `↑${git.ahead}` : '',
      (git.dirty ?? 0) > 0 ? m.native_folder_git_changes({ n: String(git.dirty) }) : '',
    ].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    return git.upstream ? m.native_folder_git_up_to_date() : m.native_folder_git_label();
  });

  function ago(epoch: number): string {
    const s = Date.now() / 1000 - epoch;
    if (s < 60) return m.native_ago_now();
    if (s < 3600) return m.native_ago_min({ n: String(Math.floor(s / 60)) });
    if (s < 86400) return m.native_ago_h({ n: String(Math.floor(s / 3600)) });
    return m.native_ago_d({ n: String(Math.floor(s / 86400)) });
  }

  const statusLine = $derived.by(() => {
    if (!git) return '';
    const parts = [git.upstream ?? m.native_folder_git_no_upstream()];
    if (git.upstream) {
      const behind = git.behind ?? 0;
      const ahead = git.ahead ?? 0;
      if (!behind && !ahead) parts.push(m.native_folder_git_up_to_date());
      if (behind) parts.push(m.native_folder_git_behind({ n: String(behind) }));
      if (ahead) parts.push(m.native_folder_git_ahead({ n: String(ahead) }));
    }
    if ((git.dirty ?? 0) > 0) parts.push(m.native_folder_git_changes({ n: String(git.dirty) }));
    parts.push(git.last_fetch ? m.native_folder_git_fetched({ quando: ago(git.last_fetch) }) : m.native_folder_git_never_fetched());
    return parts.join(' · ');
  });

  async function act(action: 'fetch' | 'pull') {
    if (busy) return;
    busy = action;
    note = null;
    try {
      git = await folderGitActionForServer(server, cwd, action, root);
      note = {
        kind: 'ok',
        text: action === 'fetch'
          ? m.native_folder_git_fetch_done()
          : m.native_folder_git_pull_done({ upstream: git.upstream ?? '' }),
      };
    } catch (e) {
      note = { kind: 'err', text: errText(e) };
    } finally {
      busy = null;
    }
  }
</script>

{#if git?.repo || (failed && !git) || (loading && !git)}
  <QuietPill label={label} ariaLabel={m.native_folder_git_title()} loading={loading && !git}
    disabled={disabled} onclick={() => (open = true)}>
    {#snippet icon()}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
      </svg>
    {/snippet}
  </QuietPill>
{/if}

<BottomSheet {open} onClose={() => (open = false)} ariaLabel={m.native_folder_git_title()}>
  <div class="sheet">
    <h2 class="title">{m.native_folder_git_title()}</h2>
    {#if failed && !git}
      <p class="help err" role="alert">{m.home_usage_load_failed()}</p>
      <button type="button" class="btn" onclick={() => load()}>{m.sync_retry()}</button>
    {:else if git?.repo}
      <p class="branch">{git.current ?? 'HEAD'}</p>
      <p class="help" role="status">{statusLine}</p>
      <div class="actions">
        <button type="button" class="btn" disabled={!!busy} onclick={() => act('fetch')}>
          {m.native_folder_git_fetch()}
        </button>
        <button type="button" class="btn primary" disabled={!!busy || !!pullBlock} onclick={() => act('pull')}>
          {m.native_folder_git_pull()}
        </button>
      </div>
      {#if note}
        <p class="help" class:err={note.kind === 'err'} role="alert">{note.text}</p>
      {:else if pullBlock}
        <p class="help warn" role="alert">{pullBlock}</p>
      {/if}
    {:else if git}
      <p class="help">{m.native_folder_git_not_repo()}</p>
    {/if}
  </div>
</BottomSheet>

<style>
  .sheet { padding: var(--space-2) var(--space-4) calc(env(safe-area-inset-bottom) + var(--space-4)); }
  .title { margin: 0 0 var(--space-2); font-size: var(--text-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .branch { margin: 0; font-size: var(--text-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .help { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-muted); }
  .help.warn { color: var(--warning, var(--text-secondary)); }
  .help.err { color: var(--danger, var(--text-secondary)); }
  .actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }
  .btn {
    flex: 1; min-height: 44px; border: 1px solid var(--fill-subtle); border-radius: var(--radius-md);
    background: transparent; color: var(--text-primary); font-size: var(--text-sm); cursor: pointer;
  }
  .btn.primary { background: var(--accent-dim); }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
