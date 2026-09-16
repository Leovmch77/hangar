<script lang="ts">
  import { untrack } from 'svelte';
  import * as m from '../paraglide/messages';
  import NavBar from '../components/NavBar.svelte';
  import Select from '../components/Select.svelte';
  import { listServers, onServersChanged, type Server } from '../lib/auth';
  import { clienteQuery, uso } from '../lib/queries';
  import {
    mergeUso, Aquecendo, projectLabel,
    type UsoServerResult, type MergedUso, type UsoBucket, type UsoReport, type UsoFiltros,
  } from '@hangar/core';
  import { dec, tok, money, money2, type Cur } from '../lib/fmt';

  interface Props { onBack: () => void; }
  let { onBack }: Props = $props();

  type Periodo = '7d' | '30d' | '90d' | 'all';
  const PERIODOS: { id: Periodo; label: string }[] = [
    { id: '7d', label: m.custos_periodo_7d() },
    { id: '30d', label: m.custos_periodo_30d() },
    { id: '90d', label: m.custos_periodo_90d() },
    { id: 'all', label: m.custos_periodo_tudo() },
  ];

  const relatorioVazio = (): MergedUso => mergeUso([], 'all');

  let loading = $state(true);
  let pendingServers = $state(0);
  let merged = $state<MergedUso>(relatorioVazio());
  let period = $state<Periodo>('30d');
  // Mesma moeda escolhida na tela de custos: é a mesma pessoa olhando o mesmo dinheiro.
  let currency = $state<Cur>(localStorage.getItem('cp_costs_currency') === 'BRL' ? 'BRL' : 'USD');
  function setCurrency(c: Cur) { currency = c; localStorage.setItem('cp_costs_currency', c); }

  // Mesmas máquinas desmarcadas da tela de custos (cp_costs_servers_off): um relatório é a
  // continuação do outro, e desmarcar a máquina duas vezes seria surpresa.
  const SERVERS_OFF_KEY = 'cp_costs_servers_off';
  function lerServidoresOff(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(SERVERS_OFF_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  }
  let servidores = $state<Server[]>(listServers());
  $effect(() => onServersChanged(() => { servidores = listServers(); }));
  let servidoresOff = $state<Set<string>>(new Set(lerServidoresOff()));
  const marcados = $derived(servidores.filter((s) => !servidoresOff.has(s.id)));
  const servidoresAtivos = $derived(marcados.length ? marcados : servidores);
  let mostrarServidores = $state(false);
  function alternarServidor(id: string) {
    const s = new Set(servidoresOff);
    if (s.has(id)) s.delete(id); else s.add(id);
    servidoresOff = s;
    localStorage.setItem(SERVERS_OFF_KEY, JSON.stringify([...s]));
  }
  function todosServidores() { servidoresOff = new Set(); localStorage.setItem(SERVERS_OFF_KEY, '[]'); }

  // Filtros do SERVIDOR (`?conta=&projeto=&modelo=&plugin=&foco=`): as listas dos seletores vêm
  // no próprio relatório, inteiras, e trocar um filtro refaz a busca com outra chave de cache.
  // `busca` é só do cliente: recorta as linhas das tabelas pelo nome.
  let filtros = $state<UsoFiltros>({});
  let busca = $state('');
  const temFiltro = $derived(Boolean(filtros.conta || filtros.projeto || filtros.modelo || filtros.plugin));
  // Última lista de cada seletor vista: uma máquina antiga da malha não manda, e o seletor não
  // pode sumir enquanto se filtra.
  let listas = $state<{ conta: UsoBucket[]; projeto: UsoBucket[]; modelo: UsoBucket[]; plugin: UsoBucket[] }>({
    conta: [], projeto: [], modelo: [], plugin: [],
  });
  const rotuloConta = (b: UsoBucket) => b.label ?? b.key;
  function setFiltro(k: keyof UsoFiltros, v: string) { filtros = { ...filtros, [k]: v || undefined }; }
  function limpar() { filtros = {}; busca = ''; }

  // 202 "aquecendo": igual à tela de custos — faixa com progresso e repergunta a cada 3 s.
  let aquecendo = $state<Record<string, { label: string; lidos: number; total: number }>>({});
  const AQUECENDO_INTERVALO_MS = 3000;
  const AQUECENDO_TENTATIVAS = 100;
  const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  async function buscarEsperandoAquecer(s: Server, p: Periodo, f: UsoFiltros, meu: number, fresco: boolean): Promise<Partial<UsoReport>> {
    for (let tentativa = 0; ; tentativa++) {
      try {
        const r = await clienteQuery.fetchQuery(uso(s, p, f, fresco));
        const { [s.id]: _, ...resto } = aquecendo;
        aquecendo = resto;
        return r;
      } catch (e) {
        if (!(e instanceof Aquecendo) || tentativa >= AQUECENDO_TENTATIVAS || meu !== geracao) {
          const { [s.id]: _, ...resto } = aquecendo;
          aquecendo = resto;
          throw e;
        }
        aquecendo = { ...aquecendo, [s.id]: { label: s.label, lidos: e.lidos, total: e.total } };
        await esperar(AQUECENDO_INTERVALO_MS);
      }
    }
  }

  let geracao = 0;
  async function load(p: Periodo, f: UsoFiltros, alvo: Server[], forcar = false) {
    const meu = ++geracao;
    loading = true;
    pendingServers = alvo.length;
    if (forcar) await clienteQuery.invalidateQueries({ queryKey: ['uso'] });
    const results: UsoServerResult[] = [];
    const aplicar = () => {
      merged = mergeUso(results, p);
      const r = merged.report;
      listas = {
        conta: r.by_conta.length ? r.by_conta : listas.conta,
        projeto: r.by_projeto.length ? r.by_projeto : listas.projeto,
        modelo: r.by_modelo.length ? r.by_modelo : listas.modelo,
        // Plugins: a lista vem do próprio corte por plugin; com o filtro de plugin ativo o
        // relatório só traz aquele, então a última lista completa fica guardada.
        plugin: !f.plugin && r.by_plugin.length ? r.by_plugin : listas.plugin,
      };
    };
    await Promise.all(
      alvo.map(async (s) => {
        let result: UsoServerResult;
        try { result = { report: await buscarEsperandoAquecer(s, p, f, meu, forcar), label: s.label, id: s.id }; }
        catch { result = { report: null, label: s.label, id: s.id }; }
        if (meu !== geracao) return;
        results.push(result);
        pendingServers -= 1;
        aplicar();
        if (result.report || pendingServers === 0) loading = false;
      }),
    );
    if (meu !== geracao) return;
    aplicar();
    loading = false;
  }
  const chaveAtivos = $derived(servidoresAtivos.map((s) => `${s.id}|${s.baseUrl}|${s.token}`).join('\n'));
  const chaveFiltros = $derived(JSON.stringify(filtros));
  $effect(() => { const p = period; chaveFiltros; chaveAtivos; load(p, untrack(() => filtros), untrack(() => servidoresAtivos)); });

  const report = $derived(merged.report);
  const rate = $derived(report.usd_brl ?? null);
  const moeda = (n: number) => money(n, currency, rate);
  const m2 = (n: number) => money2(n, currency, rate);
  const vazioNoPeriodo = $derived(!loading && report.totals.chamadas === 0 && report.totals.ctx_chars === 0);
  const tokensReais = (b: UsoBucket) => b.input + b.output + b.cache_write + b.cache_read;
  const porChamada = (b: UsoBucket) => (b.chamadas > 0 ? b.cost / b.chamadas : 0);
  const ctxPorChamada = (b: UsoBucket) => (b.chamadas > 0 ? b.ctx_tokens_est / b.chamadas : 0);
  const media = (b: UsoBucket) => (b.sessions > 0 ? b.ctx_tokens_est / b.sessions : 0);
  const totalImagens = $derived(report.by_imagem.reduce((n, b) => n + b.chamadas, 0));
  const custoChamadaMedio = $derived.by(() => {
    const itens = [...report.by_skill, ...report.by_agente];
    const c = itens.reduce((n, b) => n + b.chamadas, 0);
    return c > 0 ? itens.reduce((n, b) => n + b.cost, 0) / c : 0;
  });

  // ── Ordenação e recorte das tabelas ──────────────────────────────────────────
  type Col = 'nome' | 'chamadas' | 'pedidas' | 'sessions' | 'ctx' | 'ctxChamada' | 'media' | 'tokens' | 'cost' | 'custoChamada';
  const valorDe = (b: UsoBucket, c: Col): number | string => ({
    nome: b.label ?? b.key, chamadas: b.chamadas, pedidas: b.pedidas, sessions: b.sessions,
    ctx: b.ctx_tokens_est, ctxChamada: ctxPorChamada(b), media: media(b), tokens: tokensReais(b),
    cost: b.cost, custoChamada: porChamada(b),
  })[c];
  let ordem = $state<Record<string, { col: Col; desc: boolean }>>({});
  function ordenar(sec: string, col: Col, padrao: Col) {
    const atual = ordem[sec] ?? { col: padrao, desc: true };
    ordem = { ...ordem, [sec]: atual.col === col ? { col, desc: !atual.desc } : { col, desc: col !== 'nome' } };
  }
  function ordenada(sec: string, lista: UsoBucket[], padrao: Col): UsoBucket[] {
    const o = ordem[sec] ?? { col: padrao, desc: true };
    const termo = busca.trim().toLowerCase();
    const base = termo ? lista.filter((b) => (b.label ?? b.key).toLowerCase().includes(termo) || (b.plugin ?? '').toLowerCase().includes(termo)) : lista;
    return [...base].sort((a, b) => {
      const va = valorDe(a, o.col), vb = valorDe(b, o.col);
      const r = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - vb;
      return (o.desc ? -r : r) || a.key.localeCompare(b.key);
    });
  }
  const TOPO = 15;
  let expandidas = $state<Set<string>>(new Set());
  function alternar(sec: string) {
    const s = new Set(expandidas);
    if (s.has(sec)) s.delete(sec); else s.add(sec);
    expandidas = s;
  }

  type Sec = { id: string; titulo: string; nota?: string; colNome: string; lista: UsoBucket[];
    custo: boolean; media: boolean; plugin: boolean; ctx: boolean; origem?: string; padrao: Col };
  const secoes = $derived<Sec[]>([
    { id: 'skill', titulo: m.uso_sec_skills(), nota: m.uso_sec_skills_nota(), colNome: m.uso_col_nome(), lista: report.by_skill, custo: true, media: false, plugin: true, ctx: true, origem: m.uso_col_origem_skill(), padrao: 'custoChamada' },
    { id: 'agente', titulo: m.uso_sec_agentes(), nota: m.uso_sec_agentes_nota(), colNome: m.uso_col_tipo(), lista: report.by_agente, custo: true, media: false, plugin: false, ctx: false, origem: m.uso_col_origem_agente(), padrao: 'custoChamada' },
    { id: 'plugin', titulo: m.uso_sec_plugins(), nota: m.uso_sec_plugins_nota(), colNome: m.uso_col_plugin(), lista: report.by_plugin, custo: true, media: false, plugin: false, ctx: true, padrao: 'cost' },
    { id: 'contexto', titulo: m.uso_sec_contexto(), nota: m.uso_sec_contexto_nota(), colNome: m.uso_col_nome(), lista: report.by_contexto, custo: false, media: true, plugin: true, ctx: true, padrao: 'ctx' },
    { id: 'tool', titulo: m.uso_sec_tools(), colNome: m.uso_col_nome(), lista: report.by_tool, custo: false, media: false, plugin: false, ctx: true, padrao: 'ctxChamada' },
    { id: 'bash', titulo: m.uso_sec_bash(), nota: m.uso_sec_bash_nota(), colNome: m.uso_col_comando(), lista: report.by_bash, custo: false, media: false, plugin: false, ctx: true, padrao: 'ctxChamada' },
    { id: 'mcp', titulo: m.uso_sec_mcp(), colNome: m.uso_col_servidor(), lista: report.by_mcp, custo: false, media: false, plugin: false, ctx: true, padrao: 'ctxChamada' },
  ]);
  const rotuloImagem = (b: UsoBucket) =>
    b.key === 'enviada' ? m.uso_img_enviada() : m.uso_img_lida({ tool: b.key.replace(/^lida:/, '') });

  // ── Gráficos ─────────────────────────────────────────────────────────────────
  // Todos SVG, um eixo por gráfico (chamadas e custo por dia são dois gráficos lado a lado, não
  // um de dois eixos). Cores: --chart-1..4 do app.css, validadas pra daltonismo nos dois temas.
  const ALT = 150;
  let larguraDia = $state(0);
  let larguraTop = $state(0);
  let larguraCtx = $state(0);
  let hoverDia = $state<number | null>(null);
  let hoverTop = $state<number | null>(null);
  let hoverCtx = $state<number | null>(null);

  const dias = $derived(report.by_day);
  function colunas(valor: (b: UsoBucket) => number, largura: number) {
    const n = dias.length;
    const padL = 8, padR = 8, padT = 10, padB = 22;
    const W = Math.max(largura, 200), H = ALT;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const teto = Math.max(...dias.map(valor), 0) || 1;
    const passo = n ? plotW / n : plotW;
    const bw = Math.min(24, Math.max(2, passo - 2));
    return {
      W, H, padT, plotH,
      barras: dias.map((b, i) => {
        const v = valor(b);
        const h = Math.max(v > 0 ? 2 : 0, (v / teto) * plotH);
        return { b, v, x: padL + i * passo + (passo - bw) / 2, w: bw, y: padT + plotH - h, h, cx: padL + i * passo + passo / 2 };
      }),
      rotulos: n ? [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => ({ i, x: padL + i * passo + passo / 2 })) : [],
      base: padT + plotH,
    };
  }
  const grafChamadas = $derived(colunas((b) => b.chamadas, larguraDia));
  const grafCusto = $derived(colunas((b) => b.cost, larguraDia));
  const diaCurto = (k: string) => k.slice(5).replace('-', '/');

  let topModo = $state<'total' | 'chamada'>('total');
  const top = $derived.by(() => {
    const itens = [...report.by_skill, ...report.by_agente].filter((b) => b.cost > 0);
    const valor = (b: UsoBucket) => (topModo === 'total' ? b.cost : porChamada(b));
    const lista = [...itens].sort((a, b) => valor(b) - valor(a)).slice(0, 10);
    const teto = Math.max(...lista.map(valor), 0) || 1;
    return lista.map((b) => ({ b, v: valor(b), frac: valor(b) / teto }));
  });

  // Categorias do contexto fixo: 4 cores + "outros" em cinza. A ordem é fixa (cor segue a
  // categoria, nunca a posição).
  type Cat = 'instrucoes' | 'catalogo' | 'hooks' | 'lembretes' | 'outros';
  const CATS: { id: Cat; label: string; slot: string }[] = [
    { id: 'instrucoes', label: m.uso_ctx_cat_instrucoes(), slot: 'var(--chart-1)' },
    { id: 'catalogo', label: m.uso_ctx_cat_catalogo(), slot: 'var(--chart-2)' },
    { id: 'hooks', label: m.uso_ctx_cat_hooks(), slot: 'var(--chart-3)' },
    { id: 'lembretes', label: m.uso_ctx_cat_lembretes(), slot: 'var(--chart-4)' },
    { id: 'outros', label: m.uso_ctx_cat_outros(), slot: 'var(--text-muted)' },
  ];
  function categoria(key: string): Cat {
    if (key.startsWith('hook')) return 'hooks';
    if (/^(instructions|nested_memory|session_context)$/.test(key)) return 'instrucoes';
    if (/^(skill_listing|agent_listing|deferred_tools|command_permissions)/.test(key)) return 'catalogo';
    if (/reminder|output_style|queued_command|silent_turn/.test(key)) return 'lembretes';
    return 'outros';
  }
  const ctxPorCat = $derived.by(() => {
    const soma: Record<Cat, number> = { instrucoes: 0, catalogo: 0, hooks: 0, lembretes: 0, outros: 0 };
    for (const b of report.by_contexto) soma[categoria(b.key)] += b.ctx_tokens_est;
    const sessoes = report.totals.sessions || 1;
    const total = Object.values(soma).reduce((a, b) => a + b, 0) || 1;
    let x = 0;
    return CATS.map((c) => {
      const frac = soma[c.id] / total;
      const seg = { ...c, tokens: soma[c.id], porSessao: soma[c.id] / sessoes, frac, x };
      x += frac;
      return seg;
    });
  });
  const ctxTotalSessao = $derived(ctxPorCat.reduce((n, s) => n + s.porSessao, 0));

  function focar(nome: string) { setFiltro('foco', filtros.foco === nome ? '' : nome); }
</script>

<NavBar title={m.nav_uso()} showBack={true} onBack={onBack} />

<div class="uso">
 <div class="inner">
  <div class="page-intro">
    <div>
      <h1>{m.uso_titulo()}</h1>
      <p>{m.uso_aviso()}</p>
      <a class="link" href="#/costs">{m.uso_ir_custos()}</a>
    </div>
    <button class="clear" disabled={loading || pendingServers > 0} onclick={() => load(period, filtros, servidoresAtivos, true)}>{m.custos_atualizar()}</button>
  </div>
  <div class="period-toolbar">
    <span class="seg" role="group" aria-label={m.custos_periodo()}>
      {#each PERIODOS as p}
        <button aria-pressed={period === p.id} onclick={() => (period = p.id)}>{p.label}</button>
      {/each}
    </span>
    <span class="seg" role="group" aria-label={m.custos_moeda()}>
      <button aria-pressed={currency === 'USD'} onclick={() => setCurrency('USD')}>US$</button>
      <button aria-pressed={currency === 'BRL'} onclick={() => setCurrency('BRL')}
        disabled={!rate} title={rate ? undefined : m.custos_cotacao_indisponivel()}>R$</button>
    </span>
    {#if servidores.length > 1}
      <button class="chip" aria-expanded={mostrarServidores} onclick={() => (mostrarServidores = !mostrarServidores)}>
        {m.custos_servidores()}: {m.custos_de_servidores({ n: servidoresAtivos.length, m: servidores.length })}
      </button>
    {/if}
  </div>
  {#if mostrarServidores && servidores.length > 1}
    <div class="chips" role="group" aria-label={m.custos_servidores_relatorio()}>
      {#each servidores as s (s.id)}
        <button class="chip" aria-pressed={!servidoresOff.has(s.id)}
          disabled={marcados.length === 1 && !servidoresOff.has(s.id)}
          onclick={() => alternarServidor(s.id)}>{s.label}</button>
      {/each}
      {#if servidoresOff.size}
        <button class="chip todos" onclick={todosServidores}>{m.custos_todos()}</button>
      {/if}
    </div>
  {/if}

  <details class="filter-details" open={window.matchMedia('(min-width: 820px)').matches}>
    <summary>{m.uso_filtros()}</summary>
    <div class="filtros">
      <span class="fgroup">
        <span class="flabel">{m.uso_conta()}</span>
        <Select ariaLabel={m.uso_conta()} value={filtros.conta ?? ''}
          opcoes={[{ value: '', label: m.custos_todas_n({ n: listas.conta.length }) },
                   ...listas.conta.map((b) => ({ value: b.key, label: rotuloConta(b), title: b.key, hint: moeda(b.cost) }))]}
          onchange={(v) => setFiltro('conta', v)} />
      </span>
      <span class="fgroup">
        <span class="flabel">{m.uso_projeto()}</span>
        <Select ariaLabel={m.uso_projeto()} value={filtros.projeto ?? ''}
          opcoes={[{ value: '', label: m.custos_todos_n({ n: listas.projeto.length }) },
                   ...listas.projeto.map((b) => ({ value: b.key, label: projectLabel(b.key), title: b.key, hint: moeda(b.cost) }))]}
          onchange={(v) => setFiltro('projeto', v)} />
      </span>
      <span class="fgroup">
        <span class="flabel">{m.uso_modelo()}</span>
        <Select ariaLabel={m.uso_modelo()} value={filtros.modelo ?? ''}
          opcoes={[{ value: '', label: m.custos_todos_n({ n: listas.modelo.length }) },
                   ...listas.modelo.map((b) => ({ value: b.key, label: b.key, hint: moeda(b.cost) }))]}
          onchange={(v) => setFiltro('modelo', v)} />
      </span>
      <span class="fgroup">
        <span class="flabel">{m.uso_plugin()}</span>
        <Select ariaLabel={m.uso_plugin()} value={filtros.plugin ?? ''}
          opcoes={[{ value: '', label: m.custos_todos_n({ n: listas.plugin.length }) },
                   ...listas.plugin.map((b) => ({ value: b.key, label: b.key, hint: dec(b.chamadas, 0) }))]}
          onchange={(v) => setFiltro('plugin', v)} />
      </span>
      <span class="fgroup busca">
        <span class="flabel">{m.uso_col_nome()}</span>
        <input type="search" placeholder={m.uso_busca()} bind:value={busca} aria-label={m.uso_busca()} />
      </span>
      <button class="clear" disabled={!temFiltro && !busca && !filtros.foco} onclick={limpar}>{m.uso_limpar()}</button>
    </div>
  </details>

  {#if merged.partial}
    <p class="warn">
      ⚠ {m.custos_total_parcial()}
      {#if merged.failed.length}
        {merged.failed.length === 1 ? m.custos_servidor_nao_respondeu_1() : m.custos_servidor_nao_respondeu({ n: merged.failed.length })}
        ({merged.failed.join(', ')}).
      {/if}
      {#if merged.mismatched.length}
        {merged.mismatched.length === 1 ? m.custos_fora_periodo_1() : m.custos_fora_periodo({ n: merged.mismatched.length })}
        ({merged.mismatched.join(', ')}).
      {/if}
      <button class="retry" onclick={() => load(period, filtros, servidoresAtivos, true)}>{m.config_server_tentar_de_novo()}</button>
    </p>
  {/if}

  {#each Object.values(aquecendo) as a (a.label)}
    <div class="aquecendo" role="status">
      <p>
        {a.total > 0
          ? m.custos_aquecendo_progresso({ maquina: a.label, lidos: a.lidos, total: a.total })
          : m.custos_aquecendo({ maquina: a.label })}
      </p>
      <progress max={a.total || undefined} value={a.total ? a.lidos : undefined}></progress>
    </div>
  {/each}
  {#if pendingServers > 0}
    <p class="loading-status" role="status">{m.custos_carregando_maquinas({ n: pendingServers })}</p>
  {/if}

  {#if loading}
    <p class="muted">{m.comum_carregando()}</p>
  {:else if vazioNoPeriodo}
    <p class="muted">{m.uso_vazio()}</p>
  {:else}
    <dl class="kpis overview">
      <div class="kpi"><dt>{m.uso_kpi_custo()}</dt><dd class="hero">{moeda(report.totals.cost)}</dd><div class="foot">{m2(report.totals.cost)}</div></div>
      <div class="kpi"><dt>{m.uso_kpi_custo_chamada()}</dt><dd>{m2(custoChamadaMedio)}</dd></div>
      <div class="kpi"><dt>{m.uso_kpi_chamadas()}</dt><dd>{tok(report.totals.chamadas)}</dd></div>
      <div class="kpi"><dt>{m.uso_kpi_ctx()}</dt><dd>≈ {tok(report.totals.ctx_tokens_est)}</dd></div>
      <div class="kpi"><dt>{m.uso_kpi_imagens()}</dt><dd>{dec(totalImagens, 0)}</dd></div>
      <div class="kpi"><dt>{m.uso_kpi_sessoes()}</dt><dd>{dec(report.totals.sessions, 0)}</dd></div>
    </dl>

    <div class="graficos">
      <section class="card grafico dia">
        <div class="chart-heading">
          <div>
            <h2>{m.uso_graf_dia()}{#if filtros.foco} <span class="foco">· {filtros.foco}</span>{/if}</h2>
            <p class="hint">{m.uso_graf_dia_nota()}</p>
          </div>
          {#if filtros.foco}<button class="retry" onclick={() => setFiltro('foco', '')}>{m.uso_foco_limpar()}</button>{/if}
        </div>
        {#if !dias.length}
          <p class="muted">{m.uso_sem_dias()}</p>
        {:else}
          <div class="duplo" bind:clientWidth={larguraDia}>
            {#each [{ g: grafChamadas, titulo: m.uso_graf_chamadas(), fmt: (v: number) => tok(v), cor: 'var(--chart-1)' },
                    { g: grafCusto, titulo: m.uso_graf_custo(), fmt: (v: number) => m2(v), cor: 'var(--chart-2)' }] as p (p.titulo)}
              <div class="mini">
                <h3>{p.titulo}</h3>
                <div class="svgbox">
                  <svg viewBox="0 0 {p.g.W} {p.g.H}" width={p.g.W} height={p.g.H} role="img" aria-label={p.titulo}
                       onmouseleave={() => (hoverDia = null)}>
                    <line x1="0" x2={p.g.W} y1={p.g.base} y2={p.g.base} class="eixo" />
                    {#each p.g.barras as c, i (c.b.key)}
                      <rect x={c.x} y={c.y} width={c.w} height={c.h} rx="3" fill={p.cor}
                            opacity={hoverDia === null || hoverDia === i ? 1 : 0.45} />
                      <!-- alvo de hover maior que a barra: a coluna inteira -->
                      <rect x={c.cx - Math.max(c.w, 12) / 2} y={p.g.padT} width={Math.max(c.w, 12)} height={p.g.plotH}
                            fill="transparent" role="presentation" onmouseenter={() => (hoverDia = i)} />
                    {/each}
                    {#each p.g.rotulos as r (r.i)}
                      <text x={r.x} y={p.g.H - 6} text-anchor="middle" class="tick">{diaCurto(dias[r.i].key)}</text>
                    {/each}
                  </svg>
                  {#if hoverDia !== null && p.g.barras[hoverDia]}
                    <div class="tip" style="left: {Math.min(p.g.barras[hoverDia].cx, p.g.W - 120)}px">
                      <b>{p.fmt(p.g.barras[hoverDia].v)}</b><span>{dias[hoverDia].key}</span>
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <section class="card grafico top">
        <div class="chart-heading">
          <div><h2>{m.uso_graf_top()}</h2><p class="hint">{m.uso_graf_top_nota()}</p></div>
          <span class="seg" role="group" aria-label={m.uso_graf_top()}>
            <button aria-pressed={topModo === 'total'} onclick={() => (topModo = 'total')}>{m.uso_graf_top_total()}</button>
            <button aria-pressed={topModo === 'chamada'} onclick={() => (topModo = 'chamada')}>{m.uso_graf_top_por_chamada()}</button>
          </span>
        </div>
        <div class="barras" role="list" bind:clientWidth={larguraTop} onmouseleave={() => (hoverTop = null)}>
          {#each top as t, i (t.b.key)}
            <button class="linha" class:apagada={hoverTop !== null && hoverTop !== i} class:focada={filtros.foco === t.b.key}
                    onmouseenter={() => (hoverTop = i)} onclick={() => focar(t.b.key)} title={t.b.key}>
              <span class="nome">{t.b.label ?? t.b.key}</span>
              <span class="trilho"><span class="barra" style="width: {Math.max(t.frac * 100, 1)}%"></span></span>
              <span class="valor">{m2(t.v)}<span class="dim"> · {dec(t.b.chamadas, 0)}×</span></span>
            </button>
          {/each}
          {#if !top.length}<p class="muted">{m.uso_vazio_secao()}</p>{/if}
        </div>
      </section>

      <section class="card grafico ctx">
        <div class="chart-heading">
          <div><h2>{m.uso_graf_ctx()}</h2><p class="hint">{m.uso_graf_ctx_nota()}</p></div>
          <span class="total">≈ {tok(ctxTotalSessao)} <span class="dim">{m.uso_por_sessao()}</span></span>
        </div>
        <div class="pilha" bind:clientWidth={larguraCtx} role="img" aria-label={m.uso_graf_ctx()} onmouseleave={() => (hoverCtx = null)}>
          {#each ctxPorCat as s, i (s.id)}
            {#if s.frac > 0}
              <span class="seg-pilha" style="width: {s.frac * 100}%; background: {s.slot}"
                    class:apagada={hoverCtx !== null && hoverCtx !== i}
                    onmouseenter={() => (hoverCtx = i)} role="presentation"></span>
            {/if}
          {/each}
        </div>
        <ul class="legenda">
          {#each ctxPorCat as s, i (s.id)}
            <li class:apagada={hoverCtx !== null && hoverCtx !== i} onmouseenter={() => (hoverCtx = i)} onmouseleave={() => (hoverCtx = null)}>
              <span class="swatch" style="background: {s.slot}"></span>
              <span class="lab">{s.label}</span>
              <b>≈ {tok(s.porSessao)}</b><span class="dim">{dec(s.frac * 100, 0)}%</span>
            </li>
          {/each}
        </ul>
      </section>
    </div>

    {#each secoes as sec (sec.id)}
      {@const lista = ordenada(sec.id, sec.lista, sec.padrao)}
      {@const o = ordem[sec.id] ?? { col: sec.padrao, desc: true }}
      {@const th = (col: Col, rotulo: string, n = true) => ({ col, rotulo, n })}
      {@const cols = [
        th('nome', sec.colNome, false),
        ...(sec.plugin ? [th('nome', m.uso_col_plugin(), false)] : []),
        th('chamadas', m.uso_col_chamadas()),
        ...(sec.origem ? [th('pedidas', sec.origem)] : []),
        th('sessions', m.uso_col_sessoes()),
        ...(sec.ctx ? [th('ctx', m.uso_col_ctx()), th('ctxChamada', m.uso_col_ctx_chamada())] : []),
        ...(sec.media ? [th('media', m.uso_col_media())] : []),
        ...(sec.custo ? [th('tokens', m.uso_col_tokens()), th('cost', m.uso_col_custo()), th('custoChamada', m.uso_col_custo_chamada())] : []),
      ]}
      <section class="card">
        <h2>{sec.titulo}</h2>
        {#if sec.nota}<p class="hint">{sec.nota}</p>{/if}
        {#if !lista.length}
          <p class="muted">{m.uso_vazio_secao()}</p>
        {:else}
          <div class="scroll">
            <table class="data">
              <thead>
                <tr>
                  {#each cols as c, i (i)}
                    <th class:n={c.n} aria-sort={o.col === c.col && !(sec.plugin && i === 1) ? (o.desc ? 'descending' : 'ascending') : undefined}>
                      {#if sec.plugin && i === 1}
                        {c.rotulo}
                      {:else}
                        <button class="th" onclick={() => ordenar(sec.id, c.col, sec.padrao)} aria-label={m.uso_ordenar_por({ col: c.rotulo })}>
                          {c.rotulo}{#if o.col === c.col}<span class="seta">{o.desc ? '▾' : '▴'}</span>{/if}
                        </button>
                      {/if}
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each (expandidas.has(sec.id) ? lista : lista.slice(0, TOPO)) as b (b.key)}
                  <tr class="click" aria-selected={filtros.foco === b.key} onclick={() => focar(b.key)}>
                    <td class="nome" title={b.key}>{b.label ?? b.key}</td>
                    {#if sec.plugin}<td class="dim">{b.plugin || '—'}</td>{/if}
                    <td class="n">{dec(b.chamadas, 0)}</td>
                    {#if sec.origem}<td class="n">{dec(b.pedidas, 0)} <span class="dim">/ {dec(b.chamadas - b.pedidas, 0)}</span></td>{/if}
                    <td class="n">{dec(b.sessions, 0)}</td>
                    {#if sec.ctx}<td class="n">≈ {tok(b.ctx_tokens_est)}</td><td class="n">≈ {tok(ctxPorChamada(b))}</td>{/if}
                    {#if sec.media}<td class="n">≈ {tok(media(b))}</td>{/if}
                    {#if sec.custo}
                      <td class="n">{tok(tokensReais(b))}</td>
                      <td class="n">{b.cost > 0 ? m2(b.cost) : '—'}</td>
                      <td class="c">{b.cost > 0 ? m2(porChamada(b)) : '—'}</td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if lista.length > TOPO}
            <button class="retry" onclick={() => alternar(sec.id)}>
              {expandidas.has(sec.id) ? m.uso_mostrar_menos() : m.uso_mostrar_mais({ n: lista.length - TOPO })}
            </button>
          {/if}
        {/if}
      </section>
    {/each}

    <section class="card">
      <h2>{m.uso_sec_imagens()}</h2>
      <p class="hint">{m.uso_sec_imagens_nota()}</p>
      {#if !report.by_imagem.length}
        <p class="muted">{m.uso_vazio_secao()}</p>
      {:else}
        <div class="scroll">
          <table class="data">
            <thead><tr><th>{m.uso_col_nome()}</th><th class="n">{m.uso_kpi_imagens()}</th><th class="n">{m.uso_col_sessoes()}</th><th class="n">{m.uso_col_ctx()}</th><th class="n">{m.uso_col_ctx_chamada()}</th></tr></thead>
            <tbody>
              {#each report.by_imagem as b (b.key)}
                <tr>
                  <td class="nome">{rotuloImagem(b)}</td>
                  <td class="n">{dec(b.chamadas, 0)}</td>
                  <td class="n">{dec(b.sessions, 0)}</td>
                  <td class="n">≈ {tok(b.ctx_tokens_est)}</td>
                  <td class="n">≈ {tok(ctxPorChamada(b))}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
 </div>
</div>

<style>
  .uso {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: var(--navbar-fade) var(--space-4) var(--space-10);
  }
  .inner { max-width: 1480px; margin-inline: auto; }
  .page-intro { display: flex; align-items: start; gap: var(--space-4); margin-bottom: var(--space-4); }
  .page-intro h1 { font-size: var(--text-xl); font-weight: 650; margin-bottom: var(--space-1); }
  .page-intro p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; max-width: 80ch; }
  .page-intro .clear { flex: none; }
  .link { font-size: var(--text-sm); color: var(--accent); }
  .period-toolbar { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); align-items: center; }
  .seg { display: inline-flex; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button {
    background: transparent; border: 0; border-right: 1px solid var(--border-default);
    color: var(--text-secondary); font: inherit; font-size: var(--text-xs);
    padding: 6px 12px; cursor: pointer; min-height: 34px;
  }
  .seg button:last-child { border-right: 0; }
  .seg button[aria-pressed='true'] { background: var(--accent); color: #fff; }
  .seg button:hover:not([aria-pressed='true']) { background: var(--bg-hover); }
  .seg button:disabled { opacity: 0.5; cursor: default; }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-2); }
  .chip {
    background: var(--surface-raised); border: 1px solid var(--border-default); color: var(--text-secondary);
    border-radius: var(--radius-full); font: inherit; font-size: var(--text-xs); padding: 6px 12px; cursor: pointer; min-height: 34px;
  }
  .chip[aria-pressed='true'] { color: var(--text-primary); border-color: var(--accent); }
  .chip:disabled { opacity: 0.45; cursor: default; }
  .chip.todos { color: var(--accent); }
  .clear {
    background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    border-radius: var(--radius-sm); font: inherit; font-size: var(--text-xs); padding: 6px 12px; cursor: pointer; min-height: 34px;
  }
  .clear:disabled { opacity: 0.45; cursor: default; }
  .clear:hover:not(:disabled) { background: var(--bg-hover); }
  .retry {
    background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    border-radius: var(--radius-sm); font: inherit; font-size: var(--text-xs); padding: 4px 10px; cursor: pointer; margin-top: var(--space-2);
  }
  .retry:hover { background: var(--bg-hover); }
  .warn { color: var(--warning); font-size: var(--text-sm); margin-bottom: var(--space-3); }
  .muted { color: var(--text-secondary); }
  .dim { color: var(--text-secondary); }
  .loading-status { color: var(--text-secondary); font-size: var(--text-sm); margin-bottom: var(--space-3); }
  .aquecendo { margin-bottom: var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); }
  .aquecendo p { margin: 0 0 var(--space-1); }
  .aquecendo progress { width: min(100%, 420px); height: 6px; accent-color: var(--accent); }

  /* filtros: mesma barra da tela de custos; grade que cabe no que tiver de largura */
  .filter-details { margin-bottom: var(--space-4); }
  .filter-details > summary { cursor: pointer; color: var(--text-secondary); font-size: var(--text-sm); padding-block: var(--space-2); }
  .filtros {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3); align-items: end;
    background: var(--chrome-bg); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: var(--space-3);
  }
  .fgroup { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .flabel { font-size: var(--text-xs); color: var(--text-muted); }
  .busca input {
    width: 100%; min-height: 40px; padding: 6px 10px; font: inherit; font-size: var(--text-sm);
    background: var(--surface-inset); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .kpis.overview { border-block: 1px solid var(--border-subtle); padding-block: var(--space-4); }
  .kpi { padding: var(--space-2); min-width: 0; }
  .kpi dt { font-size: var(--text-xs); color: var(--text-muted); margin-bottom: 6px; }
  .kpi dd { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .kpi dd.hero { color: var(--accent); font-size: 30px; }
  .kpi .foot { font-size: var(--text-xs); color: var(--text-secondary); margin-top: 6px; }

  /* gráficos: três cards; dois por linha no desktop, um no celular */
  .graficos { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-6); }
  .grafico { background: var(--surface-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-4); min-width: 0; }
  .grafico.dia { grid-column: 1 / -1; }
  .chart-heading { display: flex; justify-content: space-between; gap: var(--space-3); align-items: start; margin-bottom: var(--space-3); }
  .chart-heading h2 { font-size: var(--text-base); font-weight: 650; }
  .chart-heading .total { font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap; }
  .foco { color: var(--accent); font-weight: 500; }
  .duplo { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); }
  .mini h3 { font-size: var(--text-xs); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: var(--space-1); }
  .svgbox { position: relative; }
  .svgbox svg { display: block; max-width: 100%; height: auto; }
  .eixo { stroke: var(--border-default); stroke-width: 1; }
  .tick { fill: var(--text-muted); font-size: 10px; }
  .tip {
    position: absolute; top: 4px; transform: translateX(-50%); pointer-events: none;
    background: var(--bg-elevated); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    padding: 4px 8px; font-size: var(--text-xs); display: flex; gap: 8px; align-items: baseline; white-space: nowrap;
  }
  .tip b { font-variant-numeric: tabular-nums; }
  .tip span { color: var(--text-secondary); }

  .barras { display: flex; flex-direction: column; gap: 6px; }
  .linha {
    display: grid; grid-template-columns: minmax(90px, 32%) 1fr auto; gap: var(--space-2); align-items: center;
    background: transparent; border: 0; padding: 2px 4px; font: inherit; color: var(--text-primary); cursor: pointer; text-align: left;
    border-radius: var(--radius-sm); min-width: 0;
  }
  .linha:hover, .linha.focada { background: var(--bg-hover); }
  .linha.apagada { opacity: 0.45; }
  .linha .nome { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trilho { display: block; height: 16px; background: var(--surface-inset); border-radius: 3px; overflow: hidden; }
  .barra { display: block; height: 100%; background: var(--chart-1); border-radius: 0 3px 3px 0; }
  .linha .valor { font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }

  .pilha { display: flex; height: 22px; gap: 2px; border-radius: 4px; overflow: hidden; margin-bottom: var(--space-3); }
  .seg-pilha { display: block; height: 100%; min-width: 2px; transition: opacity 120ms; }
  .seg-pilha.apagada { opacity: 0.35; }
  .legenda { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .legenda li { display: grid; grid-template-columns: 12px 1fr auto auto; gap: var(--space-2); align-items: center; font-size: var(--text-sm); }
  .legenda li.apagada { opacity: 0.45; }
  .legenda .swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .legenda .lab { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legenda b { font-variant-numeric: tabular-nums; }

  .card { margin-bottom: var(--space-6); }
  .card h2 { font-size: var(--text-base); font-weight: 650; margin-bottom: var(--space-1); }
  .card .hint { font-size: var(--text-xs); color: var(--text-secondary); margin-bottom: var(--space-3); max-width: 90ch; }
  .scroll { overflow-x: auto; }
  table.data { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  table.data th {
    text-align: left; font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.03em;
    color: var(--text-muted); font-weight: 600; padding: 0 var(--space-2) var(--space-2); white-space: nowrap;
  }
  table.data th .th { background: transparent; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-transform: inherit; letter-spacing: inherit; }
  table.data th .th:hover, table.data th[aria-sort] .th { color: var(--text-primary); }
  .seta { margin-left: 3px; }
  table.data td { padding: 7px var(--space-2); border-top: 1px solid var(--border-subtle); white-space: nowrap; }
  table.data td.nome { max-width: 46ch; overflow: hidden; text-overflow: ellipsis; }
  table.data th.n, table.data td.n { text-align: right; font-variant-numeric: tabular-nums; }
  table.data td.c { font-weight: 650; color: var(--accent); text-align: right; font-variant-numeric: tabular-nums; }
  table.data tr.click { cursor: pointer; }
  table.data tr.click:hover td { background: var(--bg-hover); }
  table.data tr[aria-selected='true'] td { background: var(--accent-dim); }

  @media (max-width: 819px) {
    .uso { padding-inline: var(--space-3); }
    .graficos { grid-template-columns: 1fr; }
    .page-intro { flex-direction: column; }
    .kpi dd { font-size: 22px; }
    .kpi dd.hero { font-size: 26px; }
    .grafico { padding: var(--space-3); }
    .linha { grid-template-columns: minmax(80px, 40%) 1fr; }
    .linha .valor { grid-column: 1 / -1; text-align: right; }
    table.data td.nome { max-width: 28ch; }
  }
</style>
