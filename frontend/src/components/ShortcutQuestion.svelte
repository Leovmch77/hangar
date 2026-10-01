<script lang="ts">
  // Cartão da pergunta de um terminal de atalho (sessão ou No Hangar). Montado UMA vez no App; quem
  // abre (chip, tile, Chat) chama openQuestion(). Fica aberto entre uma pergunta e a seguinte do
  // mesmo terminal e guarda as respostas desta rodada.
  import ModalDialog from './ModalDialog.svelte';
  import { answerHangarTerminal, answerShortcutTerminal, type ShortcutQuestion } from '@hangar/core';
  import { listServers } from '../lib/auth';
  import { closeQuestion, liveTerminals, requestHangarTab } from '../lib/hangarTerminals.svelte';
  import { focusShortcutTerminal } from '../lib/shortcutTerminals.svelte';
  import * as m from '../paraglide/messages';

  interface Props { onOpenTerminal?: (serverId: string, owner: string, id: string) => void }
  let { onOpenTerminal }: Props = $props();

  // A tela entra na assinatura: a mesma pergunta repetida (senha errada) tem uma linha nova acima dela.
  const sigOf = (q: ShortcutQuestion) => `${q.text}|${q.default}|${q.screen.join('\n')}`;

  const open = $derived(liveTerminals.question);
  const srv = $derived(open ? listServers().find((s) => s.id === open.serverId) ?? null : null);
  const term = $derived(open ? (liveTerminals.byServer[open.serverId] ?? []).find((t) => t.id === open.id) ?? null : null);

  let answer = $state('');
  let hide = $state(false);
  let sending = $state(false);
  let waitingSince = $state<number | null>(null);
  let error = $state('');
  let answered = $state<{ text: string; value: string; hidden: boolean }[]>([]);
  let lastSig = '';
  let lastId = '';
  // Assinatura da pergunta JÁ respondida: a lista só atualiza ~1,5 s depois do envio, e até lá a
  // pergunta velha não pode voltar como "nova" (o Enter seguinte iria pra pergunta errada).
  // É $state porque o `pending` abaixo lê: sem isso a pergunta velha seguia editável após Enviar.
  let sentSig = $state('');
  let field = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (open?.id !== lastId) { lastId = open?.id ?? ''; answered = []; hide = false; sentSig = ''; }
    const q = term?.question;
    const sig = q ? sigOf(q) : '';
    if (!q) { sentSig = ''; return; }
    if (sig === sentSig) return;
    if (sig !== lastSig) { lastSig = sig; answer = q.default; waitingSince = null; }
  });

  const pending = $derived(!!term?.question && sigOf(term.question) !== sentSig);

  // Depois de responder, espera a próxima pergunta por 5 s; sem ela, fecha.
  $effect(() => {
    if (waitingSince === null || term?.question) return;
    const t = setTimeout(() => { if (!term?.question) closeQuestion(); }, 5000);
    return () => clearTimeout(t);
  });

  async function send() {
    if (!srv || !term?.question || !open || sending || !pending) return;
    sending = true;
    error = '';
    // Fixados antes do await: a pergunta seguinte pode chegar enquanto a resposta viaja.
    const q = term.question, val = answer, hidden = hide;
    try {
      if (open.owner) await answerShortcutTerminal(srv, open.owner, term.id, val);
      else await answerHangarTerminal(srv, term.id, val);
      answered = [...answered, { text: q.text, value: val, hidden }];
      waitingSince = Date.now();
      sentSig = sigOf(q);
      lastSig = '';
    } catch (e) {
      error = m.hangar_erro({ msg: e instanceof Error ? e.message : String(e) });
    } finally {
      sending = false;
    }
  }

  // O prompt do script traz o exemplo entre parênteses; a linha de resposta dada fica só com o nome.
  const shortText = (t: string) => t.replace(/\s*\([^)]*\)\s*:?\s*$/, '').replace(/\s*:\s*$/, '');

  function openTerminal() {
    if (!open) return;
    if (open.owner) focusShortcutTerminal(`${open.serverId}::${open.owner}`, open.id);
    else requestHangarTab(open.serverId, open.id);
    onOpenTerminal?.(open.serverId, open.owner, open.id);
    closeQuestion();
  }
</script>

{#if open && srv}
  {@const title = m.pergunta_titulo({ rotulo: term?.label ?? '' })}
  <ModalDialog open={true} ariaLabel={title} onClose={closeQuestion} initialFocus={field} className="pq-shell">
    <div class="pq-card">
      <div class="pq-head">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></svg>
        <p class="pq-title">{title}</p>
        {#if !open.owner}<span class="pq-mark">{m.pergunta_marca_hangar()}</span>{/if}
      </div>
      {#each answered as a, i (i)}
        <div class="pq-done">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
          <span class="pq-done-text" title={a.text}>{shortText(a.text)}</span>
          <span class="pq-done-value">{a.hidden ? '••••' : a.value || '⏎'}</span>
        </div>
      {/each}
      {#if term?.question && pending}
        <label class="pq-field">
          <span class="pq-text">{term.question.text}</span>
          <input type={hide ? 'password' : 'text'} bind:value={answer} bind:this={field} autocomplete="off"
                 onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }} />
          {#if term.question.default}<small>{m.pergunta_padrao()}</small>{/if}
        </label>
      {:else}
        <p class="pq-status" role="status">{waitingSince !== null ? m.pergunta_aguardando() : m.comum_carregando()}</p>
      {/if}
      {#if error}<p class="pq-error" role="alert">{error}</p>{/if}
      <div class="pq-actions">
        {#if term?.question && pending}
          <label class="pq-toggle"><input type="checkbox" bind:checked={hide} /> {m.pergunta_esconder()}</label>
        {/if}
        <span class="pq-grow"></span>
        <button type="button" class="pq-btn" onclick={openTerminal}>{m.pergunta_abrir_terminal()}</button>
        <button type="button" class="pq-btn pq-send" disabled={sending || !pending} onclick={send}>{m.pergunta_enviar()}</button>
      </div>
    </div>
    {#if term?.question && pending}
      {@const lines = term.question.screen}
      <div class="pq-screen">
        <span class="pq-screen-title">{m.pergunta_tela()}</span>
        <div>
        {#each lines as line, i (i)}
          {@const last = i === lines.length - 1}
          <div class="pq-screen-line" class:last>{line}{#if last}<span class="pq-cursor" aria-hidden="true"></span>{:else if answered.some((a) => a.value === '' && line.includes(a.text))}<span class="pq-enter"> ⏎</span>{/if}</div>
        {/each}
        </div>
      </div>
    {/if}
  </ModalDialog>
{/if}

<style>
  /* O ModalDialog vira só o palco: o cartão e a caixa da tela são dois blocos, então o material
     de vidro dele sai (vence as regras dele, inclusive a do modo liquid). */
  :global(:root .modal-dialog.pq-shell), :global(:root[data-liquid] .modal-dialog.pq-shell) {
    width: min(512px, 100%); display: flex; flex-direction: column; gap: 14px;
    background: transparent; box-shadow: none; border: 0; border-radius: 0; overflow: visible;
  }
  :global(.modal-dialog.pq-shell::before) { display: none; }
  .pq-card {
    display: flex; flex-direction: column; gap: 16px; padding: 20px; border-radius: 14px;
    background: var(--bg-surface); border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  }
  .pq-head { display: flex; align-items: center; gap: 10px; }
  .pq-head svg { flex-shrink: 0; }
  .pq-title { flex: 1; margin: 0; font-size: 15px; font-weight: 600; color: var(--text-primary); }
  .pq-mark { font-size: var(--text-2xs); letter-spacing: 0.05em; color: var(--text-muted); }
  .pq-done { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--success) 7%, transparent); }
  .pq-done svg { flex-shrink: 0; }
  .pq-done-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 13px; color: var(--text-secondary); }
  .pq-done-value { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-primary); }
  .pq-field { display: flex; flex-direction: column; gap: 8px; }
  .pq-text { font-size: var(--text-sm); font-weight: 500; color: var(--text-primary); }
  .pq-field input { height: 42px; padding: 0 12px; border-radius: var(--radius-xs); outline: none;
    border: 1px solid var(--warning); background: var(--surface-inset); color: var(--text-primary);
    font-family: var(--font-mono); font-size: 13px; }
  .pq-field input:focus-visible { border-color: var(--warning-text); }
  .pq-field small, .pq-status { margin: 0; color: var(--text-muted); font-size: var(--text-xs); }
  .pq-actions { display: flex; align-items: center; gap: 8px; }
  .pq-grow { flex: 1; }
  .pq-toggle { display: flex; gap: 8px; align-items: center; font-size: var(--text-xs); color: var(--text-secondary); }
  .pq-toggle input { width: 15px; height: 15px; margin: 0; accent-color: var(--warning); }
  .pq-btn { height: 36px; min-height: 0; min-width: 0; padding: 0 14px; border-radius: var(--radius-xs);
    border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); font-size: 13px; }
  .pq-btn:hover:not(:disabled) { background: var(--bg-hover); }
  .pq-send { padding: 0 16px; border: 0; font-weight: 500; color: #fff;
    background: color-mix(in srgb, var(--warning) 75%, black); }
  .pq-send:hover:not(:disabled) { background: color-mix(in srgb, var(--warning) 75%, black); filter: brightness(1.08); }
  .pq-send:disabled { opacity: 0.5; }
  .pq-screen { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 10px;
    background: var(--surface-inset); border: 1px solid var(--border-subtle);
    font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.7; }
  .pq-screen-title { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--text-muted); }
  .pq-screen-line { color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: break-word; }
  .pq-screen-line.last { color: var(--text-primary); }
  .pq-enter { color: var(--text-primary); }
  .pq-cursor { display: inline-block; width: 7px; height: 14px; margin-left: 4px; vertical-align: middle; background: var(--warning); }
  .pq-error { color: var(--error); font-size: var(--text-sm); margin: 0; }
</style>
