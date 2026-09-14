<script lang="ts">
  import type { ContextoUso } from '@hangar/core';
  import * as m from '../paraglide/messages';
  import { abbrevNum as formatTokens } from '@hangar/core';

  // Resposta do `/context` como cartão: barra do contexto por categoria (abre o detalhe) e os
  // limites da conta. O markdown original fica disponível pelo "ver texto".
  interface Props {
    dados: ContextoUso;
    texto: string;
  }
  let { dados, texto }: Props = $props();

  let aberto = $state(true);
  let mcpAberto = $state(false);
  let verTexto = $state(false);

  const CORES = ['#7c87e8', '#b47cf0', '#f07cb4', '#e0b35a', '#5ac7a0', '#4ac0e0', '#8fd06a', '#d2cbcd', '#e0875a'];
  const ehLivre = (nome: string) => /^free space$/i.test(nome);

  // Nomes fixos da CLI ganham tradução; categoria nova aparece como veio.
  const NOMES: Record<string, () => string> = {
    'system prompt': m.ctx_cat_prompt,
    'system tools': m.ctx_cat_ferramentas,
    'system tools (deferred)': m.ctx_cat_ferramentas_adiadas,
    'mcp tools': m.ctx_cat_mcp,
    'mcp tools (deferred)': m.ctx_cat_mcp_adiadas,
    'custom agents': m.ctx_cat_agentes,
    'memory files': m.ctx_cat_memoria,
    'skills': m.ctx_cat_skills,
    'messages': m.ctx_cat_mensagens,
    'free space': m.ctx_cat_livre,
    'autocompact buffer': m.ctx_cat_autocompact,
  };
  const nome = (n: string) => NOMES[n.toLowerCase()]?.() ?? n;

  const ocupadas = $derived(
    dados.categorias.filter((c) => !ehLivre(c.nome)).map((c, i) => ({ ...c, cor: CORES[i % CORES.length] })),
  );
  const livre = $derived(dados.categorias.find((c) => ehLivre(c.nome)));
  const servidoresMcp = $derived(new Set(dados.mcp.map((f) => f.servidor)).size);
  const pctFmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

  function rotuloLimite(r: string) {
    if (r === '5h') return m.ctx_limite_5h();
    if (r === '7d') return m.ctx_limite_7d();
    return r;
  }
  // Tique de 1 min: o cartão fica aberto por horas e o "renova em" não pode congelar.
  let agora = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => { agora = Date.now(); }, 60_000);
    return () => clearInterval(t);
  });

  function quandoRenova(ts: number | null) {
    if (!ts) return '';
    const falta = ts * 1000 - agora;
    if (falta <= 0) return '';
    if (falta < 24 * 3600e3) {
      const h = Math.floor(falta / 3600e3);
      const min = Math.floor((falta % 3600e3) / 60e3);
      return m.ctx_renova_em({ tempo: h ? `${h}h ${min}min` : `${min}min` });
    }
    const quando = new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return m.ctx_renova_dia({ quando });
  }
</script>

<div class="cc">
  <button type="button" class="cc-top" aria-expanded={aberto} onclick={() => (aberto = !aberto)}>
    <span class="cc-t">{m.ctx_janela()}</span>
    <span class="cc-v"><b>{formatTokens(dados.usado)}</b> / {formatTokens(dados.total)} ({pctFmt(dados.pct)}%)</span>
    <i class="cc-chev" class:open={aberto} aria-hidden="true"></i>
  </button>

  <div class="cc-barra" role="img" aria-label={m.ctx_janela()}>
    {#each ocupadas as c (c.nome)}
      <i style:flex-basis="{(c.tokens / dados.total) * 100}%" style:background={c.cor}></i>
    {/each}
  </div>

  <div class="cc-det" style:grid-template-rows={aberto ? '1fr' : '0fr'}>
    <div class="cc-clip">
      <div class="cc-lista">
        {#each ocupadas as c (c.nome)}
          <div class="cc-cat">
            <span class="cc-dot" style:background={c.cor}></span>
            <span class="cc-nome">{nome(c.nome)}</span>
            <span class="cc-n">{formatTokens(c.tokens)}</span>
            <span class="cc-p">{pctFmt(c.pct)}%</span>
          </div>
          {#if /^mcp tools/i.test(c.nome) && dados.mcp.length}
            <button type="button" class="cc-mcp" aria-expanded={mcpAberto} onclick={() => (mcpAberto = !mcpAberto)}>
              {mcpAberto ? '▾' : '▸'} {m.ctx_mcp_resumo({ n: dados.mcp.length, s: servidoresMcp })}
            </button>
            {#if mcpAberto}
              {#each dados.mcp as f (f.nome)}
                <div class="cc-tool"><span class="cc-tool-n">{f.nome}</span><span class="cc-n">{formatTokens(f.tokens)}</span></div>
              {/each}
            {/if}
          {/if}
        {/each}
        {#if livre}
          <div class="cc-cat cc-livre">
            <span class="cc-dot"></span>
            <span class="cc-nome">{nome(livre.nome)}</span>
            <span class="cc-n">{formatTokens(livre.tokens)}</span>
            <span class="cc-p">{pctFmt(livre.pct)}%</span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if dados.limites.length}
    <div class="cc-sep"></div>
    <div class="cc-plano">{m.ctx_limites()}</div>
    {#each dados.limites as l (l.rotulo)}
      <div class="cc-lim">
        <div class="cc-lim-l">
          <span>{rotuloLimite(l.rotulo)}</span>
          <span class="cc-lim-r">{quandoRenova(l.resetTs)}</span>
          <span class="cc-lim-p">{Math.round(l.pct)}%</span>
        </div>
        <div class="cc-lim-b"><i class:alto={l.pct >= 70} style:width="{Math.min(100, l.pct)}%"></i></div>
      </div>
    {/each}
  {/if}

  <button type="button" class="cc-texto" onclick={() => (verTexto = !verTexto)}>
    {verTexto ? m.ctx_esconder_texto() : m.ctx_ver_texto()}
  </button>
  {#if verTexto}<pre class="cc-pre">{texto}</pre>{/if}
</div>

<style>
  .cc {
    max-width: 440px;
    margin: var(--space-1) 0 var(--space-2);
    padding: 12px 14px 8px;
    border-radius: 12px;
    background: var(--surface-raised);
    box-shadow: 0 0 0 1px var(--border-subtle);
    animation: bubble-in 200ms var(--ease-out);
  }
  button { min-width: 0; min-height: 0; }

  .cc-top {
    display: flex;
    align-items: baseline;
    justify-content: flex-start;
    gap: 8px;
    width: 100%;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .cc-t { font-size: 13px; color: var(--text-secondary); }
  .cc-v { margin-left: auto; font-size: 13px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .cc-v b { color: var(--text-primary); font-weight: 600; }
  .cc-chev {
    width: 6px; height: 6px; margin-left: 4px;
    border-right: 1.5px solid var(--text-muted); border-bottom: 1.5px solid var(--text-muted);
    transform: translateY(-2px) rotate(45deg);
    transition: transform 220ms var(--ease-out);
  }
  .cc-chev.open { transform: translateY(1px) rotate(-135deg); }

  .cc-barra { display: flex; gap: 2px; height: 6px; margin: 9px 0 2px; border-radius: 3px; overflow: hidden; background: var(--fill-subtle); }
  .cc-barra i { display: block; height: 100%; flex-shrink: 0; border-radius: 1px; }

  .cc-det { display: grid; transition: grid-template-rows 280ms var(--ease-out); }
  .cc-clip { min-height: 0; overflow: hidden; }
  .cc-lista { padding-top: 8px; }
  .cc-cat, .cc-tool { display: grid; grid-template-columns: 10px 1fr auto 46px; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; color: var(--text-secondary); }
  .cc-dot { width: 8px; height: 8px; border-radius: 2px; }
  .cc-nome { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cc-n { text-align: right; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .cc-p { text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .cc-livre { color: var(--text-muted); }
  .cc-livre .cc-dot { border: 1px dashed var(--border-default); }
  .cc-mcp { display: block; margin: 0 0 2px 18px; padding: 0; border: none; background: transparent; font-size: 12px; color: var(--text-muted); cursor: pointer; text-align: left; }
  .cc-mcp:hover { color: var(--text-secondary); }
  .cc-tool { grid-template-columns: 18px 1fr auto; font-size: 11.5px; color: var(--text-muted); }
  .cc-tool-n { grid-column: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }

  .cc-sep { height: 1px; background: var(--border-subtle); margin: 10px 0 8px; }
  .cc-plano { font-size: 12.5px; color: var(--text-muted); margin-bottom: 6px; }
  .cc-lim { margin-bottom: 9px; }
  .cc-lim-l { display: flex; align-items: baseline; gap: 8px; font-size: 13px; color: var(--text-primary); }
  .cc-lim-r { margin-left: auto; font-size: 12px; color: var(--text-muted); }
  .cc-lim-p { width: 38px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
  .cc-lim-b { height: 5px; margin-top: 5px; border-radius: 3px; background: var(--fill-subtle); overflow: hidden; }
  .cc-lim-b i { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
  .cc-lim-b i.alto { background: var(--warning, #e0b35a); }

  .cc-texto { display: block; margin-top: 4px; padding: 0; border: none; background: transparent; font-size: 11.5px; color: var(--text-muted); cursor: pointer; }
  .cc-texto:hover { color: var(--text-secondary); }
  .cc-pre { margin: 6px 0 0; max-height: 240px; overflow: auto; font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); white-space: pre-wrap; }
</style>
