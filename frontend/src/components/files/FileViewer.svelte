<script lang="ts">
  import * as m from '../../paraglide/messages';
  import { mensagemDeErro } from '@hangar/core';
  import type { PathDiff, FileContent } from '@hangar/core';
  import { highlightDiff, highlightCodeLines, type DiffRow, type DiffToken } from '../../lib/highlightLazy';
  import { dec } from '../../lib/fmt';
  import DiffView from '../git/DiffView.svelte';
  import CodeEditor from './CodeEditor.svelte';

  interface Props {
    path: string;
    linha?: number | null;
    diff: PathDiff | null;
    conteudo: FileContent | null;
    loading: boolean;
    onEscopo: (e: 'branch' | 'nao_commitado') => void;
    onFechar: () => void;
    // Rotulo do link de saida (B4, Task 12): no desktop o arquivo cobre a conversa e o default
    // diz exatamente isso; no modal Git do celular nao ha conversa atras — o hospedeiro passa
    // um rotulo que descreve a tela real (m.comum_voltar).
    rotuloVoltar?: string;
    // Erro da abertura (B3, Task 12): quando a leitura falha (binario, 404), o store grava o
    // aviso aqui e o visor o mostra com role="alert" em vez de desmontar. Opcional de
    // proposito: o host desktop do Chat nao passa (o fluxo de erro dele e outro).
    erro?: string | null;
    // Gravar é do hospedeiro (quem tem o store). Sem esta prop o visor é só leitura — é o que
    // acontece na aba de commit, onde o arquivo mostrado é o de um commit passado, não o do disco.
    onSalvar?: ((texto: string) => Promise<string | null>) | null;
    // Faixa de abas. Vazia (default) = o visor desenha uma aba só, com o arquivo atual — é o que
    // o modal Git e o celular usam, e o que mantém este componente utilizável sem o store.
    abas?: { path: string; sujo: boolean; falhou?: boolean }[];
    onAtivarAba?: ((p: string) => void) | null;
    onFecharAba?: ((p: string) => void) | null;
    onTrocarAba?: ((passo: number) => void) | null;
    // Texto digitado e não gravado, guardado pelo hospedeiro por aba: trocar de aba e voltar tem
    // que devolver o que estava escrito. `null` = nada digitado desde a última leitura.
    rascunho?: string | null;
    onRascunho?: ((t: string | null) => void) | null;
    // Erro da última gravação DESTA aba, guardado pelo hospedeiro por caminho. Não pode ser
    // estado deste componente: existe um só para todas as abas, e trocar de `path` apagava o
    // aviso de uma gravação que falhou de verdade.
    erroSalvar?: string | null;
    // Gravação em voo DESTA aba, também do hospedeiro: como estado deste componente, ela era
    // zerada ao trocar de `path`, e voltar para a aba destravava o botão no meio da gravação.
    salvando?: boolean;
  }
  let {
    path, linha = null, diff, conteudo, loading, onEscopo, onFechar,
    rotuloVoltar = m.arq_voltar_conversa(), erro = null, onSalvar = null,
    abas = [], onAtivarAba = null, onFecharAba = null, onTrocarAba = null,
    rascunho = null, onRascunho = null, erroSalvar = null, salvando = false,
  }: Props = $props();

  // Linhas do diff já destacadas. highlightDiff é assíncrona (import dinâmico do Shiki).
  // A flag `valida` do $effect descarta resposta velha — escopo trocado, diff novo ou o
  // componente desmontado no meio da busca; sem ela a resposta anterior sobrescreve a nova.
  let rows: DiffRow[] = $state([]);

  // Qual TEXTO de diff já está em `rows`. Derivar "está destacando" disto (em vez de um $state
  // ligado dentro do $effect) tira o quadro inicial em que rows=[] e destacando=false — nele o
  // DiffView desenhava "sem diferenças" para um arquivo que tem diff.
  let destacadoDe: string | null = $state(null);

  // Payload de OUTRO arquivo nao desenha: entre `abrir(b)` e a resposta, o store ainda tem o
  // conteudo de `a` (ele so troca quando a resposta chega), e a tela mostrava o arquivo errado
  // sob o nome certo. `path` no FileContent/PathDiff existe exatamente pra isso.
  const doArquivo = $derived(conteudo !== null && conteudo.path === path ? conteudo : null);
  const diffDoArquivo = $derived(diff !== null && diff.path === path ? diff : null);

  // Diff VAZIO nao e diff: o path_diff responde "" para arquivo sem alteracao no escopo, e nesse
  // caso quem o usuario quer ver e o arquivo.
  const temDiff = $derived(diffDoArquivo !== null && diffDoArquivo.diff.trim() !== '');

  const destacando = $derived(temDiff && diffDoArquivo !== null && destacadoDe !== diffDoArquivo.diff);

  // O que está NA TELA é o escopo_usado. Quando ele diverge do pedido, o outro escopo é
  // impossível (a base não existe) — botão desabilitado, mas com o rótulo do que está sendo
  // mostrado e o motivo em TEXTO (title de botão desabilitado não é lido por ninguém).
  const caiu = $derived(diffDoArquivo !== null && diffDoArquivo.escopo_usado !== diffDoArquivo.escopo_pedido);

  // Motivo do escopo caido chega do backend como CODIGO (chave `arq_*`) e vira texto pela MESMA
  // via dos erros (mensagemDeErro). Codigo desconhecido devolve undefined e a tela nao desenha
  // nada — nem quebra nem mostra o codigo cru. Sem isto o motivo vinha em portugues no app em ingles.
  const motivoVisivel = $derived(
    caiu && diffDoArquivo !== null && diffDoArquivo.motivo !== null
      ? (mensagemDeErro(diffDoArquivo.motivo) ?? null)
      : null,
  );

  $effect(() => {
    const d = diffDoArquivo;
    let valida = true;
    if (d === null || d.diff.trim() === '') {
      rows = [];
      destacadoDe = null;
      return () => { valida = false; };
    }
    rows = [];
    highlightDiff(d.diff, path).then((r) => {
      if (!valida) return;
      rows = r;
      destacadoDe = d.diff;
    }).catch(() => {
      if (!valida) return;
      rows = [];
      destacadoDe = d.diff;   // desiste desta versão: não fica preso em "carregando"
    });
    return () => { valida = false; };
  });

  // ── Arquivo sem diff: mesmas duas peças do diff, pro conteúdo ────────────────
  // Tokens por linha do arquivo ([] = mostra plano, que é também o estado "ainda destacando").
  let tokensArquivo: DiffToken[][] = $state([]);
  // Qual TEXTO já está em `tokensArquivo` — o arquivo pode trocar sem o componente remontar.
  let destacadoDeTexto: string | null = $state(null);

  const linhas = $derived(doArquivo !== null ? linhasDe(doArquivo.text) : []);
  // Largura da calha em dígitos (mínimo 2 pra não pular de largura em arquivo de <10 linhas).
  const digitosCalha = $derived(Math.max(2, String(linhas.length).length));

  const destacandoArquivo = $derived(!temDiff && doArquivo !== null && destacadoDeTexto !== doArquivo.text);

  $effect(() => {
    const f = doArquivo;
    let valida = true;
    if (f === null || temDiff) {
      tokensArquivo = [];
      destacadoDeTexto = null;
      return () => { valida = false; };
    }
    const texto = f.text;
    tokensArquivo = [];
    highlightCodeLines(linhasDe(texto), path).then((t) => {
      if (!valida) return;
      // null = sem destaque possível (.txt, grammar que falhou, arquivo acima do teto interno):
      // texto plano COM a calha, nunca erro na tela.
      tokensArquivo = t ?? [];
      destacadoDeTexto = texto;
    }).catch(() => {
      if (!valida) return;
      tokensArquivo = [];
      destacadoDeTexto = texto;   // desiste desta versão: não fica preso em "carregando"
    });
    return () => { valida = false; };
  });

  // +N −M contado das linhas destacadas (a mesma conta do cabeçalho interno do DiffView).
  const estat = $derived({
    add: rows.filter((r) => r.kind === 'add').length,
    del: rows.filter((r) => r.kind === 'del').length,
  });

  // Caminho quebrado em pasta + nome: a pasta sai em --text-muted, o nome no tom normal.
  // $derived de propósito: trocar de arquivo sem remontar o componente tem que trocar o cabeçalho.
  const ultimaBarra = $derived(path.lastIndexOf('/'));
  const nomeArquivo = $derived(ultimaBarra === -1 ? path : path.slice(ultimaBarra + 1));
  const dirParte = $derived(ultimaBarra === -1 ? '' : path.slice(0, ultimaBarra + 1));
  // "backend / app" — separadores com folga, sem a barra final. O nome do arquivo não entra:
  // ele já está na aba, e repeti-lo aqui foi uma das coisas que o refino tirou.
  // No mock, o texto à direita é a BASE ("desde 9139ad7") — o que a tela está comparando, não o
  // nome do modo. O nome do escopo fica no title, junto do convite pra trocar.
  const rotuloEscopo = $derived(
    diffDoArquivo?.base && diffDoArquivo.base.trim() !== ''
      ? m.arq_escopo_desde({ base: diffDoArquivo.base.slice(0, 7) })
      : (diffDoArquivo?.escopo_usado === 'branch' ? m.arq_escopo_branch() : m.arq_escopo_nao_commitado()),
  );
  const dirLegivel = $derived(dirParte === '' ? '.' : dirParte.replace(/\/$/, '').split('/').join(' / '));


  // Tamanho binário na vírgula do idioma do app (dec usa intlLocale): "12,4 KB" casa com a
  // barra; abaixo de 1 KB mostra os bytes crus.
  function tamLegivel(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${dec(n / 1024, 1)} KB`;
    return `${dec(n / (1024 * 1024), 1)} MB`;
  }

  // Linhas do arquivo, sem a linha fantasma do \n final. Serve pra contagem da meta E pro visor
  // (calha + destaque), que precisam concordar linha a linha.
  function linhasDe(texto: string): string[] {
    return texto === '' ? [] : texto.replace(/\n$/, '').split('\n');
  }

  function linhasDoTexto(texto: string): number {
    return linhasDe(texto).length;
  }

  // Plural correto da meta: arq_meta_arquivo diz "N linhas" e o Paraglide deste projeto nao tem
  // plural ICU — a chave arq_meta_arquivo_um cobre o caso de 1 linha ("1 linhas" nao existe).
  const metaArquivo = $derived(
    doArquivo
      ? linhasDoTexto(doArquivo.text) === 1
        ? m.arq_meta_arquivo_um({ tam: tamLegivel(doArquivo.size) })
        : m.arq_meta_arquivo({ tam: tamLegivel(doArquivo.size), linhas: linhasDoTexto(doArquivo.text) })
      : null,
  );
  // Alterações × arquivo inteiro. Estado LOCAL: é escolha de leitura, não de dados — o backend
  // manda os dois (o texto atual e o da base) na mesma resposta.
  let verArquivo = $state(false);
  $effect(() => { void path; verArquivo = linha !== null; });

  // ── edição ────────────────────────────────────────────────────────────────────────────────
  // Não há modo de edição: quem pode gravar já digita. O botão de lápis existia só pra ligar um
  // estado que não precisava existir, e cobrava um clique antes de cada correção de uma linha.
  let salvoAgora = $state(false);
  // Já vem traduzida do api.ts; `mensagemDeErro` cobre o caso de o store ter guardado um código.
  const erroSalvarVisivel = $derived(erroSalvar ? (mensagemDeErro(erroSalvar) ?? erroSalvar) : null);
  // Sem digest não há gravação (leitura truncada): deixar digitar seria oferecer algo que o
  // backend recusa de propósito.
  const podeEditar = $derived(onSalvar !== null && doArquivo !== null && doArquivo.digest !== null);
  const sujo = $derived(rascunho !== null && doArquivo !== null && rascunho !== doArquivo.text);
  // O que vai no editor: o rascunho quando existe, o disco quando não.
  const textoNoEditor = $derived(rascunho ?? doArquivo?.text ?? '');

  // A base do diff embutido. `undefined` (campo ausente, backend antigo) vira null: sem base o
  // editor mostra só o arquivo, que é o certo — nunca um diff inventado.
  // Base VAZIA (arquivo novo) também vira null: comparar com "" pinta o arquivo inteiro de verde,
  // o que a barra já diz em `+N −0`, e ainda desenha um trecho removido fantasma — a linha vazia
  // da string vazia, uma tira vermelha de 22px no topo (visto ao vivo no tsconfig.json novo).
  const baseDoDiff = $derived(
    diffDoArquivo?.original && diffDoArquivo.original !== '' ? diffDoArquivo.original : null,
  );
  // O editor só assume a leitura quando temos o conteúdo do disco. Arquivo truncado continua
  // aparecendo (sem diff embutido): cortar a tela seria pior que mostrar o começo.
  const podeUsarEditor = $derived(doArquivo !== null);

  // Trocar de arquivo zera só o "✓ Salvo", que é um pisca da tela. Rascunho, erro de gravação e
  // "gravando agora" são do hospedeiro, por aba — voltar a uma aba tem que devolver o que estava
  // escrito nela, por que ela não gravou, e se ela ainda está gravando.
  $effect(() => {
    void path;
    salvoAgora = false;
  });

  async function salvar() {
    if (!onSalvar || !sujo || salvando) return;
    // O arquivo em que este salvamento começou. Trocar de arquivo com a gravação em voo é
    // possível (nada na árvore impede), e sem esta guarda a resposta antiga aterrissava na tela
    // do arquivo novo: o "✓ Salvo" de A fechava a edição de B e sumia com o rastro do que estava
    // sendo digitado. Falha e "gravando" não dependem desta guarda: quem os registra é o store,
    // por caminho.
    const meu = path;
    const falha = await onSalvar(textoNoEditor);
    if (meu !== path || falha) return;
    salvoAgora = true;
    onRascunho?.(null);
    setTimeout(() => { if (meu === path) salvoAgora = false; }, 2000);
  }

  // Descartar apaga o rascunho; o hospedeiro solta o erro de gravação junto, porque a tentativa
  // que falhou era daquele texto.
  function descartar() {
    onRascunho?.(null);
  }

  // Atalhos do visor inteiro, ligados em CAPTURA no elemento raiz. Captura e não `onkeydown`
  // porque o CodeMirror trata o keydown no próprio conteúdo: com o cursor no código, o atalho
  // declarado no template nunca chegava (medido ao vivo — Ctrl+PageDown trocava de aba com o
  // foco na faixa e não fazia nada com o foco no editor). Daqui vale para os dois, num lugar só,
  // e sem duplicar binding dentro do CodeMirror.
  let visorEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const el = visorEl;
    if (!el) return;
    el.addEventListener('keydown', atalhosDoVisor, true);
    return () => el.removeEventListener('keydown', atalhosDoVisor, true);
  });

  function atalhosDoVisor(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void salvar();
      return;
    }
    if (e.altKey && !mod && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (onFecharAba) onFecharAba(path); else onFechar();
      return;
    }
    if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault();
      onTrocarAba?.(e.key === 'PageDown' ? 1 : -1);
    }
  }

  // Ordem de aba pro Alt+1..9 e pro title: o hospedeiro manda a lista, mas sem ela o visor ainda
  // desenha a aba do arquivo atual — é como o modal do Git e o celular montam este componente.
  const faixa = $derived(abas.length > 0 ? abas : [{ path, sujo, falhou: erroSalvar !== null }]);
  function nomeDe(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
  }

</script>

<div class="visor" role="region" tabindex="-1" aria-label={path} bind:this={visorEl}
     aria-busy={loading || destacando || destacandoArquivo}>
  <!-- Faixa de abas — desenho C (mock aprovado em 20/08/2026, docs: mock-refino-C.png), agora
       com a lista inteira em vez de um rótulo só. Rola na horizontal: seis arquivos abertos não
       podem espremer o nome de nenhum nem empurrar as ações pra fora da tela. -->
  <div class="abas">
    <div class="faixa" role="tablist" aria-label={m.arq_abas()}>
      {#each faixa as aba (aba.path)}
        <span class="aba" class:ativa={aba.path === path}>
          <button
            class="aba-nome"
            role="tab"
            aria-selected={aba.path === path}
            title={aba.path === path && metaArquivo ? `${aba.path} · ${metaArquivo}` : aba.path}
            onclick={() => aba.path !== path && onAtivarAba?.(aba.path)}
          >{nomeDe(aba.path)}</button>
          <!-- Ponto vermelho quando a gravação falhou: com a mesma cor dos dois, uma aba que
               recusou gravar era indistinguível de uma que ainda não tentou, e o usuário podia
               fechá-la achando que só faltava salvar. -->
          {#if aba.falhou}
            <span class="ponto falhou" title={m.arq_falhou_salvar()}></span>
          {:else if aba.sujo}
            <span class="ponto" title={m.arq_nao_salvo()}></span>
          {/if}
          <button
            class="fechar-aba"
            aria-label={m.arq_fechar_aba({ nome: nomeDe(aba.path) })}
            title={m.arq_atalho_fechar()}
            onclick={() => (onFecharAba ? onFecharAba(aba.path) : onFechar())}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </span>
      {/each}
    </div>
    <span class="empurra"></span>
    <!-- O segmento só existe quando HÁ o que comparar. Preso em `temDiff`, ele aparecia em
         arquivo novo (que tem diff textual mas base vazia) oferecendo duas vistas idênticas. -->
    {#if baseDoDiff !== null && doArquivo && baseDoDiff !== doArquivo.text}
      <span class="seg" role="group" aria-label={m.arq_ver_como()}>
        <button class:on={!verArquivo} onclick={() => (verArquivo = false)}>{m.arq_ver_alteracoes()}</button>
        <button class:on={verArquivo} onclick={() => (verArquivo = true)}>{m.arq_ver_arquivo()}</button>
      </span>
    {/if}
    {#if salvoAgora}
      <span class="salvo">✓ {m.arq_salvo()}</span>
    {:else if podeEditar && sujo}
      <!-- Só aparece com texto não gravado: sem nada digitado, um "Salvar" apagado ali só
           ocuparia a faixa e sugeriria que a edição precisa ser ligada. -->
      <button class="acao" onclick={descartar}>{m.arq_descartar()}</button>
      <button class="acao primaria" disabled={salvando} onclick={salvar} title={m.arq_atalho_salvar()}>
        {salvando ? m.arq_salvando() : m.arq_salvar()}
      </button>
    {/if}
  </div>

  <div class="subbarra">
    <span class="caminho">{dirLegivel}</span>
    {#if diffDoArquivo && !loading && !destacando && (estat.add || estat.del)}
      <span class="stat"><span class="stat-add">+{estat.add}</span><span class="stat-del">−{estat.del}</span></span>
    {/if}
    {#if diffDoArquivo}
      {@const d = diffDoArquivo}
      <span class="divisor"></span>
      <button
        class="escopo"
        disabled={caiu}
        title={m.arq_trocar_escopo()}
        onclick={() => onEscopo(d.escopo_usado === 'branch' ? 'nao_commitado' : 'branch')}
      >{rotuloEscopo}</button>
      {#if motivoVisivel}<span class="motivo">{motivoVisivel}</span>{/if}
    {/if}
    <!-- Saída em TEXTO só no celular: lá o ✕ de 20px da aba é alvo apertado e o caminho de volta
         precisa estar escrito. No desktop ele sai (o mock aprovado não tem) e o ✕ basta. -->
    <button class="voltar" onclick={onFechar}>← {rotuloVoltar}</button>
  </div>

  <div class="corpo">
    {#if erro}
      <!-- O erro da abertura fica NA TELA e e anunciado (B3 r2): sem isto o visor desmontava e a
           arvore voltava "normal" depois de uma leitura que falhou. role="alert" anuncia a
           chegada ao leitor de tela. O erro e EXCLUSIVO (B1 r4): com ele, nada da cadeia abaixo
           roda — senao o usuario veria "sem diferenças" junto de "arquivo binario", duas
           afirmacoes que se contradizem. -->
      <p class="aviso erro" role="alert">{erro}</p>
    {:else if podeUsarEditor && doArquivo}
      {#if doArquivo.truncated}
        <p class="aviso">{m.arq_arquivo_cortado()}</p>
      {/if}
      {#if erroSalvarVisivel}
        <p class="aviso erro" role="alert">{erroSalvarVisivel}</p>
      {/if}
      <!-- Um editor só, sempre. Com o diff por dentro (unifiedMergeView) ele troca o `diff --git`
           /`@@` cru por arquivo inteiro, numeração real e trechos iguais dobrados; digitável
           quando dá pra gravar. O rascunho NÃO troca a vista: `original` entra na criação do
           estado do CodeMirror, então mudá-lo ao digitar remontaria o editor e jogaria o cursor
           pro começo do arquivo a cada primeira tecla. -->
      <!-- Base IGUAL ao texto (arquivo sem mudança no escopo) não vira diff: o merge view dobrava
           o arquivo inteiro em "327 linhas sem mudança" e a tela ficava vazia (medido 26/08). -->
      <CodeEditor texto={textoNoEditor} path={path} editavel={podeEditar} {linha}
                  original={verArquivo || baseDoDiff === doArquivo.text ? null : baseDoDiff}
                  onChange={(t) => onRascunho?.(t === doArquivo.text ? null : t)}
                  onSalvar={salvar} />
    {:else if temDiff && diffDoArquivo}
      {@const d = diffDoArquivo}
      {#if d.truncated}
        <p class="aviso">{m.arq_diff_cortado()}</p>
      {/if}
      <DiffView path={path} rows={rows} loading={loading || destacando} />
    {:else if doArquivo}
      {#if doArquivo.truncated}
        <p class="aviso">{m.arq_arquivo_cortado()}</p>
      {/if}
      {#if erroSalvarVisivel}
        <p class="aviso erro" role="alert">{erroSalvarVisivel}</p>
      {/if}
      <!-- Calha + linhas destacadas (mesmo desenho do DiffView: cor do token INLINE, vinda do
           tema do Shiki). Sem tokens ainda (destaque em voo) ou sem tokens possíveis (null do
           highlight) a linha sai em texto plano — a calha aparece nos dois casos. -->
      <pre class="conteudo" style:--gut="{digitosCalha}ch">{#each linhas as linha, i (i)}{@const toks = tokensArquivo[i]}<span class="ln"><span class="gut">{i + 1}</span>{#if toks}{#each toks as t, j (j)}<span style={t.color ? `color: ${t.color}` : undefined}>{t.content}</span>{/each}{:else}{linha}{/if}</span>{/each}</pre>
    {:else if loading}
      <!-- Busca em voo sem nada ainda: aviso de carga, nunca a afirmação "sem diferenças". -->
      <p class="aviso">{m.git_diff_carregando()}</p>
    {:else}
      <p class="aviso">{m.git_sem_diferencas()}</p>
    {/if}
  </div>
</div>

<style>
  /* OPACO de propósito, sem seguir o slider de transparência: ler ou editar código com o chat
     de trás atravessando o texto é ilegível, e foi o que o usuário pediu pra acabar (20/08/2026).
     Cor crua e sólida, não `--surface-inset` — este é o único lugar do app que sai do véu. */
  .visor {
    flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
    /* A FAIXA das abas é o fundo mais escuro; a aba ativa, a sub-barra e o editor ficam um
       degrau acima. Em tema escuro elevação é luz, então a peça da frente é a mais clara —
       sem isso a faixa e a aba saíam com a MESMA cor e o degrau do desenho não existia. */
    background: var(--bg-base);
    --cp-editor-surface: color-mix(in srgb, var(--bg-elevated) 75%, var(--bg-base));
  }
  /* Cartão só no desktop: no celular o visor é a tela inteira e um raio ali fica solto. */
  @media (min-width: 820px) {
    .visor { border: 1px solid var(--border-subtle); border-radius: 12px; }
  }
  /* O app tem `button { min-height: 44px; min-width: 44px }` global — o alvo de toque. É certo
     no celular e é o que estava inflando esta faixa no desktop: a aba ia a 60px e o segmentado a
     48px, contra os ~34/26px do desenho. Com PONTEIRO FINO (mouse) o alvo pode ser o tamanho
     real do controle; no toque, os 44px continuam valendo.

     O corte é por LARGURA (820px, o mesmo do DesktopShell), não por `pointer: fine`: o critério
     de ponteiro é o mais correto na teoria, mas não dá pra verificar — o navegador headless que
     eu uso pra conferir a tela reporta `pointer: none`, então a regra nunca valeria no teste. */
  @media (min-width: 820px) {
    .abas button, .subbarra button { min-height: 0; min-width: 0; }
  }

  /* ── faixa de abas (valores do mock C) ────────────────────────────────────────────────── */
  .abas {
    display: flex; align-items: center; gap: 4px; min-width: 0;
    padding: 6px 8px 0;
    background: var(--bg-base);          /* a faixa é o fundo mais escuro */
    flex: none;
  }
  /* A faixa rola em X e as ações ficam paradas à direita: com muitos arquivos abertos, o que
     some de vista é uma aba distante, nunca o Salvar. A barra de rolagem some (ela ficaria
     encostada na aba ativa, cortando o degrau de cor); a rolagem por gesto e por teclado fica. */
  .faixa {
    display: flex; align-items: flex-end; gap: 4px;
    min-width: 0; overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none;
  }
  .faixa::-webkit-scrollbar { display: none; }
  .aba {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 0 6px 0 14px;
    border-radius: 10px 10px 0 0;
    background: transparent;
    font-size: 12.5px; font-weight: 500; color: var(--text-muted);
    min-width: 0; max-width: 200px; flex: none;
    transition: background 120ms ease, color 120ms ease;
  }
  /* A aba ATIVA tem a cor do editor — é o degrau que liga a aba ao código embaixo dela. */
  .aba.ativa { background: var(--cp-editor-surface); color: var(--text-primary); }
  @media (hover: hover) and (pointer: fine) {
    .aba:not(.ativa):hover { background: var(--bg-hover); color: var(--text-secondary); }
  }
  .aba-nome {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 8px 0; border: 0; background: none; color: inherit;
    font: inherit; cursor: pointer; min-width: 0;
  }
  .aba.ativa .aba-nome { cursor: default; }
  .ponto { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .ponto.falhou { background: var(--error); }
  .fechar-aba {
    width: 22px; height: 22px; flex: none;
    display: grid; place-items: center;
    border: 0; background: none; color: var(--text-muted);
    border-radius: 6px; cursor: pointer;
    transition: transform 160ms var(--ease-out), background 120ms ease, color 120ms ease;
  }
  .fechar-aba svg { width: 12px; height: 12px; }
  .fechar-aba:active { transform: scale(0.94); }
  @media (hover: hover) and (pointer: fine) {
    .fechar-aba:hover { background: var(--bg-hover); color: var(--text-primary); }
  }
  .empurra { flex: 1; }

  .seg {
    display: flex; gap: 2px; flex: none; margin-bottom: 6px;
    background: var(--fill-subtle); border-radius: 8px; padding: 2px;
  }
  .seg button {
    border: 0; background: transparent; color: var(--text-muted);
    font: inherit; font-size: 11.5px; line-height: 1.35; padding: 3px 11px;
    border-radius: 6px; cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  /* Tinta sobre o vidro, não uma superfície opaca: `--surface-raised` deixava o botão ativo com
     mais peso do que o mock e engordava a faixa inteira. */
  .seg button.on { background: rgba(255, 248, 244, 0.09); color: var(--text-primary); font-weight: 500; }

  .acao {
    padding: 5px 12px; border-radius: 8px; flex: none; margin-bottom: 6px;
    border: 1px solid var(--border-subtle); background: transparent;
    color: var(--text-secondary); font: inherit; font-size: 12px; font-weight: 500;
    cursor: pointer;
    transition: transform 160ms var(--ease-out), color 120ms ease, border-color 120ms ease;
  }
  .acao:active:not(:disabled) { transform: scale(0.97); }
  .acao:disabled { opacity: 0.5; cursor: default; }
  .acao.primaria { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
  @media (hover: hover) and (pointer: fine) {
    .acao:hover:not(:disabled) { color: var(--text-primary); }
  }
  .salvo { font-size: var(--text-xs); color: var(--success); flex: none; margin-bottom: 6px; }

  /* ── sub-barra ─────────────────────────────────────────────────────────────────────────── */
  .subbarra {
    display: flex; align-items: center; gap: 16px;
    padding: 8px 16px;
    background: var(--cp-editor-surface);
    border-bottom: 1px solid var(--border-subtle);
    flex: none;
  }
  .caminho {
    flex: 1; min-width: 0;
    font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .stat { font-family: var(--font-mono); font-size: 12px; font-weight: 600; flex: none; display: flex; gap: 8px; }
  .stat .stat-add { color: var(--success); }
  .stat .stat-del { color: var(--error); }
  /* `--border-subtle` (7% de alfa) some num traço de 1px — some mesmo, foi o que aconteceu. */
  .divisor { width: 1px; height: 14px; background: rgba(255, 248, 244, 0.16); flex: none; }
  .escopo {
    background: none; border: 0; padding: 0;
    font: inherit; font-size: 11px; color: var(--text-muted);
    cursor: pointer; flex: none;
    transition: color 120ms ease;
  }
  .escopo:disabled { cursor: default; opacity: 0.55; }
  @media (hover: hover) and (pointer: fine) {
    .escopo:hover:not(:disabled) { color: var(--text-primary); }
  }
  .motivo { font-size: 11px; color: var(--warning); min-width: 0; }
  .voltar {
    display: inline-flex; align-items: center; gap: 5px; flex: none;
    background: none; border: 0; color: var(--accent); font: inherit; font-size: 11px;
    cursor: pointer; padding: 0;
  }
  @media (min-width: 820px) { .voltar { display: none; } }

  .corpo {
    background: var(--cp-editor-surface);
    /* SEM padding lateral: o código vai de ponta a ponta, como no editor de verdade. O padding
       daqui punha o bloco de código dentro de uma segunda moldura, com margem — foi a diferença
       mais visível entre a tela e o mock. Os avisos, que precisam de recuo, trazem o seu. */
    padding: 0;
    /* Task 14: o corpo NAO rola — quem rola e a caixa do diff/conteudo (height: fit-content +
       max-height: 100% no .git-diff e no .conteudo). Flex column para a caixa ocupar a altura
       disponivel depois do cabecalho fixo. */
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }

  /* O cabeçalho de cima (caminho, +N −M, fechar) é DESTE componente. O interno do DiffView
     (que serve o GitChangesTab intacto) fica escondido aqui, por CSS no escopo do FileViewer —
     sem tocar no DiffView, que é arquivo compartilhado deste lote. */
  .corpo :global(.git-diff-head) {
    display: none;
  }

  .aviso {
    margin: 0 0 var(--space-2); padding: 7px 9px; border-radius: 7px;
    background: var(--fill-subtle); color: var(--text-muted);
    font-size: 11.5px; line-height: 1.4;
  }
  /* Erro da abertura (B3): mesma cor de erro do resto do app (FilesPanel usa .aviso.erro). */
  .aviso.erro { color: var(--error); }

  .conteudo {
    margin: 0; padding: var(--space-2); border-radius: var(--radius-md);
    background: var(--surface-inset); border: 1px solid var(--border-subtle);
    font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5;
    /* Task 14: mesma regra da caixa do diff — altura disponivel para arquivo grande, tamanho
       do conteudo para arquivo curto, rolagem dentro da caixa. */
    height: fit-content;
    max-height: 100%;
    overflow: auto;
    white-space: pre;
    flex-shrink: 1;
    min-height: 0;
  }
  /* A linha inteira ocupa a largura do CONTEUDO (min 100% da caixa) — sem isso a calha sticky
     para de grudar no meio da rolagem, porque ela nao passa do bloco que a contem. */
  .conteudo .ln { display: block; width: max-content; min-width: 100%; }
  /* Calha: numero fixo na esquerda enquanto o codigo rola em X (sticky). O fundo e o MESMO
     material da caixa (--surface-inset), pro codigo passar por baixo sem aparecer. */
  .conteudo .gut {
    position: sticky; left: 0;
    display: inline-block; width: var(--gut); padding-right: 1.25ch;
    text-align: right; color: var(--text-muted); user-select: none;
    background: var(--surface-inset);
  }
</style>
