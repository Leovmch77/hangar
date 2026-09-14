<script lang="ts">
  import { computeEditDiff, extractEdits, extractFilePath, pseudoCaminhoPorConteudo, type ChatEvent } from '@hangar/core';
  import * as m from '../paraglide/messages';
  import { parseFilePaths, summarizeToolInput, summarizeToolResult, toolPhase, toolVerbo } from '@hangar/core';
  import FileIcon from './files/FileIcon.svelte';
  import { toolLook } from '../lib/toolLook.svelte';
  import { caminhoDeCodigoNoComando } from '../lib/codeFromBash';
  import { rolagemSoAoClicar } from '../lib/rolagemSoAoClicar';
  import { lerComandoHangar, lerFerramentaClaude } from '../lib/hangarCmd';
  import HangarCommandCard from './HangarCommandCard.svelte';
  import FileAttachment from './FileAttachment.svelte';
  import EditDiff from './EditDiff.svelte';
  import ReadView from './ReadView.svelte';
  import ToolGlyph from './ToolGlyph.svelte';
  import { rotaDoAlvo } from '../lib/alvoSessao';
  import { sessionsStore } from '../lib/sessionsStore.svelte';

  interface Props {
    event: ChatEvent;
    result?: ChatEvent | null;
    sessionName: string;
    animate?: boolean;   // false = card de HISTORICO remontado (paginacao/janela): sem fade
    /** true = desenha SÓ o detalhe (diff/saída/imagem); quem chama já mostrou a chamada. */
    soDetalhe?: boolean;
    /** Linha de um grupo (pele 'chips'): desenha o conector em L; `ultimo` encerra o tronco. */
    emGrupo?: boolean;
    ultimo?: boolean;
    /** Chamada cujo pedido o modelo ainda escreve (Claude sem terminal). */
    escrevendo?: boolean;
  }
  let { event, result = null, sessionName, animate = true, soDetalhe = false, emGrupo = false, ultimo = false,
        escrevendo = false }: Props = $props();

  // Edit/MultiEdit/Write: o tool_input ja traz o texto antigo e o novo (no Write, o antigo e vazio
  // e sai tudo como adicao) -> da pra mostrar o DIFF (estilo Pi, lado a lado) no lugar do resultado
  // cru. Aberto por padrao, recolhe no toque (escolha do usuario 2026-08-04). null = shape
  // desconhecido -> comportamento de sempre (pre com o result).
  const editEdits = $derived(extractEdits(event.tool_name, event.tool_input));
  const editPath = $derived(extractFilePath(event.tool_input));
  // svelte-ignore state_referenced_locally -- o valor inicial E a decisao (aberto por padrao pra
  // Edit/MultiEdit); o componente e recriado por evento (key do each no MessageList), nao reage.
  let expanded = $state(!!extractEdits(event.tool_name, event.tool_input));

  // Imagem (ou midia/doc) que o Claude LEU: o transcript dropa o bloco image do tool_result, mas o
  // path do Read esta citado na conversa -> serve pelo /file (parseFilePaths filtra por extensao
  // conhecida, entao codigo/.md nao vira anexo). Reusa a mesma trava + componente do chat.
  const fileRefs = $derived(
    (event.tool_name ?? '').toLowerCase() === 'read'
      ? parseFilePaths(String((event.tool_input as Record<string, unknown> | null)?.['file_path'] ?? (event.tool_input as Record<string, unknown> | null)?.['path'] ?? ''))
      : []
  );

  const phase = $derived(toolPhase(result));

  // Comando do hangar (hangar-send e cia): vira cartão próprio — o que aconteceu, não a linha de
  // comando. Só depois que o resultado chega: com o comando ainda rodando não há o que ler, e o
  // card de Bash de sempre já mostra "executando".
  const comandoBash = $derived(
    event.tool_name === 'Bash'
      ? String((event.tool_input as Record<string, unknown> | null)?.['command'] ?? '')
      : '',
  );
  // `SendMessage`/`ListAgents` são a MESMA conversa entre sessões, por outra via (socket do Claude
  // Code em vez do comando do hangar) — logo, o mesmo cartão. O `via` do resultado é o que muda o
  // ícone lá dentro.
  const hangarAcao = $derived(
    result
      ? lerComandoHangar(comandoBash, String(result.result ?? ''), phase === 'error') ??
        lerFerramentaClaude(event.tool_name, event.tool_input, String(result.result ?? ''), phase === 'error')
      : null,
  );
  const duracao = $derived(
    result?.ts && event.ts ? Math.max(0, (result.ts - event.ts) * 1000) : null,
  );
  const hora = $derived(
    event.ts ? new Date(event.ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null,
  );
  // Servidor da rota atual — sem ele o botão "abrir sessão" não teria pra onde ir (ex.: card
  // renderizado fora de uma rota de chat), e aí ele nem aparece.
  const servidorAtual = $derived(location.hash.match(/^#\/(?:chat|board|canvas)\/([^/]+)\//)?.[1] ?? null);
  // O alvo do recado é um ENDEREÇO (`servidor::sessao`, nome de subagente, ...), não um nome de
  // sessão do app. `rotaDoAlvo` só devolve rota quando existe mesmo aquela sessão — ver lib/alvoSessao.
  // Sem retain() no store de propósito: quem o mantém vivo é a Sidebar/SessionList da tela, e um
  // cartão de mensagem não pode abrir stream (o navegador corta em ~6 por host).
  function rotaDe(nome: string) {
    return rotaDoAlvo(nome, sessionsStore.byServer, servidorAtual);
  }
  function podeAbrir(nome: string): boolean {
    return rotaDe(nome) !== null;
  }
  function abrirSessao(nome: string) {
    const r = rotaDe(nome);
    if (r) location.hash = `#/chat/${r.serverId}/${encodeURIComponent(r.nome)}`;
  }
  // Erro mostra o TEXTO do erro (o diff esconderia a mensagem que importa).
  const showDiff = $derived(!!editEdits && phase !== 'error');
  // Read: resultado de codigo com highlight (escolha do usuario 2026-08-04). Imagem lida NAO passa
  // aqui — o resultado dela e curto ("Read image file...") e o anexo ja vai por FileAttachment.
  const isRead = $derived(
    (event.tool_name ?? '').toLowerCase() === 'read' && fileRefs.length === 0
  );

  // Saída de COMANDO que é código (cat/sed/head/tail/grep num arquivo) merece o mesmo visualizador
  // do Read, não um <pre> cinza: é código igual, e realce é o que faz dar pra ler. O caminho sai do
  // próprio comando — o ReadView só precisa dele pra escolher a linguagem. Regra estreita de
  // propósito (ver codeFromBash.ts): realce errado é pior que realce nenhum.
  const caminhoDoComando = $derived(
    event.tool_name === 'Bash'
      ? caminhoDeCodigoNoComando(String((event.tool_input as Record<string, unknown> | null)?.['command'] ?? ''))
      : null
  );
  // Último recurso: o comando não revelou o alvo (composto, com pipe) mas a SAÍDA parece código.
  // Detecção por conteúdo, conservadora — na dúvida devolve null e o texto sai cru (detectarLinguagem.ts).
  // Só entra quando os dois caminhos acima falharam, e nunca sobrepõe um caminho de verdade.
  const caminhoPorConteudo = $derived(
    !editPath && !caminhoDoComando && phase !== 'error' && result?.result
      ? pseudoCaminhoPorConteudo(result.result)
      : null
  );
  // Caminho pro realce, em ordem de confiança: o do Read > o que o comando revelou > o adivinhado.
  const caminhoRealce = $derived(editPath || caminhoDoComando || caminhoPorConteudo || '');
  const temRealce = $derived(
    (isRead || !!caminhoDoComando || !!caminhoPorConteudo) && phase !== 'error'
  );

  const summary = $derived(summarizeToolInput(event.tool_name, event.tool_input));

  // Ferramenta de arquivo mostra só o nome com o ícone do tipo; o caminho inteiro está no detalhe.
  const arquivo = $derived.by(() => {
    const t = event.tool_name ?? '';
    if (!['Read', 'NotebookRead', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write'].includes(t)) return '';
    const p = editPath || String((event.tool_input as Record<string, unknown> | null)?.['notebook_path'] ?? '');
    return p.split(/[\\/]/).filter(Boolean).pop() ?? '';
  });
  const totaisEdicao = $derived.by(() => {
    if (!editEdits) return null;
    let add = 0, del = 0;
    for (const e of editEdits) {
      const d = computeEditDiff(e.oldText, e.newText);
      add += d.add;
      del += d.del;
    }
    return { add, del };
  });

  // Desfecho na 2a linha ("Pronto (38 linhas)" / "320 linhas carregadas" / 1a linha do erro).
  // Enquanto roda nao ha resultado -> a linha mostra o proprio estado.
  const outcome = $derived(summarizeToolResult(result, event.tool_name) || 'Executando…');

  // Bash com run_in_background retorna NA HORA (vira shell destacado) -> "Pronto" engana. Marca
  // como background; a saida viva chega depois pelos cards de BashOutput (o agente puxa via bash_id).
  const isBackground = $derived(
    event.tool_name === 'Bash' && (event.tool_input as Record<string, unknown> | null)?.['run_in_background'] === true
  );
</script>

<!-- O DETALHE e identico nas duas peles: e o mesmo dado, so a moldura muda. Snippet pra existir uma
     vez so — duplicar estas tres pontas era o jeito de a pele nova perder o diff ou o erro. -->
{#snippet detalhe()}
  {#if showDiff && editEdits}
    <div class="row-result row-result--diff" use:rolagemSoAoClicar>
      <EditDiff path={editPath} edits={editEdits} />
    </div>
  {:else if temRealce && result?.result}
    <div class="row-result" use:rolagemSoAoClicar>
      <ReadView path={caminhoRealce} text={result.result} />
    </div>
  {:else if result?.result}
    <div class="row-result" use:rolagemSoAoClicar>
      <pre>{result.result}</pre>
    </div>
  {/if}
{/snippet}

{#if hangarAcao}
  <HangarCommandCard
    acao={hangarAcao}
    comando={comandoBash}
    saida={String(result?.result ?? '')}
    {duracao}
    {hora}
    onAbrirSessao={servidorAtual ? abrirSessao : undefined}
    {podeAbrir}
  />
{:else if soDetalhe}
  <!-- Só o DETALHE (diff, saída, imagem), sem a linha de identificação: quem chama já desenhou a
       chamada com as próprias palavras — é o caso da pele 'fluxo', onde a linha é "Editei
       ToolGroup.svelte +0 −4" e repetir "Edit /caminho/inteiro" logo abaixo dela seria a mesma
       informação duas vezes, uma delas pior. -->
  <div class="tc-detail tc-detail--solto">
    {#if phase !== 'error'}<div class="tc-desfecho">{outcome}</div>{/if}
    {@render detalhe()}
  </div>
{:else if toolLook.look === 'chips'}
  <!-- Pele 'chips' no desenho de lista de trabalho: verbo + alvo numa caixinha + desfecho, tudo numa
       linha. Dentro de um grupo o conector em L faz o papel do glifo, que só volta enquanto a
       chamada roda ou quando falha — é o que precisa chamar o olho. -->
  <div class="tc" class:noanim={!animate} class:tc--error={phase === 'error'} class:tc--grupo={emGrupo}
       class:tc--ultimo={ultimo}>
    <button
      type="button"
      class="tc-row"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {#if !emGrupo || phase !== 'done' || escrevendo}
        <span class="tc-glyph" data-phase={phase} class:vivo={phase === 'pending'}>
          <ToolGlyph tool={event.tool_name} />
        </span>
      {/if}
      <span class="tc-label">{toolVerbo(event.tool_name)}</span>
      {#if isBackground}<span class="tr-badge">{m.tool_background()}</span>{/if}
      {#if arquivo}
        <span class="tc-chip"><FileIcon nome={arquivo} /><span class="tc-chip-txt">{arquivo}</span></span>
      {:else if summary}
        <span class="tc-chip tc-chip--cmd"><span class="tc-chip-txt">{summary}</span>{#if escrevendo}<i class="tc-caret"></i>{/if}</span>
      {/if}
      {#if escrevendo}
        <span class="tc-fim">{m.tool_fase_escrevendo()}</span>
      {:else if phase === 'pending'}
        <span class="tc-fim tc-brilho">{m.tool_fase_rodando()}</span>
      {:else if phase === 'error'}
        <span class="tc-erro">{outcome}</span>
      {:else if totaisEdicao}
        <span class="tc-fim"><span class="tc-add">+{totaisEdicao.add}</span>{#if totaisEdicao.del} <span class="tc-del">−{totaisEdicao.del}</span>{/if}</span>
      {:else}
        <span class="tc-fim">{outcome}</span>
      {/if}
    </button>

    <!-- grid 0fr -> 1fr: a altura anima sozinha, sem medir nada no JS. -->
    <div class="tc-wrap" style:grid-template-rows={expanded ? '1fr' : '0fr'} style:opacity={expanded ? 1 : 0}>
      <div class="tc-clip">
        <div class="tc-detail">
          {@render detalhe()}
        </div>
      </div>
    </div>
  </div>
{:else}
<!-- Bloco de DUAS linhas (layout do Pi): "● Bash <arg>" / "└ Pronto (38 linhas) • toque para ver".
     A linha 2 nao usa o caractere └: o corner e desenhado em CSS (border), que alinha na bolinha em
     qualquer fonte/tamanho e nunca cai num glifo de fallback torto. -->
<div
  class="tool-row"
  class:noanim={!animate}
  class:tool-row--error={phase === 'error'}
  role="button"
  tabindex="0"
  aria-expanded={expanded}
  onclick={() => (expanded = !expanded)}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; } }}
>
  <div class="tr-call">
    <span class="tr-dot" class:pending={phase === 'pending'} data-phase={phase} aria-hidden="true"></span>
    <span class="tr-name">{event.tool_name ?? m.formato_tool_generico()}</span>
    {#if isBackground}<span class="tr-badge">{m.tool_background()}</span>{/if}
    {#if summary}<span class="tr-arg" class:open={expanded}>{summary}</span>{/if}
  </div>

  <div class="tr-out">
    <span class="tr-elbow" aria-hidden="true"></span>
    <span class="tr-outcome">{outcome}</span>
    {#if result?.result || showDiff}
      <span class="tr-hint">
        <span class="sep" aria-hidden="true">•</span>
        <span class="coarse">{expanded ? m.tool_toque_ocultar() : m.tool_toque_ver()}</span><span
              class="fine">{expanded ? m.tool_clique_ocultar() : m.tool_clique_ver()}</span>
      </span>
    {/if}
  </div>

  {#if expanded}{@render detalhe()}{/if}
</div>
{/if}

{#if fileRefs.length}<FileAttachment {sessionName} refs={fileRefs} />{/if}

<style>
  /* ─── pele 'chips' ─────────────────────────────────────────────────────────
     Superfícies pelos tokens (--surface-raised), NUNCA --bg-* cru: com papel de
     parede ligado, um bg cru vira retângulo chapado boiando e não acompanha o
     slider de Transparência. O chip é a única superfície própria aqui. */
  /* Sem margem própria: quem espaça é o grupo (.tg-body--chips, gap 4px). Solta no fluxo (chamada
     única, fora de grupo) a margem volta pelo :only-child abaixo. */
  .tc { animation: bubble-in 180ms ease-out both; }
  .tc.noanim { animation: none; }
  .tc:only-child { margin-bottom: var(--space-1); }

  /* Medidas do original: linha de 28px, gap de 8px, respiro de 3px nas laterais. */
  .tc-row {
    display: flex;
    align-items: center;
    /* EXPLÍCITO: o app tem regra global de button com justify-content:center, e sem isto o conteúdo
       da linha nascia centrado — 112px de recuo fantasma numa coluna larga. */
    justify-content: flex-start;
    gap: 8px;
    width: calc(100% + 6px);
    min-height: 28px;
    min-width: 0;
    padding: 0 3px;
    margin: 0 -3px;
    border: none;
    background: transparent;
    border-radius: 8px;
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
    transition: background-color 100ms var(--ease-out);
  }
  /* Sem faixa opaca no hover: com papel de parede ela virava um bloco escuro atravessando a linha,
     que é justamente o que destoava do tema. Quem sinaliza o hover é o chip perdendo a caixa. */

  .tc-glyph {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--text-muted);
  }
  .tc-glyph[data-phase='pending'] { color: var(--accent); }
  .tc-glyph[data-phase='error']   { color: var(--error); }
  .tc-glyph.vivo { animation: tc-respira 1.8s ease-in-out infinite; }
  @keyframes tc-respira {
    0%, 100% { opacity: 0.45; }
    50%      { opacity: 1; }
  }

  .tc-label {
    flex-shrink: 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .tc-row:hover .tc-label { color: var(--text-secondary); }
  .tc:has(.tc-glyph.vivo) .tc-label { color: var(--text-primary); }

  /* Caixinha do tamanho do alvo, com teto: comprida demais ela atravessava a conversa. */
  .tc-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    max-width: 360px;
    height: 20px;
    padding: 0 6px 0 4px;
    border-radius: 5px;
    background: var(--fill-subtle);
    box-shadow: 0 0 0 1px var(--border-subtle);
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
  }
  .tc-chip :global(.fi) { width: 14px; height: 14px; }
  .tc-chip--cmd { padding-left: 6px; }
  .tc-chip-txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tc-row:hover .tc-chip { color: var(--text-primary); }

  .tc-caret {
    flex-shrink: 0;
    width: 6px;
    height: 11px;
    margin-left: 1px;
    background: var(--accent);
    animation: tc-pisca 1s steps(1) infinite;
  }
  @keyframes tc-pisca { 50% { opacity: 0; } }

  .tc-fim {
    flex-shrink: 0;
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tc-add { color: var(--success); }
  .tc-del { color: var(--error); margin-left: 4px; }
  .tc-brilho {
    background-image:
      linear-gradient(90deg, transparent calc(50% - 22px), var(--text-primary) 50%, transparent calc(50% + 22px)),
      linear-gradient(var(--accent), var(--accent));
    background-size: 250% 100%, auto;
    background-repeat: no-repeat;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: tc-varre 1.6s linear infinite;
  }
  @keyframes tc-varre {
    from { background-position: 100% center; }
    to   { background-position: 0% center; }
  }

  .tc-erro {
    min-width: 0;
    max-width: 45%;
    font-size: 11.5px;
    color: var(--error);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Linha de grupo: conector em L até a linha, e o tronco segue até a próxima (menos na última). */
  .tc--grupo { position: relative; padding-left: 22px; }
  .tc--grupo::before {
    content: '';
    position: absolute;
    left: 7px;
    top: 0;
    height: 14px;
    width: 10px;
    border-left: 1px solid var(--border-default);
    border-bottom: 1px solid var(--border-default);
    border-bottom-left-radius: 5px;
  }
  .tc--grupo:not(.tc--ultimo)::after {
    content: '';
    position: absolute;
    left: 7px;
    top: 14px;
    bottom: 0;
    border-left: 1px solid var(--border-default);
  }

  @media (prefers-reduced-motion: reduce) {
    .tc-glyph.vivo, .tc-caret, .tc-brilho { animation: none; }
    .tc-brilho { background: none; color: var(--accent); }
  }

  .tc-wrap {
    display: grid;
    transition: grid-template-rows 300ms cubic-bezier(0.23, 1, 0.32, 1), opacity 300ms var(--ease-out);
  }
  .tc-clip { min-height: 0; overflow: hidden; }
  .tc-detail { padding-top: var(--space-1); margin-left: 8px; }
  /* Solto (soDetalhe): quem chama já deu a margem à esquerda, e o fade entra porque aqui não há a
     animação de altura do wrapper que o cartão inteiro tem. */
  .tc-detail--solto { margin-left: 0; animation: fade-up 260ms var(--ease-out) both; }

  /* ─── pele clássica ─────────────────────────────────────────────────────── */
  .tool-row {
    padding: var(--space-1) 0;
    margin-bottom: var(--space-1);
    cursor: pointer;
    animation: bubble-in 180ms ease-out both;
  }

  /* Historico remontado (paginacao/janela): entra parado. */
  .tool-row.noanim { animation: none; }

  /* Linha 1: bolinha + nome + argumento. */
  .tr-call {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  /* A bolinha carrega o mesmo vocabulario de estado do resto do app: accent = rodando,
     success = concluiu, error = falhou. */
  .tr-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    align-self: center;
    background: var(--success);
  }
  .tr-dot[data-phase='pending'] { background: var(--accent); }
  .tr-dot[data-phase='error']   { background: var(--error); }
  /* Pulso no lugar do antigo spinner ⟳ (mesma informacao, sem roubar largura da linha). */
  .tr-dot.pending { animation: pulse-scale 1.2s ease-in-out infinite; }

  .tr-name {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .tr-arg {
    min-width: 0;
    font-family: var(--font-mono);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Expandido, o argumento cortado no "…" aparece inteiro (o comando longo e metade do porque). */
  .tr-arg.open { white-space: pre-wrap; overflow: visible; word-break: break-all; }

  .tr-badge {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    color: var(--accent);
    background: var(--accent-dim);
  }

  /* Linha 2: corner + desfecho + dica. */
  .tr-out {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--text-muted);
  }

  /* O "└" desenhado: sobe ate a bolinha da linha de cima e vira pra direita. */
  .tr-elbow {
    flex-shrink: 0;
    width: 6px;
    height: 8px;
    margin-right: 2px;
    align-self: flex-start;
    border-left: 1px solid var(--border-default);
    border-bottom: 1px solid var(--border-default);
    border-bottom-left-radius: 3px;
  }

  .tr-outcome {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Dica de expandir: some primeiro quando a linha aperta (o desfecho vale mais). */
  .tr-hint {
    flex-shrink: 1000;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    color: var(--text-muted);
    opacity: 0.7;
  }
  .tr-hint .sep { margin-right: 4px; }
  /* "toque" com dedo, "clique" com mouse — o app nao tem atalho de teclado pra isto, entao a dica
     nao inventa um. */
  .fine { display: inline; }
  .coarse { display: none; }
  @media (pointer: coarse) {
    .fine { display: none; }
    .coarse { display: inline; }
  }

  .tool-row--error .tr-outcome { color: var(--error); }

  .row-result {
    margin-top: var(--space-2);
    margin-left: 14px;
    max-height: 240px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    border-left: 2px solid var(--border-default);
    padding-left: var(--space-3);
  }

  .row-result pre {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* O diff ja tem a propria moldura/superficie — sem a bordinha lateral do resultado cru, e sem
     o teto de 240px (o EditDiff tem o proprio scroll interno). */
  .row-result--diff {
    border-left: none;
    padding-left: 0;
    max-height: none;
    overflow-y: visible;
  }
</style>
