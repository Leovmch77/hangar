<script lang="ts">
  // Coluna de git do desktop: mora ENTRE a sidebar e a conversa, não no painel da direita (que
  // segue com Contexto/Arquivos). O escopo é a sessão focada — o repo dela está no topo, porque
  // a lista de sessões mistura repositórios e "de qual git é este" não pode depender de memória.
  import { untrack } from 'svelte';
  import * as m from '../../paraglide/messages';
  import { sidebarPrefs } from '../../lib/sidebarPrefs.svelte';
  import { gitStoreDaSessao, gitPainel, abrirArquivo, abrirCommit, limparAbas } from '../../lib/gitPainel.svelte';
  import { basename } from '@hangar/core';
  import FileIcon from '../files/FileIcon.svelte';
  import CommitBox from './CommitBox.svelte';
  import CommitList from './CommitList.svelte';
  import CommitMenu from './CommitMenu.svelte';
  import ArquivoMenu from './ArquivoMenu.svelte';
  import type { ChangedFile, GitCommit } from '@hangar/core';

  interface Props {
    sessionName: string;
    cwd?: string | null;
    onFechar: () => void;
  }
  let { sessionName, cwd = null, onFechar }: Props = $props();

  const git = $derived(gitStoreDaSessao(sessionName));
  let escolhidos = $state<string[]>([]);
  let grafoAberto = $state(true);

  // Troca de sessão = outro repositório: recarrega tudo e esquece o que estava selecionado lá.
  // untrack pelo mesmo motivo do painel: load()/openLog() leem estado do store, e sem isso cada
  // carga reagenda a próxima — laço infinito de /git/files e /git/log.
  $effect(() => {
    const s = sessionName;
    escolhidos = [];
    limparAbas();
    untrack(() => {
      const store = gitStoreDaSessao(s);
      store.load();
      store.openLog();
    });
  });

  // Hash do commit da aba ativa: é o que fica marcado na lista do grafo.
  const shaAtivo = $derived.by(() => {
    const a = gitPainel.abas.find((x) => x.id === gitPainel.ativa);
    return a?.tipo === 'commit' ? a.commit.hash : undefined;
  });

  const repo = $derived(cwd ? basename(cwd) : sessionName);
  const marcado = (p: string) => escolhidos.includes(p);

  // Arquivo com as duas metades sujas ("MM") cai só no grupo staged: a lista é uma linha por
  // caminho, e é o caminho inteiro que vai pro commit.
  const staged = $derived(git.files.filter((f) => f.staged));
  const naoStaged = $derived(git.files.filter((f) => !f.staged));
  const marcarTodos = () => (escolhidos = git.files.map((f) => f.path));

  let menuCommit = $state<GitCommit | null>(null);
  let menuArquivo = $state<{ path: string; x: number; y: number } | null>(null);

  // Altura da lista de mudanças: o resto da coluna é do histórico. Arrastável e salva, porque a
  // proporção útil muda com o trabalho — 30 arquivos sujos pedem lista grande, revisar histórico
  // pede o contrário.
  const CHAVE_ALTURA = 'cp_git_coluna_mudancas_h';
  const MIN = 90;
  const MIN_HISTORICO = 140;   // o histórico nunca pode ser espremido até sumir
  let alturaLista = $state(220);
  let arrastando = $state(false);
  let raiz = $state<HTMLElement | null>(null);
  let listaEl = $state<HTMLElement | null>(null);
  let grafoEl = $state<HTMLElement | null>(null);

  // Teto REAL: o que sobra entre o topo da lista e o pé da coluna, menos o mínimo do histórico.
  // Medir pela altura total da coluna dava um teto maior que o espaço livre (o cabeçalho e a caixa
  // de commit já comeram parte), e arrastar até o fim empurrava o histórico pra fora da tela.
  function teto(): number {
    if (!raiz || !listaEl) return 400;
    // O fundo é o da coluna OU o da janela, o que vier primeiro: com a coluna transbordando, o
    // bottom dela fica fora da tela e o teto virava um número que não existe — foi o que empurrou
    // o histórico pra fora.
    const fundo = Math.min(raiz.getBoundingClientRect().bottom, window.innerHeight);
    const lista = listaEl.getBoundingClientRect();
    // Entre a lista e o grafo existem o sash e o cabeçalho "Histórico": sem contar essa faixa, a
    // reserva de MIN_HISTORICO virava ~100px de grafo de verdade.
    const faixa = grafoEl ? Math.max(0, grafoEl.getBoundingClientRect().top - lista.bottom) : 34;
    return Math.max(MIN, fundo - lista.top - faixa - MIN_HISTORICO);
  }

  // Altura salva + aperto por tamanho, no MESMO efeito: separados, a leitura do localStorage roda
  // depois do clamp e devolve um valor maior que a coluna — que foi o que sumia com o histórico.
  // O rAF existe porque no mount as medidas ainda não valem.
  $effect(() => {
    if (!raiz) return;
    const salvo = Number(localStorage.getItem(CHAVE_ALTURA));
    const aplicar = () => { alturaLista = Math.min(salvo >= MIN ? salvo : alturaLista, teto()); };
    const id = requestAnimationFrame(aplicar);
    const ro = new ResizeObserver(() => { alturaLista = Math.min(alturaLista, teto()); });
    ro.observe(raiz);
    return () => { cancelAnimationFrame(id); ro.disconnect(); };
  });

  // Altura casando com a sidebar: no modo dock ("Só o conteúdo") ela tem altura de conteúdo, e uma
  // coluna vizinha indo de ponta a ponta ao lado dela lê como peça solta. CSS não alcança um irmão,
  // então a medida vem de um ResizeObserver na própria sidebar.
  let alturaSidebar = $state(0);
  $effect(() => {
    if (sidebarPrefs.height !== 'content') { alturaSidebar = 0; return; }
    const alvo = document.querySelector('.sidebar');
    if (!alvo) return;
    const medir = () => { alturaSidebar = alvo.getBoundingClientRect().height; };
    const ro = new ResizeObserver(medir);
    ro.observe(alvo);
    medir();
    return () => ro.disconnect();
  });

  // Rolagem infinita do histórico: 200px antes do fim já pede o próximo lote, então rolar não
  // esbarra num botão. `rootMargin` no root da rolagem (.grafo), não na janela.
  let fimEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const alvo = fimEl;
    const raizRolagem = grafoEl;
    if (!alvo || !raizRolagem) return;
    const io = new IntersectionObserver(
      (entradas) => { if (entradas.some((e) => e.isIntersecting)) untrack(() => git.maisLog()); },
      { root: raizRolagem, rootMargin: '200px' },
    );
    io.observe(alvo);
    return () => io.disconnect();
  });

  // ── Largura da coluna (handle na borda direita, como a sidebar) ──────────
  const CHAVE_LARGURA = 'cp_git_coluna_w';
  // A árvore de arquivos precisa de largura pra caber nome + pasta + ±N: abaixo de 240 tudo vira
  // reticências. Sem escolha própria, nasce do tamanho da SIDEBAR (cp_sidebar_w) — duas colunas
  // vizinhas de larguras diferentes leem como desalinho, não como hierarquia.
  const LARG_MIN = 240, LARG_MAX = 520;
  let largura = $state(270);
  let redim = $state(false);

  $effect(() => {
    const salvo = Number(localStorage.getItem(CHAVE_LARGURA));
    if (salvo >= LARG_MIN && salvo <= LARG_MAX) { largura = salvo; return; }
    const daSidebar = Number(localStorage.getItem('cp_sidebar_w'));
    largura = Math.max(LARG_MIN, Math.min(LARG_MAX, daSidebar || 270));
  });

  function largInicio(e: PointerEvent) {
    redim = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* segue sem captura */ }
  }
  function largMover(e: PointerEvent) {
    if (!redim || !raiz) return;
    largura = Math.max(LARG_MIN, Math.min(LARG_MAX, e.clientX - raiz.getBoundingClientRect().left));
  }
  function largFim() {
    if (!redim) return;
    redim = false;
    try { localStorage.setItem(CHAVE_LARGURA, String(Math.round(largura))); } catch { /* sem storage: vale só nesta sessão */ }
  }

  function arrastarInicio(e: PointerEvent) {
    arrastando = true;
    // A captura é otimização (segue o ponteiro fora do elemento), não requisito: se o navegador
    // recusar o id, o arrasto continua pelos eventos normais em vez de morrer aqui.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* segue sem captura */ }
  }
  function arrastarMover(e: PointerEvent) {
    if (!arrastando || !listaEl) return;
    const topo = listaEl.getBoundingClientRect().top;
    alturaLista = Math.max(MIN, Math.min(teto(), e.clientY - topo));
  }
  function arrastarFim() {
    if (!arrastando) return;
    arrastando = false;
    try { localStorage.setItem(CHAVE_ALTURA, String(Math.round(alturaLista))); } catch { /* sem storage: vale só nesta sessão */ }
  }
  function alternar(p: string) {
    escolhidos = marcado(p) ? escolhidos.filter((x) => x !== p) : [...escolhidos, p];
  }
</script>

<!-- `flutuante` espelha Aparência → "Altura da barra lateral → Só o conteúdo" (Sidebar.svelte:357):
     como esta coluna é extensão da sidebar, ela tem que virar dock junto, senão uma peça é caixa
     centrada e a outra é parede de ponta a ponta, coladas. -->
<aside class="git-coluna" class:flutuante={sidebarPrefs.height === 'content'} class:redim
       style="--git-col-w: {largura}px{alturaSidebar ? `; --git-col-h: ${Math.round(alturaSidebar)}px` : ''}"
       bind:this={raiz} aria-label={m.git_coluna_titulo({ repo })}>
  <div class="larg-handle" role="separator" aria-orientation="vertical"
       aria-label={m.git_largura_coluna()}
       onpointerdown={largInicio} onpointermove={largMover}
       onpointerup={largFim} onpointercancel={largFim}></div>
  <header class="topo">
    <span class="repo" title={cwd ?? repo}>{repo}</span>
    {#if git.current}<span class="branch">{git.current}{#if git.dirty}<span class="sujo">*</span>{/if}</span>{/if}
    <!-- ↑ falta enviar, ↓ falta trazer. Só com upstream: sem ele não há com o que comparar. -->
    {#if git.ahead !== null || git.behind !== null}
      <span class="sync" title={m.git_sync_titulo({ ahead: git.ahead ?? 0, behind: git.behind ?? 0 })}>
        {#if git.ahead}<span class="ah">↑{git.ahead}</span>{/if}
        {#if git.behind}<span class="be">↓{git.behind}</span>{/if}
        {#if !git.ahead && !git.behind}<span class="ok">✓</span>{/if}
      </span>
    {/if}
    <button class="fechar" onclick={onFechar} aria-label={m.git_coluna_fechar()}>×</button>
  </header>

  {#if git.error}
    <p class="erro" role="alert">{git.error}</p>
  {/if}

  <CommitBox {git} chosen={escolhidos} onDone={() => (escolhidos = [])} />

  <h3 class="sec">
    {m.git_aba_mudancas()}<span class="qtd">{git.files.length}</span>
    {#if git.files.length}
      <span class="sel-acoes">
        <button class="acao" onclick={marcarTodos}>{m.custos_todos()}</button>
        <button class="acao" onclick={() => (escolhidos = [])}>{m.git_nenhum()}</button>
      </span>
    {/if}
  </h3>

  {#snippet linhaArquivo(f: ChangedFile)}
    <li>
      <input type="checkbox" checked={marcado(f.path)} onchange={() => alternar(f.path)}
             aria-label={f.path} />
      <button class="linha" onclick={() => abrirArquivo(sessionName, f.path)} title={f.path}
              oncontextmenu={(e) => { e.preventDefault(); menuArquivo = { path: f.path, x: e.clientX, y: e.clientY }; }}>
        <FileIcon nome={f.path} />
        <span class="nome">{basename(f.path)}</span>
        <span class="dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
        {#if f.added !== null && f.removed !== null}
          <span class="num"><span class="mais">+{f.added}</span> <span class="menos">−{f.removed}</span></span>
        {/if}
        <span class="cod" class:novo={f.code.trim() === '??'}>{f.code.trim() || 'M'}</span>
      </button>
      <!-- Mesmo ⋯ dos commits: o menu do arquivo não fica só no clique direito. -->
      <button class="mini" aria-label={m.git_acoes_curto()}
              onclick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                menuArquivo = { path: f.path, x: r.left, y: r.bottom + 4 }; }}>⋯</button>
    </li>
  {/snippet}

  {#if git.loading && !git.files.length}
    <p class="vazio">{m.git_diff_carregando()}</p>
  {:else if !git.files.length}
    <p class="vazio">{m.git_sem_diferencas()}</p>
  {:else}
    <!-- Staged e não staged em grupos separados: o que já está no índice vai pro commit por outro
         caminho que o resto, e ver os dois na mesma lista escondia essa diferença. Um grupo só
         (tudo staged ou nada staged) não ganha subtítulo — seria enfeite. -->
    <ul class="arquivos" bind:this={listaEl} style="height: {alturaLista}px">
      {#if staged.length && naoStaged.length}
        <li class="grupo">{m.git_grupo_staged()}<span class="grupo-n">{staged.length}</span></li>
      {/if}
      {#each staged as f (f.path)}{@render linhaArquivo(f)}{/each}
      {#if staged.length && naoStaged.length}
        <li class="grupo">{m.git_grupo_nao_staged()}<span class="grupo-n">{naoStaged.length}</span></li>
      {/if}
      {#each naoStaged as f (f.path)}{@render linhaArquivo(f)}{/each}
    </ul>
  {/if}

  <!-- Divisória entre a lista e o histórico: o histórico fica com o que sobra. -->
  <div class="sash" class:arrastando role="separator" aria-orientation="horizontal"
       aria-label={m.git_altura_lista()}
       onpointerdown={arrastarInicio} onpointermove={arrastarMover}
       onpointerup={arrastarFim} onpointercancel={arrastarFim}></div>

  <h3 class="sec grafo-cab">
    <button class="dobra" onclick={() => (grafoAberto = !grafoAberto)}
            aria-expanded={grafoAberto}>{grafoAberto ? '▾' : '▸'} {m.git_aba_historico()}</button>
  </h3>
  {#if grafoAberto}
    <div class="grafo" bind:this={grafoEl}>
      <!-- Selecionar aqui manda os arquivos do commit pro painel da direita (gitPainel), onde o
           diff tem largura pra ser lido; o ⋯ abre o mesmo menu de commit do resto do app. -->
      <CommitList commits={git.commits} selectedHash={shaAtivo}
                  onSelect={(c) => c && abrirCommit(sessionName, c)}
                  onMenu={(c) => (menuCommit = c)} wtCount={git.files.length} />
      {#if git.temMais}
        <!-- Sentinela: chegar perto do fim da rolagem já carrega o próximo lote. O botão continua
             como saída pra teclado e pra quando o observer não dispara (lista menor que a área). -->
        <div bind:this={fimEl} class="fim-lista" aria-hidden="true"></div>
        <button class="mais-log" onclick={() => git.maisLog()} disabled={git.carregandoMais}>
          {git.carregandoMais ? m.comum_carregando() : m.git_carregar_mais({ n: git.commits.length })}
        </button>
      {/if}
    </div>
  {/if}
</aside>

{#if menuArquivo}
  <ArquivoMenu path={menuArquivo.path} x={menuArquivo.x} y={menuArquivo.y} {git}
    onAbrir={(p) => abrirArquivo(sessionName, p)} onClose={() => (menuArquivo = null)} />
{/if}

{#if menuCommit}
  <CommitMenu commit={menuCommit} {git} onClose={() => (menuCommit = null)}
    onShowDiff={(c) => { abrirCommit(sessionName, c); menuCommit = null; }}
    onShowWorktreeDiff={(c) => { abrirCommit(sessionName, c); menuCommit = null; }} />
{/if}

<style>
  /* Card irmão da sidebar: mesma receita de material dela (Sidebar.svelte:1236-1296) em qualquer
     tema — `--glass-bg-solid` normal, `--glass-panel` sob liquid, `--glass-bg` no liquid escuro —
     com os quatro cantos e a mesma margem, em vez de meio-card colado. A largura é do usuário
     (handle na borda direita, como a sidebar). */
  .git-coluna {
    position: relative;
    display: flex; flex-direction: column; min-height: 0; min-width: 0;
    width: var(--git-col-w, 264px); flex: none;
    /* overflow: sem isso a coluna cresce com o conteúdo, passa do pé da janela e leva o histórico
       junto — o clamp do arrasto não salva um contêiner que já transbordou. */
    overflow: hidden;
    height: auto;
    margin: var(--space-3) 0 var(--space-3) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    box-shadow: var(--elev-3);
    background: transparent;   /* o fundo vai pro leaf ::before (vidro) */
    /* Mesmo respiro interno da sidebar (padding: var(--space-3)): o conteúdo não encosta na borda
       do card. As seções abaixo zeram o padding lateral próprio pra não somar dois recuos. */
    padding: var(--space-3) 0;
    /* Container query: a largura é do usuário (handle), então quem decide o arranjo interno é a
       caixa, não a janela — media query aqui daria o resultado errado em qualquer largura. */
    container-type: inline-size;
  }
  .git-coluna.redim { transition: none; }
  /* Handle de largura: mesma pegada do resize-handle da Sidebar (lá a borda é a direita também). */
  .larg-handle {
    position: absolute; top: 0; right: 0; width: 6px; height: 100%;
    cursor: col-resize; z-index: 2; background: transparent;
  }
  .larg-handle:hover, .git-coluna.redim .larg-handle { background: var(--accent-dim); }
  .git-coluna::before {
    content: '';
    position: absolute; inset: 0; z-index: -1;
    border-radius: inherit; pointer-events: none;
    background: var(--glass-bg-solid);
  }
  :global(html[data-liquid]) .git-coluna {
    backdrop-filter: url(#liquid-glass) blur(20px) saturate(170%);
  }
  :global(html[data-liquid]) .git-coluna::before { background: var(--glass-panel); }
  :global(html[data-liquid][data-theme='dark']) .git-coluna::before { background: var(--glass-bg); }

  /* "Só o conteúdo": dock — altura do conteúdo, centralizado, igual à .sidebar.floating. */
  .git-coluna.flutuante {
    align-self: center;
    /* A MESMA altura da sidebar (medida em JS): duas peças vizinhas de alturas diferentes leem
       como desalinho. Sem a medida ainda, cai no comportamento antigo. */
    height: var(--git-col-h, auto);
    max-height: calc(100% - var(--space-8));
    /* só a margem VERTICAL sai (quem centraliza é o align-self); a lateral fica, senão a coluna
       encosta na sidebar e as duas viram um bloco só. */
    margin-block: 0;
  }

  /* Aparência → Painéis → "Colados": a sidebar vira parede de ponta a ponta, e a extensão dela
     também — sem card, sem raio, só a costura de 1px que separa da conversa. Alcança o dock
     TAMBÉM, pelo mesmo motivo documentado em Sidebar.svelte:1327. */
  :global(html[data-panels='edge']) .git-coluna.flutuante {
    align-self: stretch;
    max-height: none;
  }
  :global(html[data-panels='edge']) .git-coluna {
    height: 100%;
    margin: 0;
    border: 0;
    border-right: 1px solid var(--border-subtle);
    border-radius: 0;
    box-shadow: inset 0 1px 1px var(--glass-specular);
  }
  /* Um recuo lateral só pra coluna inteira — antes cada seção tinha o seu (14/16px), e nada
     alinhava com a sidebar nem entre si. */
  .git-coluna { --recuo: var(--space-3); }
  .topo {
    display: flex; align-items: center; gap: var(--space-2);
    padding: 0 var(--recuo) var(--space-3); border-bottom: 1px solid var(--border-subtle);
  }
  .repo { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .branch {
    font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-secondary);
    background: var(--fill-subtle); border: 1px solid var(--border-default);
    border-radius: 999px; padding: 2px 9px; white-space: nowrap;
  }
  .sujo { color: var(--warning); }
  .sync { display: flex; gap: var(--space-1); font-family: var(--font-mono); font-size: var(--text-xs); }
  .sync .ah { color: var(--accent); }
  .sync .be { color: var(--warning); }
  .sync .ok { color: var(--ok); }
  .mais-log {
    display: block; width: calc(100% - var(--recuo) * 2); margin: var(--space-2) var(--recuo);
    padding: 6px; border-radius: var(--radius-md);
    background: var(--fill-subtle); border: 1px solid var(--border-default);
    color: var(--text-secondary); font: inherit; font-size: var(--text-xs); cursor: pointer;
    transition: background-color 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  .fim-lista { height: 1px; }
  .mais-log:disabled { opacity: 0.5; cursor: default; }
  .mais-log:active:not(:disabled) { scale: 0.96; }
  @media (hover: hover) and (pointer: fine) {
    .mais-log:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  }
  .fechar {
    margin-left: auto; background: none; border: 0; color: var(--text-muted);
    font-size: var(--text-base); line-height: 1; cursor: pointer; padding: 2px 4px;
  }
  .fechar:hover { color: var(--text-primary); }
  .erro { padding: var(--space-2) var(--recuo); color: var(--danger); font-size: var(--text-xs); }
  .sec {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-4) var(--recuo) var(--space-1);
    font-size: var(--text-xs); font-weight: 600; text-transform: uppercase;
    letter-spacing: .05em; color: var(--text-secondary);
  }
  .qtd {
    background: var(--accent); color: var(--text-inverse); border-radius: 999px;
    padding: 0 7px; font-size: 10px; letter-spacing: 0;
  }
  /* Todos/nenhum encostados na direita do título, longe do × de fechar a coluna. */
  .sel-acoes { margin-left: auto; display: flex; gap: var(--space-1); }
  .acao {
    background: none; border: 0; padding: 2px 4px; border-radius: 6px; cursor: pointer;
    color: var(--text-muted); font: inherit; font-size: 10px; letter-spacing: 0;
    text-transform: none; font-weight: 500;
    transition: background-color 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  @media (hover: hover) and (pointer: fine) {
    .acao:hover { background: var(--fill-subtle); color: var(--text-primary); }
  }
  .vazio { padding: var(--space-2) var(--recuo); color: var(--text-muted); font-size: var(--text-xs); }
  .arquivos { list-style: none; margin: 0; padding: 0; overflow: auto; flex: none; }
  /* Subtítulo de grupo: gruda no topo enquanto o grupo dele rola, senão em lista longa some a
     informação de qual metade se está olhando. */
  .arquivos li.grupo {
    position: sticky; top: 0; z-index: 1;
    gap: var(--space-1); padding: var(--space-2) var(--recuo) var(--space-1);
    background: var(--glass-bg-solid);
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
    color: var(--text-muted);
  }
  /* Mesmo material do card (::before acima): sob liquid o fundo sólido viraria remendo. */
  :global(html[data-liquid]) .arquivos li.grupo { background: var(--glass-panel); }
  :global(html[data-liquid][data-theme='dark']) .arquivos li.grupo { background: var(--glass-bg); }
  .grupo-n { font-family: var(--font-mono); letter-spacing: 0; }
  .sash {
    height: 5px; flex: none; cursor: row-resize; position: relative;
    border-bottom: 1px solid var(--border-subtle);
  }
  .sash:hover, .sash.arrastando { background: var(--accent-dim); }
  .arquivos li { display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--recuo); }

  /* A caixa de commit é componente compartilhado (CommitBox): ela ganha o recuo da coluna aqui,
     e numa coluna estreita os dois botões deixam de disputar a mesma linha — empilham, com o
     primário embaixo (é o destino do gesto, fica mais perto do polegar/cursor que acabou de
     marcar os arquivos). Container query, não media: quem manda é a largura da coluna. */
  .git-coluna :global(.cb) { padding: 0 var(--recuo); }
  @container (max-width: 320px) {
    .git-coluna :global(.cb-actions) { flex-direction: column-reverse; }
    .git-coluna :global(.cb-btn) { width: 100%; }
  }
  /* Feedback de toque: 0.96 é o valor da referência — abaixo de 0.95 exagera. Transição nomeando
     as propriedades (só o que muda) e curta, porque é interação de alta frequência. */
  .git-coluna :global(.cb-btn) {
    transition-property: scale, background-color, opacity;
    transition-duration: 150ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  .git-coluna :global(.cb-btn:active:not(:disabled)) { scale: 0.96; }
  /* Mesmo raio concêntrico do resto: item de commit encostado no recuo da coluna. */
  .git-coluna :global(.git-commit) {
    border-radius: var(--radius-md);
    transition: background-color 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  /* Raio concêntrico: a coluna é 24 com 12 de recuo, então o que fica encostado nesse recuo pede
     24 − 12 = 12 (--radius-md). Com 6px o item parecia de outra peça. */
  .linha {
    flex: 1; min-width: 0; display: flex; align-items: center; justify-content: flex-start;
    gap: var(--space-2);
    background: none; border: 0; color: inherit; font: inherit; font-size: var(--text-xs);
    padding: 5px var(--space-2); border-radius: var(--radius-md); cursor: pointer; text-align: left;
    transition: background-color 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  /* hover só em ponteiro fino: em touch o toque deixa a linha acesa depois de sair dela. */
  @media (hover: hover) and (pointer: fine) {
    .linha:hover { background: var(--fill-subtle); }
  }
  .linha:active { scale: 0.98; }   /* lista densa: menos que os 0.96 de botão */
  /* ⋯ do arquivo: aparece no hover/foco pra não poluir a linha, mas ocupa o lugar sempre (sem
     `display:none`), senão a lista dança quando o mouse passa. */
  .mini {
    flex: none; width: 20px; background: none; border: 0; cursor: pointer;
    color: var(--text-muted); font-size: var(--text-xs); line-height: 1; padding: 2px;
    border-radius: 6px;
    transition: opacity 120ms cubic-bezier(0.2, 0, 0, 1), background-color 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  /* Em touch não há hover pra revelar o ⋯: ele fica sempre visível ali. */
  .mini { opacity: 1; }
  @media (hover: hover) and (pointer: fine) {
    .mini { opacity: 0; }
    .arquivos li:hover .mini, .mini:hover { opacity: 1; }
    .mini:hover { background: var(--fill-subtle); color: var(--text-primary); }
  }
  .mini:focus-visible { opacity: 1; }
  .mini:active { scale: 0.96; }
  .nome { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dir { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .num { font-family: var(--font-mono); font-size: 10px; white-space: nowrap; }
  .mais { color: var(--ok); }
  .menos { color: var(--danger); }
  .cod { font-family: var(--font-mono); font-size: 10px; color: var(--warning); }
  .cod.novo { color: var(--accent); }
  .grafo-cab { flex: none; }
  .dobra { background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 0; }
  .grafo { flex: 1; min-height: 0; overflow: auto; padding: 0 var(--space-1); }
</style>
