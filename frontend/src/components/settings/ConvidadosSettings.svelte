<!-- frontend/src/components/settings/ConvidadosSettings.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { listOwnServers } from '../../lib/auth';
  import { listGuests, saveGuest, removeGuest, type GuestAdmin, type ServerFailure } from '../../lib/guests';
  import ConfirmSheet from '../ConfirmSheet.svelte';
  import * as m from '../../paraglide/messages';

  const servers = listOwnServers();
  let guests = $state<GuestAdmin[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let formOpen = $state(false);
  let editing = $state<GuestAdmin | null>(null);
  let user = $state('');
  let password = $state('');
  let seesOwner = $state(false);
  let ownerSees = $state(true);
  // Servidor marcado = tem chave aqui; o valor é a pasta.
  let roots = $state<Record<string, string>>({});
  let saving = $state(false);
  let formError = $state('');
  let failures = $state<ServerFailure[]>([]);
  let savedOk = $state(false);
  let confirmRemove = $state<GuestAdmin | null>(null);

  async function load() {
    loading = true;
    loadError = '';
    try { guests = await listGuests(); }
    catch (e) { loadError = e instanceof Error ? e.message : String(e); }
    finally { loading = false; }
  }
  onMount(load);

  function open(g: GuestAdmin | null) {
    editing = g;
    user = g?.user ?? '';
    password = g?.password ?? '';
    seesOwner = g?.seesOwner ?? false;
    ownerSees = g?.ownerSees ?? true;
    roots = Object.fromEntries((g?.servers ?? []).map((s) => [s.serverId, s.root]));
    formError = '';
    failures = [];
    savedOk = false;
    formOpen = true;
  }

  function toggle(id: string, on: boolean) {
    if (on) roots = { ...roots, [id]: roots[id] ?? '' };
    else { const { [id]: _, ...rest } = roots; roots = rest; }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    formError = '';
    const chosen = Object.entries(roots).map(([serverId, root]) => ({ serverId, root: root.trim() }));
    if (password.length < 8) { formError = m.sync_password_min(); return; }
    if (!chosen.length) { formError = m.convidados_servidor_obrigatorio(); return; }
    if (chosen.some((c) => !c.root)) { formError = m.convidados_pasta_obrigatoria(); return; }
    saving = true;
    try {
      const { saved, errors } = await saveGuest(
        { user: user.trim(), password, seesOwner, ownerSees, servers: chosen }, editing);
      guests = [...guests.filter((g) => g.user !== saved.user), saved];
      // Com falha parcial o formulário fica aberto e salvar de novo repete só o que faltou.
      editing = saved;
      failures = errors;
      savedOk = errors.length === 0;
      if (savedOk) formOpen = false;
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function remove(g: GuestAdmin) {
    failures = await removeGuest(g).catch((e) => [{ label: g.user, message: e instanceof Error ? e.message : String(e) }]);
    await load();
  }

  const label = (id: string) => servers.find((s) => s.id === id)?.label ?? id;
</script>

<section class="guests" aria-labelledby="guests-title">
  <p class="guests-title" id="guests-title">{m.convidados_titulo()}</p>
  <p>{m.convidados_descricao()}</p>
  {#if savedOk}<p class="status" role="status">{m.convidados_salvo()}</p>{/if}
  {#each failures as f}<p class="error" role="alert">{m.convidados_falha_servidor({ servidor: f.label, erro: f.message })}</p>{/each}

  {#if loading}
    <p role="status">{m.comum_carregando()}</p>
  {:else if loadError}
    <p class="error" role="alert">{m.convidados_erro({ erro: loadError })}</p>
    <button type="button" class="action" onclick={load}>{m.lista_tentar_novamente()}</button>
  {:else}
    {#if guests.length === 0}
      <p>{m.convidados_vazio()}</p>
    {:else}
      <ul>
        {#each guests as g (g.user)}
          <li>
            <span class="who">{g.user}</span>
            <span class="meta">{m.convidados_resumo({ servidores: g.servers.length })}</span>
            <button type="button" onclick={() => open(g)}>{m.convidados_editar()}</button>
            <button type="button" onclick={() => (confirmRemove = g)}>{m.convidados_remover()}</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if !formOpen}
      <button type="button" class="action" onclick={() => open(null)}>{m.convidados_adicionar()}</button>
    {/if}
  {/if}

  {#if formOpen}
    <form onsubmit={submit}>
      <label for="guest-user">{m.login_usuario()}</label>
      <input id="guest-user" bind:value={user} autocomplete="off" maxlength="100" required disabled={saving || !!editing} />
      <label for="guest-password">{m.login_senha()}</label>
      <input id="guest-password" type="password" bind:value={password} autocomplete="new-password" minlength="8" required disabled={saving} />
      <label class="check"><input type="checkbox" bind:checked={seesOwner} disabled={saving} /> {m.convidados_ve_minhas()}</label>
      <label class="check"><input type="checkbox" bind:checked={ownerSees} disabled={saving} /> {m.convidados_eu_vejo()}</label>
      <fieldset>
        <legend>{m.convidados_servidores()}</legend>
        {#each servers as s (s.id)}
          <label class="check">
            <input type="checkbox" checked={s.id in roots} disabled={saving}
              onchange={(e) => toggle(s.id, e.currentTarget.checked)} /> {s.label}
          </label>
          {#if s.id in roots}
            <label for="guest-root-{s.id}">{m.convidados_pasta({ servidor: label(s.id) })}</label>
            <input id="guest-root-{s.id}" bind:value={roots[s.id]} required disabled={saving} />
          {/if}
        {/each}
      </fieldset>
      {#if formError}<p class="error" role="alert">{formError}</p>{/if}
      <div class="row">
        <button class="action" type="submit" disabled={saving} aria-busy={saving}>{saving ? m.convidados_salvando() : m.convidados_salvar()}</button>
        <button class="action" type="button" disabled={saving} onclick={() => (formOpen = false)}>{m.comum_cancelar()}</button>
      </div>
    </form>
  {/if}
</section>

<ConfirmSheet open={!!confirmRemove} title={m.convidados_remover()} danger
  message={confirmRemove ? m.convidados_remover_aviso({ usuario: confirmRemove.user }) : null}
  confirmLabel={m.convidados_remover()}
  onConfirm={() => { if (confirmRemove) void remove(confirmRemove); }}
  onClose={() => (confirmRemove = null)} />

<style>
  .guests { display: flex; flex-direction: column; gap: var(--space-3); container-type: inline-size; }
  p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; }
  .guests-title {
    color: var(--text-muted); font-size: var(--label-size); font-weight: var(--label-weight);
    text-transform: uppercase; letter-spacing: var(--label-tracking);
  }
  .error { color: var(--error); }
  .status { color: var(--text-primary); font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  li { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: transparent; }
  .who { color: var(--text-primary); font-weight: 600; }
  .meta { color: var(--text-muted); font-size: var(--text-sm); flex: 1; }
  form, fieldset { display: flex; flex-direction: column; gap: var(--space-2); }
  fieldset { border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-3); margin: 0; }
  legend { color: var(--text-primary); font-size: var(--text-sm); padding: 0 var(--space-1); }
  label { color: var(--text-primary); font-size: var(--text-sm); }
  .check { display: flex; align-items: center; gap: var(--space-2); }
  input:not([type="checkbox"]) { width: 100%; box-sizing: border-box; padding: var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-inset); color: var(--text-primary); font: inherit; }
  button, .action { padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-primary); font: inherit; font-size: var(--text-sm); cursor: pointer; }
  .action { align-self: flex-start; }
  .row { display: flex; gap: var(--space-2); }
  button:disabled { opacity: .6; cursor: default; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @container (max-width: 420px) { li { flex-wrap: wrap; } }
</style>
