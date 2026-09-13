<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Server } from '../../lib/auth';
  import { getSyncSetup, activateSync, disableSync } from '../../lib/sync';
  import ConfirmSheet from '../ConfirmSheet.svelte';
  import { copyText } from '../../lib/clipboard';
  import * as m from '../../paraglide/messages';

  let { server }: { server: Server } = $props();
  let setup = $state<Awaited<ReturnType<typeof getSyncSetup>> | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let user = $state('');
  let password = $state('');
  let confirmation = $state('');
  let copied = $state(false);
  let activated = $state(false);
  let deactivated = $state(false);
  let confirmDisable = $state(false);
  const controller = new AbortController();
  onDestroy(() => controller.abort());
  const address = $derived(new URL('/', new URL(server.baseUrl || '/', window.location.href)).href);
  const sameOrigin = $derived(new URL(address).origin === window.location.origin);
  const secure = typeof crypto.subtle !== 'undefined';

  async function load() {
    loading = true;
    error = '';
    try {
      const value = await getSyncSetup(server, controller.signal);
      if (!controller.signal.aborted) setup = value;
    } catch (e) {
      if (!controller.signal.aborted) error = e instanceof Error ? e.message : m.sync_config_erro();
    } finally {
      if (!controller.signal.aborted) loading = false;
    }
  }
  $effect(() => { void load(); });

  async function activate(event: SubmitEvent) {
    event.preventDefault();
    if (saving || !setup) return;
    error = '';
    if (!setup.registered && !secure) { error = m.sync_config_https(); return; }
    if (!setup.registered && password.length < 8) { error = m.sync_password_min(); return; }
    if (!setup.registered && password !== confirmation) {
      error = m.sync_config_senhas_diferentes();
      return;
    }
    saving = true;
    try {
      const result = await activateSync(server, setup.registered ? undefined : { user: user.trim(), password });
      if (controller.signal.aborted) return;
      setup = result;
      password = confirmation = '';
      activated = true;
      deactivated = false;
    } catch (e) {
      if (controller.signal.aborted) return;
      error = e instanceof Error ? e.message : m.sync_config_erro();
      // A conta pode ter sido criada antes de falhar a ativação ou o login.
      try {
        const current = await getSyncSetup(server, controller.signal);
        if (!controller.signal.aborted) setup = current;
      } catch { /* mantém o erro original e permite tentar novamente */ }
    } finally {
      if (!controller.signal.aborted) saving = false;
    }
  }

  async function copyAddress() {
    try { await copyText(address); copied = true; }
    catch (e) { error = e instanceof Error ? e.message : m.sync_config_erro(); }
  }

  async function disable() {
    if (saving) return;
    saving = true;
    error = '';
    try {
      const result = await disableSync(server);
      if (controller.signal.aborted) return;
      setup = result;
      activated = false;
      deactivated = true;
    } catch (e) {
      if (!controller.signal.aborted) error = e instanceof Error ? e.message : m.sync_config_erro();
    } finally {
      if (!controller.signal.aborted) saving = false;
    }
  }

  function openSynced(event: MouseEvent) {
    if (sameOrigin) { event.preventDefault(); window.location.reload(); }
  }
</script>

<div class="sync-settings">
  <p>{m.sync_config_ganho()}</p>
  <p>{m.sync_config_principal({ servidor: server.label })}</p>
  <p class="context">{sameOrigin ? m.sync_config_neste_endereco() : m.sync_config_outro_endereco()}</p>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if loading}
    <p role="status">{m.comum_carregando()}</p>
  {:else if !setup}
    <button type="button" class="action" onclick={load}>{m.lista_tentar_novamente()}</button>
  {:else if setup.enabled && setup.registered}
    <p class="status" role="status">{activated ? m.sync_config_ativada() : m.sync_config_ativa()}</p>
    {#if setup.user}<p>{m.sync_config_usuario_atual({ usuario: setup.user })}</p>{/if}
    <p>{m.sync_config_como_entrar()}</p>
    <div class="address">
      <a href={address} onclick={openSynced}>{address}</a>
      <button type="button" onclick={copyAddress}>{copied ? m.sync_config_copiado() : m.sync_config_copiar()}</button>
    </div>
    <a class="action" href={address} onclick={openSynced}>{m.sync_config_abrir()}</a>
    <button type="button" class="action" disabled={saving} aria-busy={saving} onclick={() => (confirmDisable = true)}>{m.sync_config_desativar()}</button>
  {:else}
    {#if !setup.enabled}<p class="status">{m.sync_config_direta()}</p>{/if}
    {#if deactivated}
      <p role="status">{m.sync_config_desativada()}</p>
      {#if sameOrigin}<a class="action" href={address} onclick={openSynced}>{m.sync_config_modo_direto()}</a>{/if}
    {/if}
    <form onsubmit={activate}>
      {#if setup.registered}
        <p>{m.sync_config_conta_existente({ usuario: setup.user ?? '' })}</p>
      {:else}
        <label for="sync-setup-user">{m.login_usuario()}</label>
        <input id="sync-setup-user" bind:value={user} autocomplete="username" maxlength="100" required disabled={saving} />
        <label for="sync-setup-password">{m.login_senha()}</label>
        <input id="sync-setup-password" type="password" bind:value={password} autocomplete="new-password" minlength="8" required disabled={saving} />
        <label for="sync-setup-confirmation">{m.sync_config_confirmar_senha()}</label>
        <input id="sync-setup-confirmation" type="password" bind:value={confirmation} autocomplete="new-password" required disabled={saving} />
        <p>{m.sync_config_password_help()}</p>
      {/if}
      {#if !setup.registered && !secure}<p role="alert">{m.sync_config_https()}</p>{/if}
      <button class="action" type="submit" disabled={saving || (!setup.registered && !secure)} aria-busy={saving}>
        {saving ? m.sync_config_ativando() : setup.registered ? m.sync_config_reativar() : m.sync_config_ativar()}
      </button>
    </form>
    {#if setup.enabled}
      <button type="button" class="action" disabled={saving} onclick={() => (confirmDisable = true)}>{m.sync_config_desativar()}</button>
    {/if}
  {/if}
</div>

<ConfirmSheet open={confirmDisable} title={m.sync_config_desativar()}
  message={m.sync_config_desativar_aviso()} confirmLabel={m.sync_config_desativar()}
  onConfirm={() => { void disable(); }} onClose={() => (confirmDisable = false)} />

<style>
  .sync-settings { display: flex; flex-direction: column; gap: var(--space-4); container-type: inline-size; }
  p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; }
  .context { color: var(--text-muted); }
  .error { color: var(--error); }
  .status { color: var(--text-primary); font-weight: 600; }
  form { display: flex; flex-direction: column; gap: var(--space-2); }
  label { margin-top: var(--space-2); color: var(--text-primary); font-size: var(--text-sm); }
  input { width: 100%; box-sizing: border-box; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-inset); color: var(--text-primary); font: inherit; }
  button, .action { padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-primary); font: inherit; font-size: var(--text-sm); cursor: pointer; }
  .action { align-self: flex-start; text-decoration: none; margin-top: var(--space-2); }
  button:disabled { opacity: .6; cursor: default; }
  .address { display: flex; align-items: center; gap: var(--space-3); }
  a { color: var(--text-primary); overflow-wrap: anywhere; min-width: 0; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @container (max-width: 420px) { .address { flex-direction: column; align-items: flex-start; } }
</style>
