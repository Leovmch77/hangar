<script lang="ts">
  // Editor da fileira de atalhos configurável: lista ordenada única (nativos + customizados),
  // subir/descer, remover, formulário de adicionar/editar com ícone curado ou emoji, e
  // "restaurar padrão" que apaga o override.
  // O estado salvo mora no servidor (runtime_config.shortcuts) via lib/shortcuts.svelte.ts.
  import * as m from '../../paraglide/messages';
  import {
    defaultShortcuts, getCommands, getSessions,
    type ProjectShortcut, type Shortcut, type ShortcutInternalAction, type ShortcutSendText, type ShortcutShell,
  } from '@hangar/core';
  import {
    loadShortcuts, shortcutsFor, saveShortcuts, loadProjectShortcuts, projectShortcutsFor, projectShortcutsError,
    saveProjectShortcuts,
  } from '../../lib/shortcuts.svelte';
  import ShortcutIcon, { GLYPHS } from '../icons/ShortcutIcon.svelte';
  import ShortcutTransfer from '../ShortcutTransfer.svelte';
  import { getActiveId, type Server } from '../../lib/auth';

  interface Props {
    apiTarget: Server | null;
    // Sessão de onde a tela foi aberta: sem ela, não há projeto e a seção "Deste projeto" some.
    session?: string | null;
  }
  let { apiTarget, session = null }: Props = $props();
  const serverId = $derived(apiTarget?.id ?? null);
  // As rotas do projeto falam com o servidor ATIVO: com outro alvo na tela, a seção editaria o
  // projeto de uma máquina e mostraria como se fosse de outra.
  const projectSession = $derived(session && (!serverId || serverId === getActiveId()) ? session : null);

  type Scope = 'global' | 'project';

  let list = $state<Shortcut[]>([]);
  let loading = $state(true);
  let loadError = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let saveError = $state('');
  let dirty = $state(false);

  async function load() {
    // Servidor fixado na entrada: se o alvo trocar durante a busca, a resposta velha não pode
    // sobrescrever a lista (e a edição) do servidor novo.
    const target = serverId;
    loading = true;
    loadError = false;
    try {
      await loadShortcuts(target);
      if (target !== serverId) return;
      list = shortcutsFor(target).map((s) => ({ ...s }));
      dirty = false;
    } catch (err) {
      if (target !== serverId) return;
      console.error('shortcuts load error:', err);
      loadError = true;
    } finally {
      if (target === serverId) loading = false;
    }
  }
  $effect(() => { serverId; void load(); });

  async function save() {
    if (saving) return;
    saving = true;
    saveError = '';
    try {
      await saveShortcuts(list, serverId);
      dirty = false;
      saved = true;
      setTimeout(() => (saved = false), 2500);
    } catch (e) {
      // Erro de validação do backend chega como veio ("shortcuts: item 2 …").
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // ── Deste projeto: mesma edição, gravação própria (PUT da lista inteira do projeto). ──────────
  let proj = $state<ProjectShortcut[]>([]);
  let projName = $state('');
  let projLoading = $state(false);
  let projLoadError = $state('');
  let projSaving = $state(false);
  let projSaved = $state(false);
  let projSaveError = $state('');
  let projDirty = $state(false);

  async function loadProject() {
    const target = projectSession;
    // A lista da sessão anterior não pode ficar na tela nem ser gravada no projeto da nova.
    proj = [];
    projName = '';
    projDirty = false;
    if (!target) return;
    projLoading = true;
    projLoadError = '';
    try {
      await loadProjectShortcuts(target);
      if (target !== projectSession) return;
      const p = projectShortcutsFor(target);
      proj = (p?.items ?? []).map((s) => ({ ...s }));
      projName = p?.name ?? '';
      projDirty = false;
    } catch (e) {
      if (target !== projectSession) return;
      projLoadError = projectShortcutsError(target);
    } finally {
      if (target === projectSession) projLoading = false;
    }
  }
  $effect(() => { projectSession; void loadProject(); });

  async function saveProject() {
    if (projSaving || !projectSession) return;
    projSaving = true;
    projSaveError = '';
    try {
      const r = await saveProjectShortcuts(projectSession, proj);
      proj = r.items.map((s) => ({ ...s }));
      projDirty = false;
      projSaved = true;
      setTimeout(() => (projSaved = false), 2500);
    } catch (e) {
      // Mensagem já traduzida pelo `code` do backend (errosApi).
      projSaveError = e instanceof Error ? e.message : String(e);
    } finally {
      projSaving = false;
    }
  }

  async function restoreDefaults() {
    if (saving) return;
    saving = true;
    saveError = '';
    try {
      await saveShortcuts(null, serverId);
      list = defaultShortcuts();
      dirty = false;
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // ── Lista ───────────────────────────────────────────────────────────────────
  const INTERNAL_LABEL: Record<ShortcutInternalAction, () => string> = {
    terminal: m.ctx_terminal,
    modo: m.atalhos_interno_modo,
    navegador: m.ctx_navegador,
    anexos: m.ctx_anexos,
    rodar: m.ctx_rodar,
  };
  const INTERNAL_ICON: Record<ShortcutInternalAction, string> = {
    terminal: 'glifo:terminal', modo: 'glifo:git', navegador: 'glifo:globe',
    anexos: 'glifo:folder', rodar: 'glifo:play',
  };
  const missingNatives = $derived(
    (Object.keys(INTERNAL_LABEL) as ShortcutInternalAction[]).filter(
      (a) => !list.some((s) => s.type === 'internal' && s.action === a)));

  // As duas listas passam pelas mesmas operações; o escopo diz qual lista e qual "sujo" mudam.
  function itemsOf(sc: Scope): Shortcut[] { return sc === 'global' ? list : proj; }
  function setItems(sc: Scope, next: Shortcut[], isDirty = true) {
    if (sc === 'global') { list = next; dirty = isDirty; }
    else { proj = next.filter((s): s is ProjectShortcut => s.type !== 'internal'); projDirty = isDirty; }
  }

  function move(sc: Scope, i: number, delta: -1 | 1) {
    const items = itemsOf(sc);
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(sc, next);
  }

  // ── Arrastar pra reordenar. HTML5 DnD não responde ao toque em tablet (regra do repo), então
  // os botões ↑/↓ ficam — são a alternativa exigida pela WCAG 2.2 SC 2.5.7, não redundância. ──
  let dragIdx = $state<number | null>(null);
  let dragScope = $state<Scope | null>(null);
  // A lista se reordena durante o arrasto; cancelado (Esc, soltar fora) ele volta a como estava.
  let beforeDrag: { items: Shortcut[]; dirty: boolean } | null = null;
  function dragStart(e: DragEvent, sc: Scope, i: number) {
    dragIdx = i;
    dragScope = sc;
    beforeDrag = { items: itemsOf(sc), dirty: sc === 'global' ? dirty : projDirty };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    }
  }
  function dragOver(e: DragEvent, sc: Scope, i: number) {
    if (dragScope !== sc) return;   // sem preventDefault: soltar na outra lista é recusado
    e.preventDefault();       // sem isto o drop é recusado e o arrasto "volta"
    if (dragIdx === null || dragIdx === i) return;
    const next = [...itemsOf(sc)];
    const [item] = next.splice(dragIdx, 1);
    next.splice(i, 0, item);
    setItems(sc, next);
    dragIdx = i;
  }
  function dragEnd(e: DragEvent) {
    if (e.dataTransfer?.dropEffect === 'none' && beforeDrag && dragScope) {
      setItems(dragScope, beforeDrag.items, beforeDrag.dirty);
    }
    beforeDrag = null;
    dragIdx = null;
    dragScope = null;
  }
  function remove(sc: Scope, i: number) {
    setItems(sc, itemsOf(sc).filter((_, k) => k !== i));
  }
  function restoreNative(a: ShortcutInternalAction) {
    list = [...list, { id: a, type: 'internal', action: a }];
    dirty = true;
  }

  // ── Formulário (adicionar/editar customizado) ───────────────────────────────
  // Um formulário só na tela; `formScope` diz em qual lista ele abriu (e grava).
  let formScope = $state<Scope | null>(null);
  let editingIdx = $state<number | null>(null);   // índice na lista; null = novo
  let fType = $state<'send_text' | 'shell'>('send_text');
  let fLabel = $state('');
  let fGlyph = $state('bolt');
  let fEmoji = $state('');
  let fContent = $state('');
  let fPasta = $state('');
  let fSendDirect = $state(true);
  let fConfirm = $state(false);
  let fRunsIn = $state<'session' | 'hangar'>('session');
  let fHome = $state(true);
  let fAsk = $state(true);
  const formOpen = $derived(formScope !== null);

  function openNew(sc: Scope) {
    editingIdx = null;
    fType = 'send_text'; fLabel = ''; fGlyph = 'bolt'; fEmoji = '';
    fContent = ''; fPasta = ''; fSendDirect = true; fConfirm = false;
    fRunsIn = 'session'; fHome = true; fAsk = true;
    formScope = sc;
  }
  function openEdit(sc: Scope, i: number) {
    const s = itemsOf(sc)[i];
    if (s.type === 'internal') return;
    editingIdx = i;
    fType = s.type;
    fLabel = s.label;
    fContent = s.type === 'shell' ? s.command : s.text;
    fPasta = s.type === 'shell' ? s.pasta ?? '' : '';
    fSendDirect = s.type === 'send_text' ? s.send_direct !== false : true;
    fConfirm = s.confirm === true;
    fRunsIn = s.type === 'shell' && s.runs_in === 'hangar' ? 'hangar' : 'session';
    fHome = s.type === 'shell' ? s.hangar_home !== false : true;
    fAsk = s.type === 'shell' ? s.answer_in_app !== false : true;
    if (s.icon?.startsWith('emoji:')) { fEmoji = s.icon.slice(6); fGlyph = 'bolt'; }
    else { fEmoji = ''; fGlyph = s.icon?.startsWith('glifo:') ? s.icon.slice(6) : 'bolt'; }
    formScope = sc;
  }
  const formValid = $derived(!!fLabel.trim() && !!fContent.trim());
  function submitForm() {
    const sc = formScope;
    if (!formValid || !sc) return;
    const icon = fEmoji.trim() ? `emoji:${fEmoji.trim()}` : `glifo:${fGlyph}`;
    const base = { label: fLabel.trim(), icon, ...(fConfirm ? { confirm: true } : {}) };
    // Pasta só se edita nos atalhos do projeto (a raiz a que ela se refere é a da cópia da sessão);
    // no global o campo não aparece, e a que o item já tinha volta como estava.
    const original = editingIdx === null ? undefined : itemsOf(sc)[editingIdx];
    const kept = sc === 'global' && original?.type === 'shell' ? original.pasta : undefined;
    const folder = sc === 'project' ? fPasta.trim() : kept;
    const pasta = folder ? { pasta: folder } : {};
    const shortcut: ShortcutSendText | ShortcutShell = fType === 'shell'
      ? { id: formId(sc), type: 'shell', command: fContent.trim(), ...pasta,
          ...(fRunsIn === 'hangar' ? { runs_in: 'hangar' as const } : {}),
          ...(fRunsIn === 'hangar' && !fHome ? { hangar_home: false } : {}),
          ...(fAsk ? {} : { answer_in_app: false }), ...base }
      : { id: formId(sc), type: 'send_text', text: fContent.trim(),
          ...(fSendDirect ? {} : { send_direct: false }), ...base };
    const items = itemsOf(sc);
    setItems(sc, editingIdx === null ? [...items, shortcut] : items.map((s, i) => (i === editingIdx ? shortcut : s)));
    formScope = null;
  }
  function formId(sc: Scope): string {
    if (editingIdx !== null) return itemsOf(sc)[editingIdx].id;
    return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── Sugestão de skill (datalist): comandos de uma sessão viva do servidor ativo. Sem sessão,
  // o campo fica livre — a sugestão é conforto, não requisito. ─────────────────────────────────
  let suggestions = $state<string[]>([]);
  $effect(() => {
    if (!formOpen || fType !== 'send_text' || suggestions.length) return;
    void (async () => {
      try {
        const sessions = await getSessions();
        const alive = sessions.find((s) => s.state !== 'dead');
        if (!alive) return;
        const cmds = await getCommands(alive.name);
        suggestions = cmds.map((c) => c.display ?? `/${c.name}`);
      } catch { /* sem sugestão, campo livre */ }
    })();
  });
</script>

<div class="at">
  {#if projectSession}<h3 class="titulo">{m.atalhos_globais_titulo()}</h3>{/if}
  <p class="sub">{m.atalhos_sub()}</p>

  {#if loading}
    <p class="estado">{m.comum_carregando()}</p>
  {:else if loadError}
    <p class="estado erro">{m.atalhos_erro_carregar()}</p>
    <button class="btn" onclick={() => void load()}>{m.config_server_tentar_de_novo()}</button>
  {:else}
    {#if list.length === 0}
      <p class="estado">{m.atalhos_vazio()}</p>
    {/if}
    {@render rows('global', list)}

    {#if missingNatives.length}
      <div class="repor">
        <span>{m.atalhos_repor()}</span>
        {#each missingNatives as a (a)}
          <button class="chip" onclick={() => restoreNative(a)}>+ {INTERNAL_LABEL[a]()}</button>
        {/each}
      </div>
    {/if}

    {#if formScope === 'global'}
      {@render form()}
    {:else}
      <button class="btn" onclick={() => openNew('global')}>{m.atalhos_add()}</button>
    {/if}

    <div class="rodape">
      <button class="btn" onclick={() => void restoreDefaults()} disabled={saving}
              title={m.atalhos_restaurar_ajuda()}>{m.atalhos_restaurar()}</button>
      <!-- Importar grava direto no servidor: com edição pendente, salvar depois sobrescreveria o que veio. -->
      {#if !dirty}<ShortcutTransfer {serverId} onDone={() => void load()} />{/if}
      <span class="feedback">
        {#if saveError}<span class="erro">{saveError}</span>
        {:else if saved}{m.atalhos_salvo()}{/if}
      </span>
      <button class="btn primario" onclick={() => void save()} disabled={!dirty || saving}>
        {m.atalhos_salvar()}
      </button>
    </div>
  {/if}

  {#if projectSession}
    <section class="projeto" aria-labelledby="atalhos-projeto-titulo">
      <h3 id="atalhos-projeto-titulo" class="titulo">{projName ? m.atalhos_projeto_titulo({ nome: projName }) : m.atalhos_projeto_titulo_sem_nome()}</h3>
      <p class="sub">{m.atalhos_projeto_sub()}</p>
      {#if projLoading && !projName}
        <p class="estado">{m.comum_carregando()}</p>
      {:else if projLoadError}
        <p class="estado erro">{projLoadError}</p>
        <button class="btn" onclick={() => void loadProject()}>{m.config_server_tentar_de_novo()}</button>
      {:else}
        {#if proj.length === 0}
          <p class="estado">{m.atalhos_projeto_vazio()}</p>
        {:else}
          {@render rows('project', proj)}
        {/if}
        {#if formScope === 'project'}
          {@render form()}
        {:else}
          <button class="btn" onclick={() => openNew('project')}>{m.atalhos_add()}</button>
        {/if}
        <div class="rodape">
          <span class="feedback">
            {#if projSaveError}<span class="erro">{projSaveError}</span>
            {:else if projSaved}{m.atalhos_salvo()}{/if}
          </span>
          <button class="btn primario" onclick={() => void saveProject()} disabled={!projDirty || projSaving}>
            {m.atalhos_salvar()}
          </button>
        </div>
      {/if}
    </section>
  {/if}
</div>

{#snippet rows(sc: Scope, items: Shortcut[])}
  <ul class="linhas">
    {#each items as s, i (s.id)}
      <li class="linha" class:arrastando={dragScope === sc && dragIdx === i} draggable="true"
          ondragstart={(e) => dragStart(e, sc, i)} ondragover={(e) => dragOver(e, sc, i)}
          ondragend={dragEnd}>
        <span class="alca" aria-hidden="true">⠿</span>
        <span class="ico"><ShortcutIcon icon={s.type === 'internal' ? INTERNAL_ICON[s.action] : s.icon} /></span>
        <span class="txt">
          <span class="rotulo">{s.type === 'internal' ? INTERNAL_LABEL[s.action]() : s.label}</span>
          {#if s.type !== 'internal'}
            <span class="detalhe">{s.type === 'shell' ? s.command : s.text}</span>
          {/if}
          {#if s.type === 'shell' && s.pasta}
            <span class="detalhe">{m.atalhos_pasta_linha({ pasta: s.pasta })}</span>
          {/if}
        </span>
        {#if s.type === 'send_text'}
          <span class="marca">{m.atalhos_marca_sessao_texto()}</span>
        {:else if s.type === 'shell'}
          <span class="marca" class:hangar={s.runs_in === 'hangar'}>{s.runs_in === 'hangar'
            ? m.atalhos_marca_hangar() : m.atalhos_marca_sessao_comando()}</span>
        {/if}
        <span class="acoes">
          {#if s.type !== 'internal'}
            <button class="mini" onclick={() => openEdit(sc, i)} aria-label={m.atalhos_editar()}>✎</button>
          {/if}
          <button class="mini" onclick={() => move(sc, i, -1)} disabled={i === 0} aria-label={m.atalhos_subir()}>↑</button>
          <button class="mini" onclick={() => move(sc, i, 1)} disabled={i === items.length - 1} aria-label={m.atalhos_descer()}>↓</button>
          <button class="mini" onclick={() => remove(sc, i)} aria-label={m.atalhos_remover()}>✕</button>
        </span>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet form()}
      <div class="form">
        <label class="campo">
          <span>{m.atalhos_tipo()}</span>
          <select bind:value={fType} disabled={editingIdx !== null}>
            <option value="send_text">{m.atalhos_tipo_send()}</option>
            <option value="shell">{m.atalhos_tipo_shell()}</option>
          </select>
        </label>
        <label class="campo">
          <span>{m.atalhos_rotulo()}</span>
          <input type="text" bind:value={fLabel} maxlength="24" />
        </label>
        <div class="campo">
          <span>{m.atalhos_icone()}</span>
          <div class="glifos" role="radiogroup" aria-label={m.atalhos_icone()}>
            {#each Object.keys(GLYPHS) as g (g)}
              <button type="button" class="glifo" class:sel={!fEmoji.trim() && fGlyph === g}
                      role="radio" aria-checked={!fEmoji.trim() && fGlyph === g} aria-label={g}
                      onclick={() => { fGlyph = g; fEmoji = ''; }}>
                <ShortcutIcon icon={`glifo:${g}`} />
              </button>
            {/each}
            <input class="emoji" type="text" bind:value={fEmoji} maxlength="4"
                   placeholder={m.atalhos_emoji_dica()} aria-label={m.atalhos_emoji_dica()} />
          </div>
        </div>
        <label class="campo">
          <span>{fType === 'shell' ? m.atalhos_comando() : m.atalhos_texto()}</span>
          <input type="text" bind:value={fContent} list={fType === 'send_text' ? 'atalho-skills' : undefined}
                 placeholder={fType === 'shell' ? m.atalhos_comando_dica() : m.atalhos_texto_dica()} />
          {#if fType === 'send_text'}
            <datalist id="atalho-skills">
              {#each suggestions as sk (sk)}<option value={sk}></option>{/each}
            </datalist>
          {/if}
        </label>
        {#if fType === 'shell' && formScope === 'project'}
          <label class="campo">
            <span>{m.atalhos_pasta()}</span>
            <input type="text" bind:value={fPasta} placeholder={m.atalhos_pasta_placeholder()} />
            <small class="ajuda">{m.atalhos_pasta_dica()}</small>
          </label>
        {/if}
        {#if fType === 'shell'}
          <fieldset class="onde">
            <legend>{m.atalhos_onde()}</legend>
            <div class="onde-opcoes" role="radiogroup" aria-label={m.atalhos_onde()}>
              <button type="button" class="onde-card" class:sel={fRunsIn === 'session'} role="radio"
                      aria-checked={fRunsIn === 'session'} onclick={() => (fRunsIn = 'session')}>
                <span class="onde-titulo"><span class="onde-radio" aria-hidden="true"></span>{m.atalhos_onde_sessao()}</span>
                <span class="onde-ajuda">{m.atalhos_onde_sessao_ajuda()}</span>
                <span class="onde-uso">{m.atalhos_onde_sessao_uso()}</span>
              </button>
              <button type="button" class="onde-card" class:sel={fRunsIn === 'hangar'} role="radio"
                      aria-checked={fRunsIn === 'hangar'} onclick={() => (fRunsIn = 'hangar')}>
                <span class="onde-titulo"><span class="onde-radio" aria-hidden="true"></span>{m.atalhos_onde_hangar()}</span>
                <span class="onde-ajuda">{m.atalhos_onde_hangar_ajuda()}</span>
                <span class="onde-uso">{m.atalhos_onde_hangar_uso()}</span>
              </button>
            </div>
            {#if fRunsIn === 'hangar'}
              <div class="onde-bloco">
                <span class="onde-bloco-titulo">{m.atalhos_onde_clique_titulo()}</span>
                <span class="onde-bloco-texto">→ {m.atalhos_onde_clique()}</span>
                <label class="liga">
                  <input type="checkbox" bind:checked={fHome} />
                  <span>{m.atalhos_onde_home({ home: '~' })}</span>
                </label>
              </div>
            {/if}
          </fieldset>
          <label class="liga">
            <input type="checkbox" bind:checked={fAsk} />
            <span>{m.atalhos_perguntas()}</span>
            <small>{m.atalhos_perguntas_ajuda()}</small>
          </label>
        {/if}
        {#if fType === 'send_text'}
          <label class="liga">
            <input type="checkbox" bind:checked={fSendDirect} />
            <span>{m.atalhos_send_direct()}</span>
            <small>{m.atalhos_send_direct_ajuda()}</small>
          </label>
        {/if}
        <label class="liga">
          <input type="checkbox" bind:checked={fConfirm} />
          <span>{m.atalhos_confirm()}</span>
        </label>
        <div class="form-acoes">
          <button class="btn" onclick={() => (formScope = null)}>{m.comum_cancelar()}</button>
          <button class="btn primario" onclick={submitForm} disabled={!formValid}>{m.comum_confirmar()}</button>
        </div>
      </div>
{/snippet}

<style>
  /* Container query, não media query: quem aperta a linha é a largura do PAINEL (regra do repo). */
  .at { container-type: inline-size; display: flex; flex-direction: column; gap: var(--space-3); }
  .sub { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .estado { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .erro { color: var(--danger, #e5484d); }

  .linhas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .linha {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-2); border-radius: var(--radius-md);
    background: var(--surface-inset);
  }
  .linha.arrastando { opacity: 0.45; }
  .alca { flex-shrink: 0; color: var(--text-muted); cursor: grab; font-size: var(--text-sm); user-select: none; }
  .ico {
    width: 32px; height: 32px; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm); background: var(--surface-raised);
    color: var(--text-secondary);
  }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .rotulo { font-size: var(--text-sm); font-weight: 600; color: var(--text-primary); }
  .detalhe {
    font-size: var(--text-xs); color: var(--text-muted); font-family: var(--font-mono);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .acoes { display: flex; gap: 2px; flex-shrink: 0; }
  .mini {
    min-width: 30px; min-height: 30px; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-secondary); font-size: var(--text-sm);
  }
  .mini:hover { background: var(--surface-raised); color: var(--text-primary); }
  .mini:disabled { opacity: 0.35; }

  .repor { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); }
  .chip {
    font-size: var(--text-xs); padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--surface-raised); color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .chip:hover { color: var(--text-primary); }

  .form {
    display: flex; flex-direction: column; gap: var(--space-3);
    padding: var(--space-3); border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle); background: var(--surface-inset);
  }
  .campo { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  .campo input[type='text'], .campo select {
    padding: 8px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle); background: var(--surface-raised);
    color: var(--text-primary); font-size: var(--text-sm);
  }
  .glifos { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; }
  .glifo {
    width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary);
  }
  .glifo:hover { background: var(--surface-raised); }
  .glifo.sel { background: var(--accent-dim); color: var(--accent); }
  .emoji { width: 96px; padding: 6px 8px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle); background: var(--surface-raised);
    color: var(--text-primary); font-size: var(--text-sm); }
  .liga { display: grid; grid-template-columns: auto 1fr; gap: 2px var(--space-2); align-items: center; font-size: var(--text-sm); color: var(--text-primary); }
  .liga small { grid-column: 2; color: var(--text-muted); font-size: var(--text-xs); }
  .form-acoes { display: flex; justify-content: flex-end; gap: var(--space-2); }
  .ajuda { color: var(--text-muted); font-size: var(--text-xs); }

  .marca { flex-shrink: 0; font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-full);
    background: var(--surface-raised); color: var(--text-secondary); }
  .marca.hangar { background: var(--accent-dim); color: var(--text-primary); }

  .onde { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .onde legend { padding: 0; margin-bottom: var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); }
  .onde-opcoes { display: grid; grid-template-columns: 1fr; gap: var(--space-2); }
  @container (min-width: 480px) { .onde-opcoes { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .onde-card {
    display: flex; flex-direction: column; gap: 6px; padding: var(--space-3); text-align: left;
    border: 1px solid var(--border-default); border-radius: var(--radius-md); background: transparent;
    color: var(--text-secondary); cursor: pointer;
  }
  .onde-card.sel { border-color: var(--accent); background: var(--accent-dim); }
  .onde-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .onde-titulo { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text-primary); }
  .onde-radio { width: 14px; height: 14px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--text-muted); }
  .onde-card.sel .onde-radio { border: 4px solid var(--accent); background: #fff; }
  .onde-ajuda { font-size: var(--text-sm); line-height: 1.45; }
  .onde-uso { font-size: var(--text-xs); color: var(--text-muted); line-height: 1.45; }
  .onde-bloco {
    display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3);
    border-radius: var(--radius-md); background: var(--surface-inset); border: 1px solid var(--border-subtle);
  }
  .onde-bloco-titulo { font-size: var(--text-sm); font-weight: 500; color: var(--text-primary); }
  .onde-bloco-texto { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.45; }

  .projeto {
    display: flex; flex-direction: column; gap: var(--space-3);
    margin-top: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle);
  }
  .titulo { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }

  .btn {
    align-self: flex-start;
    padding: 7px 14px; border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 600;
    background: var(--surface-raised); color: var(--text-primary);
    border: 1px solid var(--border-subtle);
  }
  .btn:hover { background: var(--bg-hover); }
  .btn:disabled { opacity: 0.45; }
  .btn.primario { background: var(--accent); color: #fff; border-color: transparent; }

  .rodape { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
  .feedback { flex: 1; text-align: right; font-size: var(--text-xs); color: var(--success, #30a46c); }
  .feedback .erro { color: var(--danger, #e5484d); }

  @container (max-width: 480px) {
    .acoes { flex-direction: column; }
    .rodape { flex-wrap: wrap; }
  }
</style>
