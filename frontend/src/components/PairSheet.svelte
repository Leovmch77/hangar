<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';
  import { desktop } from '../lib/desktop.svelte';
  import { renderMarkdown } from '../lib/markdown';
  import { getSessions, pairSession, unpairSession, getHistory, getPairContract } from '@hangar/core';
  import { fullPairsByAlias, grantFull, pairExternals, pairHeaderLabel, groupGlobal, canPair, identityOf } from '@hangar/core';
  import { sessionServerFor, useSessionServer } from '../lib/sessionServer';
  import { mensagemRecusa } from '../lib/arrastarGrupo.svelte';
  import { formataErro } from '@hangar/core';
  import { rotuloEstado, stateColors, parsePeerMessage, relativeTime, encodeCompareIds } from '@hangar/core';
  import { getActiveId } from '../lib/auth';
  import type { AggSession, SessionInfo, State } from '@hangar/core';
  import { sessionsStore } from '../lib/sessionsStore.svelte';
  import * as m from '../paraglide/messages';
  import GroupGlyph from './icons/GroupGlyph.svelte';

  interface Props {
    open: boolean;
    sessionName: string;              // sessão atual (um membro do grupo)
    pairPeers: string[] | null;       // os OUTROS membros do grupo, ou null
    onClose: () => void;
    onChanged: () => void;            // grupo mudou -> pai recarrega a lista (badge/chip)
    onOpenSplit?: (peer: string) => void; // desktop: abre o chat do membro lado a lado (split view)
    onOpenPeerChat?: (peer: string) => void; // abre o chat do membro num MODAL (as duas views)
    serverId?: string;                // aberto pela lista: a máquina da sessão, não a do chat
  }
  let { open, sessionName, pairPeers, onClose, onChanged, onOpenSplit, onOpenPeerChat, serverId }: Props = $props();
  const ctxServer = useSessionServer();
  const sessionServer = () => (serverId ? sessionServerFor(serverId)() : ctxServer());
  const sid = $derived(sessionServer()?.id ?? getActiveId() ?? '');

  const peers = $derived(pairPeers ?? []);
  // Chave PRIMITIVA: a prop pairPeers é um array novo por referência a cada poll de 5s do pai —
  // o $effect de (re)carga dependendo do array resetava seleção/task/feed com o sheet ABERTO.
  const peersKey = $derived(peers.join(','));

  let sessions = $state<SessionInfo[]>([]);
  let self = $state<SessionInfo | null>(null);
  // Par externo no grupo: membros locais (eu + os da lista), cabeçalho e o que cada par libera.
  const locais = $derived([...(self ? [self] : []), ...sessions.filter((s) => peers.includes(s.name))]);
  const temFora = $derived(locais.some((s) => pairExternals(s).length > 0));
  const parCabecalho = $derived(temFora ? pairHeaderLabel(sessionName, locais) : '');
  // Quem entra agora fica em "ver e recado" para o par com acesso completo, até marcar liberar.
  const liberacoes = $derived(fullPairsByAlias(locais));
  let liberar = $state<string[]>([]);
  // Esta sessão é a ponta de algum par: sair do grupo desfaz o par para todos.
  const pontaDe = $derived(sessionsStore.anchoredPairs(sessionServer()?.id ?? getActiveId() ?? '', sessionName));
  let picked = $state<string[]>([]);   // MULTI-select: chaves "<servidor>:<nome>", de qualquer máquina
  let task = $state('');

  function togglePick(key: string) {
    picked = picked.includes(key) ? picked.filter((n) => n !== key) : [...picked, key];
  }

  // Grupo entre máquinas: membros e candidatas saem das listas já abertas (uma SSE por servidor).
  const identities = $derived(sessionsStore.identities);
  const selfRow = $derived(sessionsStore.rows.find((r) => !r.outside && r.serverId === sid && r.name === sessionName) ?? null);
  const grupo = $derived(selfRow ? groupGlobal(sessionsStore.rows, identities).find((g) =>
    g.members.some((x) => x.kind === 'here' && x.server === sid && x.name === sessionName)) ?? null : null);
  const machineLabel = (id: string) => sessionsStore.servers.find((x) => x.id === id)?.label ?? id;
  // Par `srv::` com identificador ainda em leitura: a lista do grupo espera em vez de chutar.
  const lendoIdentidades = $derived(peers.some((p) => p.includes('::'))
    && sessionsStore.servers.some((x) => !x.invite && !x.ephemeral && !identities.has(x.id)));
  type Membro = { key: string; name: string; server: string | null; machine: string | null; note: string | null };
  const membros = $derived.by((): Membro[] => {
    if (!grupo || lendoIdentidades) return peers.map((p) => ({ key: p, name: p, server: sid, machine: null, note: null }));
    return grupo.members.flatMap((x): Membro[] => {
      if (x.kind === 'here') {
        if (x.server === sid && x.name === sessionName) return [];
        return [{ key: `${x.server}:${x.name}`, name: x.name, server: x.server, machine: x.server === sid ? null : machineLabel(x.server), note: null }];
      }
      if (x.kind === 'missing') {
        return [{ key: `${x.server_id}::${x.name}`, name: x.name, server: null, machine: x.server_id,
          note: m.grupo_membro_maquina_desconectada({ maquina: x.server_id }) }];
      }
      return [{ key: `${x.alias}::${x.session}`, name: `${x.alias}::${x.session}`, server: null, machine: null, note: null }];
    });
  });
  const keyOf = (s: { serverId: string; name: string }) => `${s.serverId}:${s.name}`;
  const nameOf = (key: string) => key.slice(key.indexOf(':') + 1);
  const serverOf = (key: string) => key.slice(0, key.indexOf(':'));
  let busy = $state(false);
  let error = $state<string | null>(null);
  let adding = $state(false);   // grupo existente: mostrando o picker de "adicionar membro"

  // Timeline "conversa do grupo": recados [de: X] trocados entre os membros, garimpados dos
  // históricos de TODOS (user_msg com prefixo peer cujo remetente é outro membro) e fundidos por ts.
  type PeerMsg = { from: string; to: string; text: string; ts: number };
  let feed = $state<PeerMsg[]>([]);
  let feedLoading = $state(false);
  let feedError = $state<string | null>(null); // membros cujo histórico falhou (≠ conversa vazia)
  // Contrato compartilhado (markdown que os membros editam via fs): renderizado, read-only.
  let contract = $state<{ path: string; content: string } | null>(null);
  // Separado de `contract = null`: "não consegui buscar" não pode se passar por "ainda não há
  // contrato" — são a mesma tela com causas opostas, e a segunda é estado normal do grupo novo.
  let contractError = $state<string | null>(null);

  // epoch: o BottomSheet mantem o componente MONTADO entre aberturas — abrir/fechar/reabrir rapido
  // (ou o grupo mudar entre aberturas) deixava resposta ANTIGA resolver depois e sobrescrever
  // feed/contrato/lista com dado stale.
  let epoch = 0;

  async function loadFeed(members: string[], my: number) {
    feedLoading = true;
    try {
      const all = [sessionName, ...members];
      // Falha de fetch ≠ conversa vazia: sem distinguir, o histórico de um membro sumia do feed
      // calado ("nenhuma troca" com mensagens existindo).
      const results = await Promise.all(all.map((n) =>
        getHistory(n, undefined, undefined, undefined, sessionServer()).then((h) => ({ ok: true as const, h })).catch(() => ({ ok: false as const, h: [] }))));
      if (my !== epoch) return;
      const failed = all.filter((_, i) => !results[i].ok);
      feedError = failed.length ? m.par_sem_historico({ nomes: failed.join(', ') }) : null;
      const names = new Set(all);
      const msgs: PeerMsg[] = [];
      results.forEach(({ h: evs }, i) => {
        const owner = all[i];
        for (const e of evs) {
          if (e.kind !== 'user_msg' || !e.text) continue;
          const p = parsePeerMessage(e.text);
          // Só recados vindos de OUTRO membro do grupo (ignora hangar/terceiros).
          if (p && p.from !== owner && names.has(p.from)) {
            msgs.push({ from: p.from, to: owner, text: p.text, ts: e.ts ?? 0 });
          }
        }
      });
      feed = msgs.sort((a, b) => a.ts - b.ts).slice(-40); // cauda; histórico completo vive nos chats
    } finally {
      if (my === epoch) feedLoading = false;
    }
  }

  $effect(() => {
    if (!open) return;
    // Depende de open + peersKey (primitivos) — NUNCA do array peers: re-rodar por identidade
    // (poll de 5s) apagava seleção/task e refazia os fetches com o sheet aberto.
    // Membro de outra máquina ou de fora não tem histórico neste servidor.
    const members = peersKey ? peersKey.split(',').filter((p) => !p.includes('::')) : [];
    const my = ++epoch;
    sessionsStore.requestIdentities();
    picked = [];
    task = '';
    busy = false;
    error = null;
    adding = false;
    feed = [];
    feedError = null;
    contract = null;
    contractError = null;
    liberar = [];
    if (peersKey) {
      loadFeed(members, my);
      getPairContract(sessionName, sessionServer())
        .then((c) => { if (my === epoch) { contract = { path: c.path, content: c.content }; } })
        .catch((e) => {
          if (my !== epoch) return;
          contract = null;
          contractError = e instanceof Error && e.message ? e.message : m.par_contrato_falhou();
        });
    }
    getSessions(sessionServer())
      .then((all) => {
        if (my !== epoch) return;
        self = all.find((s) => s.name === sessionName) ?? null;
        sessions = all.filter((s) => s.name !== sessionName && s.state !== 'dead');
      })
      .catch(() => { if (my === epoch) error = m.forward_nao_listou(); });
  });

  // Candidatas a ENTRAR no grupo: vivas, de todas as máquinas, fora do grupo atual. Recusa por
  // identificador ou dona aparece com o motivo, sem deixar marcar.
  type Candidata = AggSession & { recusa: string | null };
  const candidates = $derived.by((): Candidata[] => {
    const eu = selfRow ?? (self ? { ...self, serverId: sid } as AggSession : null);
    const fonte: AggSession[] = selfRow ? sessionsStore.rows
      : sessions.map((s) => ({ ...s, serverId: sid }) as AggSession);
    const noGrupo = new Set(membros.map((x) => x.key));
    return fonte
      .filter((s) => !s.outside && !s.serverInvite && s.state !== 'dead' && !(s.serverId === sid && s.name === sessionName)
        && !noGrupo.has(keyOf(s)) && !(s.serverId === sid && peers.includes(s.name)))
      .flatMap((s) => {
        const r = eu ? canPair(eu, s, identities) : { ok: true as const };
        if (!r.ok && (r.reason === 'same_group' || r.reason === 'same' || r.reason === 'dead')) return [];
        return [{ ...s, recusa: r.ok ? null : mensagemRecusa(r.reason) }];
      })
      .sort((a, b) => Number(a.serverId !== sid) - Number(b.serverId !== sid)
        || machineLabel(a.serverId).localeCompare(machineLabel(b.serverId)) || a.name.localeCompare(b.name));
  });
  const pickedNames = $derived(picked.map(nameOf));

  async function doPair() {
    if (!picked.length || busy) return;
    busy = true;
    error = null;
    try {
      // Mesmo endpoint pra criar grupo e pra ADICIONAR membro (o backend une os grupos).
      // De outra máquina, o nome vai qualificado; o servidor desta sessão leva o pedido até a dona.
      const nomes = picked.map((k) => serverOf(k) === sid ? nameOf(k) : `${identityOf(serverOf(k), identities)}::${nameOf(k)}`);
      const daqui = picked.filter((k) => serverOf(k) === sid).map(nameOf);
      const res = await pairSession(sessionName, nomes, task.trim(), false, sessionServer());
      const falhas = await grantFull(liberar.flatMap((alias) => daqui.map((name) => ({ name, alias }))), sessionServer());
      onChanged();
      if (falhas.length) {
        error = falhas.join('\n');
      } else if (res.warning) {
        // Falha PARCIAL de aviso (membro sem o prompt): mostra em vez de fechar mudo. O warning
        // pode ser envelope {code, params, msg} — o formataErro traduz; string crua passa direto.
        error = formataErro(res.warning) ?? String(res.warning);
      } else {
        onClose();
      }
    } catch (e) {
      // O motivo vem do backend já traduzido (sessão sumida, aviso não entregue em ninguém, tarefa
      // em conflito) e o `catch` sem variável o jogava fora: a tela dizia só "falhou" e não havia
      // como saber o que consertar.
      const base = m.par_falhou_pareamento({ nomes: pickedNames.join(', ') });
      error = e instanceof Error && e.message ? `${base} ${e.message}` : base;
    } finally {
      busy = false;
    }
  }

  async function doLeave() {
    if (busy) return;
    busy = true;
    error = null;
    // A ponta saindo desfaz os pares dela: o sumiço deles não é a outra pessoa saindo.
    const desfazer = pontaDe.map((p) => sessionsStore.markLeavingPair(p.alias, p.session));
    try {
      const res = await unpairSession(sessionName, sessionServer());
      onChanged();
      if (res.warning) {
        error = formataErro(res.warning) ?? String(res.warning);
      } else {
        onClose();
      }
    } catch (e) {
      for (const d of desfazer) d();
      error = e instanceof Error && e.message ? `${m.par_falhou_saida()} ${e.message}` : m.par_falhou_saida();
    } finally {
      busy = false;
    }
  }

  // Estado vivo de um membro (bolinha na linha), da lista da máquina dele.
  function stateOf(x: Membro): string | null {
    if (!x.server) return null;
    return sessionsStore.rows.find((s) => s.serverId === x.server && s.name === x.name)?.state
      ?? (x.server === sid ? sessions.find((s) => s.name === x.name)?.state : null) ?? null;
  }

  // "Ver em grade": abre o GRUPO inteiro (eu + membros) na grade de comparação existente —
  // cards ao vivo (transcript/preview/estado), 1 clique entra na sessão, cada uma na máquina dela.
  function openGrid() {
    if (!sid) return;
    const ids = [{ serverId: sid, name: sessionName },
      ...membros.flatMap((x) => (x.server ? [{ serverId: x.server, name: x.name }] : []))];
    onClose();
    window.location.hash = '#/compare/' + encodeCompareIds(ids);
  }

  // "Abrir todas lado a lado" (desktop): fixa cada membro num painel próprio do split.
  function openAllSplit() {
    if (!onOpenSplit) return;
    for (const x of membros) if (x.server === sid) onOpenSplit(x.name);
    onClose();
  }
</script>

<!-- `resizable`: o painel do par carrega o contrato do grupo (um documento), a lista de membros e a
     conversa — nos 420px padrao o markdown saia com ~40 caracteres por linha. Fica arrastavel pela
     borda esquerda e a largura persiste. -->
<BottomSheet {open} {onClose} ariaLabel={m.par_aria_sheet()} wide={desktop.atual} centered={desktop.atual}>
  <div class="pair">
    {#if peers.length}
      <!-- Tudo que ROLA fica aqui; o rodape com "Sair do grupo" fica preso embaixo. -->
      <div class="pair-scroll">
      <h2 class="title"><GroupGlyph size={18} /> {m.par_grupo_titulo({ n: membros.length + 1 })}</h2>
      {#if parCabecalho}<p class="pair-fora">{parCabecalho}</p>{/if}
      <p class="hint">
        {m.par_membros_hint()}
      </p>
      {#if temFora}<p class="hint">{m.pair_not_transitive()}</p>{/if}

      <!-- Membros: estado vivo + abrir lado a lado (desktop) por membro. -->
      <div class="list">
        {#if lendoIdentidades}<p class="empty">{m.comum_carregando()}</p>{/if}
        {#each membros as x (x.key)}
          {@const st = stateOf(x)}
          {@const p = x.name}
          {@const local = x.server === sid}
          <div class="row row--member">
            {#if st}<span class="dot" style="background: {stateColors[st as keyof typeof stateColors]};" aria-hidden="true"></span>{/if}
            <span class="row-main">
              <span class="row-name">{p}</span>
              {#if x.note}<span class="row-cwd">{x.note}</span>{:else if x.machine}<span class="row-cwd">{x.machine}</span>{/if}
            </span>
            {#if st}<span class="row-paired">{rotuloEstado(st as State)}</span>{/if}
            {#if onOpenPeerChat && local}
              <!-- Ícones em vez de glifos: `⤢` (expandir) e `⫽` (paralelas) não diziam o que fazem.
                   Aqui: um balão de conversa = abrir a conversa dele; duas colunas = lado a lado. -->
              <button class="split-btn" onclick={() => onOpenPeerChat?.(p)}
                      title={m.par_abrir_conversa_de({ nome: p })} aria-label={m.ctx_abrir_sessao_modal({ n: p })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>
                </svg>
              </button>
            {/if}
            {#if onOpenSplit && local}
              <button class="split-btn" onclick={() => onOpenSplit?.(p)}
                      title={m.par_abrir_lado({ nome: p })} aria-label={m.par_abrir_lado({ nome: p })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4.5" width="8" height="15" rx="1.5"/>
                  <rect x="13" y="4.5" width="8" height="15" rx="1.5"/>
                </svg>
              </button>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Visualizar o grupo inteiro: grade (cards ao vivo, 1 clique abre) ou split (N chats fixos). -->
      <div class="view-row">
        <button class="view-btn" onclick={openGrid} title={m.par_grade_title()}>{m.par_ver_grade()}</button>
        {#if onOpenSplit && membros.some((x) => x.server === sid)}
          <button class="view-btn" onclick={openAllSplit} title={m.par_fixa_title()}>{m.par_todas_lado()}</button>
        {/if}
      </div>

      {#if !adding}
        <button class="ghost-add" onclick={() => (adding = true)}>{m.par_adicionar_sessao()}</button>
      {:else}
        <div class="list">
          {#if candidates.length === 0}
            <p class="empty">{m.par_vazio_fora_grupo()}</p>
          {:else}
            {#each candidates as s (keyOf(s))}
              <button class="row" class:row--picked={picked.includes(keyOf(s))}
                      onclick={() => togglePick(keyOf(s))} disabled={s.recusa !== null} title={s.recusa ?? undefined}
                      aria-label={m.par_adicionar_aria({ nome: s.name, estado: rotuloEstado(s.state) })}>
                <span class="dot" style="background: {stateColors[s.state]};" aria-hidden="true"></span>
                <span class="row-main">
                  <span class="row-name">{s.name}</span>
                  {#if s.recusa}<span class="row-cwd">{s.recusa}</span>
                  {:else if s.serverId !== sid}<span class="row-cwd">{machineLabel(s.serverId)}</span>
                  {:else if s.cwd}<span class="row-cwd">{s.cwd}</span>{/if}
                </span>
                {#if s.pair_peers?.length}
                  <span class="row-paired" title={m.par_ja_agrupada({ nomes: s.pair_peers.join(', ') })}><GroupGlyph size={12} /> {s.pair_peers.length}</span>
                {/if}
              </button>
            {/each}
          {/if}
        </div>
        {#if picked.length}
          {#each liberacoes as l (l.alias)}
            <label class="liberar">
              <input type="checkbox" checked={liberar.includes(l.alias)} disabled={busy}
                     onchange={(e) => { liberar = e.currentTarget.checked ? [...liberar, l.alias] : liberar.filter((x) => x !== l.alias); }} />
              <span><b>{m.pair_release({ dono: l.owner })}</b> {m.pair_full_confirm({ sessao: pickedNames.join(', '), dono: l.owner })}</span>
            </label>
          {/each}
        {/if}
        <button class="primary-btn" onclick={doPair} disabled={!picked.length || busy}>
          {busy ? m.par_adicionando() : picked.length ? m.par_adicionar_nomes({ nomes: pickedNames.join(', ') }) : m.par_escolha_sessoes()}
        </button>
      {/if}

      {#if contract?.content}
        <!-- Contrato compartilhado: as sessões escrevem no arquivo; aqui só leitura. -->
        <div class="contract">
          <h3 class="feed-title">{m.par_contrato_titulo()}</h3>
          <!-- Markdown RENDERIZADO, nao texto cru: o contrato e .md e ler "**Tarefa:**" com os
               asteriscos e pior em tudo. Regra do projeto (CLAUDE.md): todo .md exibido no app passa
               pelo renderMarkdown. -->
          <div class="contract-body md">{@html renderMarkdown(contract.content, { joinWrapped: true })}</div>
          <span class="contract-path" title={contract.path}>{contract.path}</span>
        </div>
      {:else if contractError}
        <!-- Sem isto a busca que falhou some na tela do grupo que ainda não escreveu contrato. -->
        <p class="empty">⚠ {contractError}</p>
      {/if}

      <!-- Conversa do grupo: o que os membros já combinaram, num lugar só. -->
      <div class="feed">
        <h3 class="feed-title">{m.par_conversa_titulo()}</h3>
        {#if feedError}
          <p class="empty">⚠ {feedError}</p>
        {/if}
        {#if feedLoading}
          <p class="empty">{m.comum_carregando()}</p>
        {:else if feed.length === 0}
          <p class="empty">{m.par_vazio_trocas()}</p>
        {:else}
          {#each feed as msg, i (i)}
            <div class="feed-item" class:feed-item--out={msg.from === sessionName}>
              <span class="feed-meta">{msg.from} → {msg.to}{#if msg.ts}&nbsp;· {relativeTime(msg.ts)}{/if}</span>
              <span class="feed-text">{msg.text}</span>
            </div>
          {/each}
        {/if}
      </div>
      </div><!-- /pair-scroll -->

      <!-- Rodape FIXO: "Sair do grupo" e destrutivo e nao pode fugir com o scroll do contrato. -->
      <div class="pair-foot">
        {#each [...new Set(pontaDe.map((p) => p.owner))] as dono (dono)}<p class="error">{m.pair_undo_anchor_body({ dono })}</p>{/each}
        {#if error}<p class="error">{error}</p>{/if}
        <button class="danger-btn" onclick={doLeave} disabled={busy}>
          {busy ? m.par_saindo() : m.par_sair_grupo()}
        </button>
      </div>
    {:else}
      <h2 class="title">{m.par_parear_titulo()}</h2>
      <p class="hint">
        {m.par_passam_hint()}
      </p>

      {#if error}<p class="error">{error}</p>{/if}

      <div class="list">
        {#if candidates.length === 0 && !error}
          <p class="empty">{m.forward_nenhuma_viva()}</p>
        {:else}
          {#each candidates as s (keyOf(s))}
            <button class="row" class:row--picked={picked.includes(keyOf(s))}
                    onclick={() => togglePick(keyOf(s))} disabled={s.recusa !== null} title={s.recusa ?? undefined}
                    aria-label={m.par_parear_aria({ nome: s.name, estado: rotuloEstado(s.state) })}>
              <span class="dot" style="background: {stateColors[s.state]};" aria-hidden="true"></span>
              <span class="row-main">
                <span class="row-name">{s.name}</span>
                {#if s.recusa}<span class="row-cwd">{s.recusa}</span>
                {:else if s.serverId !== sid}<span class="row-cwd">{machineLabel(s.serverId)}</span>
                {:else if s.cwd}<span class="row-cwd">{s.cwd}</span>{/if}
              </span>
              {#if s.pair_peers?.length}
                <span class="row-paired" title={m.par_ja_agrupada({ nomes: s.pair_peers.join(', ') })}><GroupGlyph size={12} /> {s.pair_peers.length}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      <input
        type="text"
        class="task-input"
        bind:value={task}
        placeholder={m.par_tarefa_placeholder()}
      />

      <button class="primary-btn" onclick={doPair} disabled={!picked.length || busy}>
        {busy ? m.par_pareando() : picked.length ? m.par_parear_nomes({ nomes: pickedNames.join(', ') }) : m.par_escolha_varias()}
      </button>
    {/if}
  </div>
</BottomSheet>

<style>
  .pair { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }

  .title { font-size: var(--text-base); font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: var(--space-2); }

  .hint { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; }

  .error { font-size: var(--text-sm); color: #e5484d; white-space: pre-line; }
  .pair-fora { font-size: var(--text-sm); font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
  .liberar { display: flex; gap: var(--space-2); align-items: flex-start; font-size: var(--text-sm); color: var(--text-secondary); }
  .empty { font-size: var(--text-sm); color: var(--text-muted); padding: var(--space-3) 0; }

  .list { display: flex; flex-direction: column; }

  .row {
    display: flex; align-items: center; gap: var(--space-3);
    width: 100%; padding: var(--space-3);
    background: none; border: 1px solid transparent; border-radius: var(--radius-md);
    text-align: left; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .row:hover { background: var(--bg-hover); }
  .row--picked { border-color: var(--accent); background: var(--accent-dim); }
  .row:disabled { opacity: 0.6; cursor: default; }

  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

  .row-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .row-name { font-size: var(--text-base); color: var(--text-primary); font-weight: 500; }
  .row-cwd {
    font-size: var(--text-xs); color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .row-paired { font-size: var(--text-xs); color: var(--text-muted); flex-shrink: 0; }

  /* Linha de MEMBRO do grupo (não clicável; ações à direita). */
  .row--member { cursor: default; }
  .row--member:hover { background: none; }

  /* Abrir membro lado a lado (desktop). */
  .split-btn {
    width: 30px; height: 30px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    background: var(--surface-raised); color: var(--text-secondary);
    font-size: 13px; cursor: pointer;
  }
  .split-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

  /* Botões de visualização do grupo (grade / lado a lado). */
  .view-row { display: flex; gap: var(--space-2); }
  .view-btn {
    flex: 1; height: 40px;
    border: 1px solid var(--border-default); border-radius: var(--radius-md);
    background: var(--surface-card); color: var(--text-primary);
    font-size: var(--text-sm); cursor: pointer;
  }
  .view-btn:hover { background: var(--bg-hover); }

  /* "+ Adicionar sessão ao grupo": discreto, abre o picker. */
  .ghost-add {
    width: 100%; height: 40px;
    border: 1px dashed var(--border-default); border-radius: var(--radius-md);
    background: none; color: var(--text-secondary);
    font-size: var(--text-sm); cursor: pointer;
  }
  .ghost-add:hover { color: var(--text-primary); background: var(--bg-hover); }

  .task-input {
    height: 44px;
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: 16px;
    padding: 0 var(--space-3);
    outline: none;
    width: 100%;
  }
  .task-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
  .task-input::placeholder { color: var(--text-muted); }

  .primary-btn {
    width: 100%; height: 50px;
    background: var(--accent); border-radius: var(--radius-md);
    color: #fff; font-size: var(--text-base); font-weight: 600;
  }
  .primary-btn:disabled { opacity: 0.5; cursor: default; }

  /* Contrato compartilhado: box mono rolável, read-only. */
  .contract {
    display: flex; flex-direction: column; gap: var(--space-2);
    border-top: 1px solid var(--border-subtle);
    padding-top: var(--space-3);
  }
  /* Painel em coluna: cabecalho+conteudo rolam, rodape fica. `min-height: 0` e o que permite o
     filho encolher dentro do flex (sem ele o scroller cresce e empurra o rodape pra fora). */
  .pair { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .pair-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .pair-foot {
    flex-shrink: 0;
    padding-top: var(--space-3);
    margin-top: var(--space-2);
    border-top: 1px solid var(--border-subtle);
    background: transparent;
  }

  .contract-body {
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--text-secondary);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    word-break: break-word;
    /* SEM teto de altura: o contrato inteiro corre no scroll do proprio painel. Com max-height
       virava caixa-dentro-de-caixa — duas barras de rolagem competindo e o fim do documento
       escondido atras da segunda. */
  }
  /* Tipografia do markdown do contrato. */
  .contract-body :global(h1) { margin: 0 0 var(--space-2); font-size: var(--text-sm); color: var(--text-primary); }
  .contract-body :global(h2) { margin: var(--space-3) 0 var(--space-1); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
  .contract-body :global(h3) { margin: var(--space-2) 0 var(--space-1); font-size: var(--text-xs); color: var(--text-secondary); }
  .contract-body :global(p) { margin: 0 0 var(--space-2); }
  .contract-body :global(strong) { color: var(--text-primary); font-weight: 650; }
  .contract-body :global(ul), .contract-body :global(ol) { margin: 0 0 var(--space-2); padding-left: 1.2em; }
  .contract-body :global(li) { margin: 2px 0; }
  .contract-body :global(code) { padding: 0 4px; border-radius: 3px; background: var(--surface-raised); font-family: var(--font-mono); font-size: 11px; color: var(--text-primary); }
  .contract-body :global(pre) { margin: 0 0 var(--space-2); padding: var(--space-2); overflow-x: auto; border-radius: var(--radius-sm); background: var(--surface-inset); }
  /* O pre DENTRO do code-block (header novo) perde a caixa propria — o reset global do app.css
     perde em especificidade pra regra scoped acima, e sem isto virava borda dentro de borda. */
  .contract-body :global(.code-block pre) { background: none; border: none; border-radius: 0; margin: 0; }
  .contract-body :global(a) { color: var(--accent); }
  .contract-body :global(hr) { margin: var(--space-3) 0; border: 0; border-top: 1px solid var(--border-subtle); }
  .contract-path {
    font-size: var(--text-xs); color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Conversa do par: timeline compacta, rolável. */
  .feed {
    display: flex; flex-direction: column; gap: var(--space-2);
    max-height: 40vh; overflow-y: auto;
    border-top: 1px solid var(--border-subtle);
    padding-top: var(--space-3);
  }
  .feed-title { font-size: var(--text-sm); font-weight: 600; color: var(--text-secondary); }
  .feed-item {
    display: flex; flex-direction: column; gap: 2px;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .feed-item--out { border-color: var(--accent-dim); }
  .feed-meta { font-size: var(--text-xs); color: var(--text-muted); }
  .feed-text {
    font-size: var(--text-sm); color: var(--text-primary); line-height: 1.45;
    white-space: pre-wrap; word-break: break-word;
    display: -webkit-box; line-clamp: 4; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }

  .danger-btn {
    width: 100%; height: 50px;
    background: none; border: 1px solid #e5484d; border-radius: var(--radius-md);
    color: #e5484d; font-size: var(--text-base); font-weight: 600;
  }
  .danger-btn:disabled { opacity: 0.5; cursor: default; }
</style>
