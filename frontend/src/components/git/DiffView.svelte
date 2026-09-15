<script lang="ts">
  import * as m from '../../paraglide/messages';
  import type { DiffRow } from '../../lib/highlight';

  interface Props {
    path: string;
    rows: DiffRow[];
    loading: boolean;
    truncated?: boolean;   // diff do commit inteiro/vs-worktree capado em 200KB pelo backend (_DIFF_MAX)
    // Painel estreito: esconde o cabeçalho do `git show` (diff --git/index/---/+++, que repete o
    // caminho que já está no topo) e dobra trecho longo sem alteração. Ler um diff de 400 linhas
    // numa coluna de 300px exige isso; a folha larga não precisa e segue como estava.
    compacto?: boolean;
  }
  let { path, rows, loading, truncated = false, compacto = false }: Props = $props();

  const CONTEXTO_MAX = 6;   // acima disso o trecho inalterado vira uma barra clicável
  const CONTEXTO_BORDA = 2; // linhas mantidas à vista de cada lado da dobra

  let abertas = $state<Set<number>>(new Set());

  // Linhas viram blocos: ou uma linha só, ou uma dobra ("N linhas sem alteração") que expande.
  type Bloco = { tipo: 'linha'; row: DiffRow; i: number } | { tipo: 'dobra'; id: number; rows: DiffRow[] };
  const blocos = $derived.by((): Bloco[] => {
    const uteis = compacto ? rows.filter((r) => r.kind !== 'meta') : rows;
    if (!compacto) return uteis.map((row, i) => ({ tipo: 'linha', row, i }) as Bloco);
    const out: Bloco[] = [];
    let buffer: DiffRow[] = [];
    let idDobra = 0;
    const despejar = () => {
      if (!buffer.length) return;
      if (buffer.length > CONTEXTO_MAX) {
        const id = idDobra++;
        const topo = buffer.slice(0, CONTEXTO_BORDA);
        const base = buffer.slice(-CONTEXTO_BORDA);
        const meio = buffer.slice(CONTEXTO_BORDA, buffer.length - CONTEXTO_BORDA);
        topo.forEach((row, k) => out.push({ tipo: 'linha', row, i: out.length + k }));
        out.push({ tipo: 'dobra', id, rows: meio });
        base.forEach((row, k) => out.push({ tipo: 'linha', row, i: out.length + k }));
      } else {
        buffer.forEach((row, k) => out.push({ tipo: 'linha', row, i: out.length + k }));
      }
      buffer = [];
    };
    for (const row of uteis) {
      if (row.kind === 'ctx') buffer.push(row);
      else { despejar(); out.push({ tipo: 'linha', row, i: out.length }); }
    }
    despejar();
    return out;
  });

  function alternarDobra(id: number) {
    const n = new Set(abertas);
    if (n.has(id)) n.delete(id); else n.add(id);
    abertas = n;
  }

  // +N / -M do diff aberto (contado do proprio rows; GitLens/TortoiseGit mostram no topo).
  const diffStat = $derived({
    add: rows.filter((r) => r.kind === 'add').length,
    del: rows.filter((r) => r.kind === 'del').length,
  });
</script>

<!-- .git-diff-head carrega a mesma costura fina que o cabecalho da folha antiga tinha —
     o botao "voltar" fica fora deste componente (quem o desenha e a aba), entao a borda migrou pra cá pra manter
     a divisoria exatamente na mesma posicao visual (logo antes do conteudo do diff). -->
<div class="git-diff-head">
  <span class="git-diff-name">{path}</span>
  {#if !loading && (diffStat.add || diffStat.del)}
    <span class="git-diff-stat"><span class="stat-add">+{diffStat.add}</span> <span class="stat-del">−{diffStat.del}</span></span>
  {/if}
</div>
{#if loading}
  <p class="git-muted">{m.git_diff_carregando()}</p>
{:else if !rows.length}
  <!-- "git diff HEAD" legitimamente vazio (ex: comparar o topo com a working tree limpa) e nao pode
       parecer carga falhada — a caixa em branco era indistinguivel de um erro engolido. -->
  <p class="git-muted">{m.git_sem_diferencas()}</p>
{:else}
  {#if truncated}
    <p class="git-warn">{m.git_diff_cortado()}</p>
  {/if}
  <pre class="git-diff">{#each blocos as b, bi (bi)}{#if b.tipo === 'dobra'}<button
      type="button" class="diff-dobra" onclick={() => alternarDobra(b.id)}
      aria-expanded={abertas.has(b.id)}
    >{abertas.has(b.id) ? '▾' : '▸'} {m.git_linhas_sem_alteracao({ n: b.rows.length })}</button>{#if abertas.has(b.id)}{#each b.rows as row, j (j)}<span
      >{#if row.prefix}<span class="diff-prefix">{row.prefix}</span>{/if}{#each row.tokens as t, k (k)}<span style={t.color ? `color: ${t.color}` : undefined}>{t.content}</span>{/each}</span>{/each}{/if}{:else}<span
      class:add={b.row.kind === 'add'}
      class:del={b.row.kind === 'del'}
      class:hunk={b.row.kind === 'hunk'}
      class:meta={b.row.kind === 'meta'}
    >{#if b.row.prefix}<span class="diff-prefix">{b.row.prefix}</span>{/if}{#each b.row.tokens as t, j (j)}<span style={t.color ? `color: ${t.color}` : undefined}>{t.content}</span>{/each}</span>{/if}{/each}</pre>
{/if}

<style>
  .git-diff-head {
    display: flex; flex-direction: column; gap: var(--space-2); flex-shrink: 0;
    padding-bottom: var(--space-2); border-bottom: 1px solid var(--border-subtle);
  }
  .git-diff-name {
    font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .git-diff-stat { flex: 0 0 auto; font-family: var(--font-mono); font-size: var(--text-xs); }
  .git-diff-stat .stat-add { color: var(--success); }
  .git-diff-stat .stat-del { color: var(--error); }
  .diff-dobra {
    display: block; width: 100%; text-align: left;
    background: var(--accent-dim); border: 0;
    border-top: 1px solid var(--border-subtle); border-bottom: 1px solid var(--border-subtle);
    color: var(--text-muted); font: inherit; font-size: var(--text-xs);
    padding: 1px var(--space-2); cursor: pointer;
  }
  .diff-dobra:hover { color: var(--text-secondary); }
  .git-muted { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .git-warn {
    margin: 0 0 var(--space-2); padding: var(--space-2); border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--warning) 12%, transparent); font-size: var(--text-xs);
    color: var(--warning);
  }

  .git-diff {
    margin: 0; padding: var(--space-2); border-radius: var(--radius-md);
    background: var(--surface-inset); border: 1px solid var(--border-subtle);
    font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5;
    /* Task 14: a caixa ocupa a ALTURA DISPONIVEL do contenedor (o visor do computador deixava
       ~165px vazios ate o rodape). height: fit-content mantem a caixa do diff CURTO no tamanho
       do conteudo; max-height: 100% limita o diff grande ao espaco e o overflow rola dentro da
       caixa (quem rola continua sendo ela, nao a pagina nem o corpo). */
    height: fit-content;
    max-height: 100%;
    overflow: auto;
    white-space: pre;
    flex-shrink: 1;
    min-height: 0;
  }
  /* So os filhos DIRETOS sao linhas (block); os tokens do Shiki dentro delas ficam inline. */
  .git-diff > span { display: block; }
  /* Fundo tingido por linha (add/del) + cor default do prefixo/fallback. O codigo em si recebe a cor
     inline dos tokens do Shiki (tema VS Code); a cor abaixo so pinta o prefixo +/- e o modo sem-highlight. */
  .git-diff .add { color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent); }
  .git-diff .del { color: var(--error); background: color-mix(in srgb, var(--error) 10%, transparent); }
  .git-diff .hunk { color: var(--accent); }
  .git-diff .meta { color: var(--text-muted); }
  .git-diff .diff-prefix { opacity: 0.7; user-select: none; }
</style>
