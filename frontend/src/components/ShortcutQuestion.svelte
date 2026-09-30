<script lang="ts">
  // Cartão da pergunta de um terminal de atalho (sessão ou No Hangar). Montado UMA vez no App; quem
  // abre (chip, tile, Chat) chama openQuestion(). Fica aberto entre uma pergunta e a seguinte do
  // mesmo terminal e guarda as respostas desta rodada.
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { answerHangarTerminal, answerShortcutTerminal } from '@hangar/core';
  import { listServers } from '../lib/auth';
  import { closeQuestion, liveTerminals, requestHangarTab } from '../lib/hangarTerminals.svelte';
  import { focusShortcutTerminal } from '../lib/shortcutTerminals.svelte';
  import * as m from '../paraglide/messages';

  interface Props { onOpenTerminal?: (serverId: string, owner: string, id: string) => void }
  let { onOpenTerminal }: Props = $props();

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
  let sentSig = '';

  $effect(() => {
    if (open?.id !== lastId) { lastId = open?.id ?? ''; answered = []; hide = false; sentSig = ''; }
    const q = term?.question;
    const sig = q ? `${q.text}|${q.default}` : '';
    if (!q) { sentSig = ''; return; }
    if (sig === sentSig) return;
    if (sig !== lastSig) { lastSig = sig; answer = q.default; waitingSince = null; }
  });

  const pending = $derived(!!term?.question && `${term.question.text}|${term.question.default}` !== sentSig);

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
    try {
      if (open.owner) await answerShortcutTerminal(srv, open.owner, term.id, answer);
      else await answerHangarTerminal(srv, term.id, answer);
      answered = [...answered, { text: term.question.text, value: answer, hidden: hide }];
      waitingSince = Date.now();
      sentSig = `${term.question.text}|${term.question.default}`;
      lastSig = '';
    } catch (e) {
      error = m.hangar_erro({ msg: e instanceof Error ? e.message : String(e) });
    } finally {
      sending = false;
    }
  }

  function openTerminal() {
    if (!open) return;
    if (open.owner) focusShortcutTerminal(`${open.serverId}::${open.owner}`, open.id);
    else requestHangarTab(open.serverId, open.id);
    onOpenTerminal?.(open.serverId, open.owner, open.id);
    closeQuestion();
  }
</script>

{#if open && srv}
  <ConfirmDialog role="dialog" wide
    title={m.pergunta_titulo({ rotulo: term?.label ?? '' })}
    aria={m.pergunta_titulo({ rotulo: term?.label ?? '' })}
    onClose={closeQuestion}
    actions={[
      { label: m.pergunta_abrir_terminal(), onClick: openTerminal },
      { label: m.pergunta_enviar(), kind: 'primary', disabled: sending || !pending, onClick: send },
    ]}>
    {#if !open.owner}<span class="pq-mark">{m.pergunta_marca_hangar()}</span>{/if}
    {#each answered as a, i (i)}
      <div class="pq-done">
        <span class="pq-ok" aria-hidden="true">✓</span>
        <span class="pq-done-text">{a.text}</span>
        <span class="pq-done-value">{a.hidden ? '••••' : a.value || '⏎'}</span>
      </div>
    {/each}
    {#if term?.question && pending}
      <label class="pq-field">
        <span class="pq-text">{term.question.text}</span>
        <input type={hide ? 'password' : 'text'} bind:value={answer} autocomplete="off"
               onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }} />
        {#if term.question.default}<small>{m.pergunta_padrao()}</small>{/if}
      </label>
      <label class="pq-toggle"><input type="checkbox" bind:checked={hide} /> {m.pergunta_esconder()}</label>
      <div class="pq-screen">
        <span class="pq-screen-title">{m.pergunta_tela()}</span>
        {#each term.question.screen as line, i (i)}<div class="pq-screen-line">{line}</div>{/each}
      </div>
    {:else}
      <p class="pq-status" role="status">{waitingSince !== null ? m.pergunta_aguardando() : m.comum_carregando()}</p>
    {/if}
    {#if error}<p class="pq-error" role="alert">{error}</p>{/if}
  </ConfirmDialog>
{/if}

<style>
  .pq-mark { align-self: flex-end; font-size: 11px; letter-spacing: 0.05em; color: var(--text-muted); }
  .pq-done { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--success) 8%, transparent); }
  .pq-ok { color: var(--success); font-weight: 700; }
  .pq-done-text { flex: 1; color: var(--text-secondary); font-size: var(--text-sm); }
  .pq-done-value { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-primary); }
  .pq-field { display: flex; flex-direction: column; gap: 6px; }
  .pq-text { font-weight: 500; color: var(--text-primary); }
  .pq-field input { height: 40px; padding: 0 12px; border-radius: var(--radius-md);
    border: 1px solid var(--warning); background: var(--surface-inset); color: var(--text-primary); font-family: var(--font-mono); }
  .pq-field small, .pq-status { color: var(--text-muted); font-size: var(--text-sm); }
  .pq-toggle { display: flex; gap: 8px; align-items: center; font-size: var(--text-sm); color: var(--text-secondary); }
  .pq-screen { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: var(--radius-md);
    background: var(--surface-inset); border: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: var(--text-xs); }
  .pq-screen-title { font-family: var(--font-ui); font-size: 11px; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 4px; }
  .pq-screen-line { color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
  .pq-screen-line:last-child { color: var(--text-primary); }
  .pq-error { color: var(--error); font-size: var(--text-sm); margin: 0; }
</style>
