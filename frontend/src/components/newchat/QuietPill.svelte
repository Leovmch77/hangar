<script lang="ts">
  import type { Snippet } from 'svelte';

  // Pílula "quiet" do nativo: sem borda, texto secundário, ícone de 14px. Abre a folha da escolha.
  interface Props {
    label: string;
    ariaLabel: string;
    icon: Snippet;
    loading?: boolean;
    disabled?: boolean;
    onclick: () => void;
  }
  let { label, ariaLabel, icon, loading = false, disabled = false, onclick }: Props = $props();
</script>

<button type="button" class="pill" class:loading aria-label={`${ariaLabel}: ${label}`} aria-busy={loading}
  disabled={disabled || loading} {onclick}>
  <span class="ico">{@render icon()}</span>
  <span class="txt">{label}</span>
</button>

<style>
  .pill {
    display: inline-flex; align-items: center; gap: 6px; min-height: 32px; max-width: 100%;
    padding: 4px 10px; border: 0; border-radius: var(--radius-full); background: transparent;
    color: var(--text-secondary); font-size: var(--text-sm); cursor: pointer;
  }
  .pill:not(:disabled):active { background: var(--fill-subtle); }
  .pill:disabled { cursor: default; opacity: 0.6; }
  .pill.loading .txt { color: var(--text-muted); }
  .ico { display: inline-flex; width: 14px; height: 14px; flex: none; }
  .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
