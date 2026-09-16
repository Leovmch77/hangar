<script lang="ts">
  import { untrack } from 'svelte';
  import * as m from '../paraglide/messages';
  import NavBar from '../components/NavBar.svelte';
  import Select from '../components/Select.svelte';
  import { listServers, onServersChanged, type Server } from '../lib/auth';
  import { clienteQuery, uso } from '../lib/queries';
  import { mergeUso, Aquecendo, type UsoServerResult, type MergedUso, type UsoBucket, type UsoReport } from '@hangar/core';
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

  // 202 "aquecendo": igual à tela de custos — faixa com progresso e repergunta a cada 3 s.
  let aquecendo = $state<Record<string, { label: string; lidos: number; total: number }>>({});
  const AQUECENDO_INTERVALO_MS = 3000;
  const AQUECENDO_TENTATIVAS = 100;
  const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Filtro por conta é do SERVIDOR (`?conta=`): a lista de contas vem no próprio relatório
  // (`by_conta`, sempre inteira), e trocar a conta refaz a busca com outra chave de cache.
  let conta = $state('');
  // Última lista de contas vista: some do relatório filtrado? Não — o backend manda inteira;
  // mas uma máquina antiga da malha não manda, e o seletor não pode sumir enquanto se filtra.
  let contasVistas = $state<UsoBucket[]>([]);
  const rotuloConta = (b: UsoBucket) => b.label ?? b.key;

  async function buscarEsperandoAquecer(s: Server, p: Periodo, c: string, meu: number): Promise<Partial<UsoReport>> {
    for (let tentativa = 0; ; tentativa++) {
      try {
        const r = await clienteQuery.fetchQuery(uso(s, p, c));
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
  async function load(p: Periodo, c: string, alvo: Server[], forcar = false) {
    const meu = ++geracao;
    loading = true;
    pendingServers = alvo.length;
    if (forcar) await clienteQuery.invalidateQueries({ queryKey: ['uso'] });
    const results: UsoServerResult[] = [];
    const aplicar = () => {
      merged = mergeUso(results, p);
      if (merged.report.by_conta.length) contasVistas = merged.report.by_conta;
    };
    await Promise.all(
      alvo.map(async (s) => {
        let result: UsoServerResult;
        try { result = { report: await buscarEsperandoAquecer(s, p, c, meu), label: s.label, id: s.id }; }
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
  $effect(() => { const p = period; const c = conta; chaveAtivos; load(p, c, untrack(() => servidoresAtivos)); });

  const report = $derived(merged.report);
  const rate = $derived(report.usd_brl ?? null);
  const moeda = (n: number) => money(n, currency, rate);
  const m2 = (n: number) => money2(n, currency, rate);
  const vazioNoPeriodo = $derived(!loading && report.totals.chamadas === 0 && report.totals.ctx_chars === 0);
  const tokensReais = (b: UsoBucket) => b.input + b.output + b.cache_write + b.cache_read;
  const media = (b: UsoBucket) => (b.sessions > 0 ? b.ctx_tokens_est / b.sessions : 0);

  // Cada tabela mostra as N primeiras; o resto abre no clique. Mesma régua pra todas.
  const TOPO = 15;
  let expandidas = $state<Set<string>>(new Set());
  function alternar(sec: string) {
    const s = new Set(expandidas);
    if (s.has(sec)) s.delete(sec); else s.add(sec);
    expandidas = s;
  }
  const visiveis = (sec: string, lista: UsoBucket[]) => (expandidas.has(sec) ? lista : lista.slice(0, TOPO));

  // Só a tabela de contexto tem "≈ tok / sessão"; só skills, agentes e plugins têm custo/tokens
  // reais; agente não injeta contexto (o custo dele é o transcript filho).
  type Sec = { id: string; titulo: string; nota?: string; colNome: string; lista: UsoBucket[];
    custo: boolean; media: boolean; plugin: boolean; ctx: boolean; origem?: string };
  const secoes = $derived<Sec[]>([
    // `origem`: título da coluna "quem pediu". Skill é exata (barra × ferramenta); agente é
    // heurística pelo prompt do turno — o "≈" no cabeçalho vem da chave i18n.
    { id: 'skill', titulo: m.uso_sec_skills(), nota: m.uso_sec_skills_nota(), colNome: m.uso_col_nome(), lista: report.by_skill, custo: true, media: false, plugin: true, ctx: true, origem: m.uso_col_origem_skill() },
    { id: 'agente', titulo: m.uso_sec_agentes(), nota: m.uso_sec_agentes_nota(), colNome: m.uso_col_tipo(), lista: report.by_agente, custo: true, media: false, plugin: false, ctx: false, origem: m.uso_col_origem_agente() },
    { id: 'plugin', titulo: m.uso_sec_plugins(), nota: m.uso_sec_plugins_nota(), colNome: m.uso_col_plugin(), lista: report.by_plugin, custo: true, media: false, plugin: false, ctx: true },
    { id: 'contexto', titulo: m.uso_sec_contexto(), nota: m.uso_sec_contexto_nota(), colNome: m.uso_col_nome(), lista: report.by_contexto, custo: false, media: true, plugin: true, ctx: true },
    { id: 'tool', titulo: m.uso_sec_tools(), colNome: m.uso_col_nome(), lista: report.by_tool, custo: false, media: false, plugin: false, ctx: true },
    { id: 'bash', titulo: m.uso_sec_bash(), nota: m.uso_sec_bash_nota(), colNome: m.uso_col_comando(), lista: report.by_bash, custo: false, media: false, plugin: false, ctx: true },
    { id: 'mcp', titulo: m.uso_sec_mcp(), colNome: m.uso_col_servidor(), lista: report.by_mcp, custo: false, media: false, plugin: false, ctx: true },
  ]);
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
    <button class="clear" disabled={loading || pendingServers > 0} onclick={() => load(period, conta, servidoresAtivos, true)}>{m.custos_atualizar()}</button>
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
    {#if contasVistas.length > 1 || conta}
      <span class="conta">
        <Select ariaLabel={m.uso_conta()} value={conta}
          opcoes={[{ value: '', label: m.custos_todas_n({ n: contasVistas.length }) },
                   ...contasVistas.map((b) => ({ value: b.key, label: rotuloConta(b), title: b.key, hint: dec(b.chamadas, 0) }))]}
          onchange={(v) => (conta = v)} />
      </span>
    {/if}
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
      <button class="retry" onclick={() => load(period, conta, servidoresAtivos, true)}>{m.config_server_tentar_de_novo()}</button>
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
      <div class="kpi"><dt>{m.uso_kpi_chamadas()}</dt><dd>{tok(report.totals.chamadas)}</dd></div>
      <div class="kpi"><dt>{m.uso_kpi_ctx()}</dt><dd>≈ {tok(report.totals.ctx_tokens_est)}</dd></div>
      <div class="kpi"><dt>{m.uso_kpi_sessoes()}</dt><dd>{dec(report.totals.sessions, 0)}</dd></div>
    </dl>

    {#each secoes as sec (sec.id)}
      <section class="card">
        <h2>{sec.titulo}</h2>
        {#if sec.nota}<p class="hint">{sec.nota}</p>{/if}
        {#if !sec.lista.length}
          <p class="muted">{m.uso_vazio_secao()}</p>
        {:else}
          <div class="scroll">
            <table class="data">
              <thead>
                <tr>
                  <th>{sec.colNome}</th>
                  {#if sec.plugin}<th>{m.uso_col_plugin()}</th>{/if}
                  <th class="n">{m.uso_col_chamadas()}</th>
                  {#if sec.origem}<th class="n">{sec.origem}</th>{/if}
                  <th class="n">{m.uso_col_sessoes()}</th>
                  {#if sec.ctx}<th class="n">{m.uso_col_ctx()}</th>{/if}
                  {#if sec.media}<th class="n">{m.uso_col_media()}</th>{/if}
                  {#if sec.custo}<th class="n">{m.uso_col_tokens()}</th><th class="n">{m.uso_col_custo()}</th>{/if}
                </tr>
              </thead>
              <tbody>
                {#each visiveis(sec.id, sec.lista) as b (b.key)}
                  <tr>
                    <td class="nome" title={b.key}>{b.label ?? b.key}</td>
                    {#if sec.plugin}<td class="dim">{b.plugin || '—'}</td>{/if}
                    <td class="n">{dec(b.chamadas, 0)}</td>
                    {#if sec.origem}<td class="n">{dec(b.pedidas, 0)} <span class="dim">/ {dec(b.chamadas - b.pedidas, 0)}</span></td>{/if}
                    <td class="n">{dec(b.sessions, 0)}</td>
                    {#if sec.ctx}<td class="n">≈ {tok(b.ctx_tokens_est)}</td>{/if}
                    {#if sec.media}<td class="n">≈ {tok(media(b))}</td>{/if}
                    {#if sec.custo}
                      <td class="n">{tok(tokensReais(b))}</td>
                      <td class="c">{b.cost > 0 ? m2(b.cost) : '—'}</td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if sec.lista.length > TOPO}
            <button class="retry" onclick={() => alternar(sec.id)}>
              {expandidas.has(sec.id) ? m.uso_mostrar_menos() : m.uso_mostrar_mais({ n: sec.lista.length - TOPO })}
            </button>
          {/if}
        {/if}
      </section>
    {/each}
  {/if}
 </div>
</div>

<style>
  .uso {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: var(--navbar-fade) var(--space-4) var(--space-10);
  }
  .inner { max-width: 1120px; margin-inline: auto; }
  .page-intro { display: flex; align-items: start; gap: var(--space-4); margin-bottom: var(--space-5); }
  .page-intro h1 { font-size: var(--text-xl); font-weight: 650; margin-bottom: var(--space-1); }
  .page-intro p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; max-width: 70ch; }
  .page-intro .clear { flex: none; }
  .link { font-size: var(--text-sm); color: var(--accent); }
  .period-toolbar { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); align-items: center; }
  .conta { min-width: 220px; }
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
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .kpis.overview { border-block: 1px solid var(--border-subtle); padding-block: var(--space-4); }
  .kpi { padding: var(--space-2); min-width: 0; }
  .kpi dt { font-size: var(--text-xs); color: var(--text-muted); margin-bottom: 6px; }
  .kpi dd { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .kpi dd.hero { color: var(--accent); font-size: 30px; }
  .kpi .foot { font-size: var(--text-xs); color: var(--text-secondary); margin-top: 6px; }
  .card { margin-bottom: var(--space-6); }
  .card h2 { font-size: var(--text-base); font-weight: 650; margin-bottom: var(--space-1); }
  .card .hint { font-size: var(--text-xs); color: var(--text-secondary); margin-bottom: var(--space-3); max-width: 80ch; }
  .scroll { overflow-x: auto; }
  table.data { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  table.data th {
    text-align: left; font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.03em;
    color: var(--text-muted); font-weight: 600; padding: 0 var(--space-2) var(--space-2); white-space: nowrap;
  }
  table.data td { padding: 7px var(--space-2); border-top: 1px solid var(--border-subtle); white-space: nowrap; }
  table.data td.nome { max-width: 46ch; overflow: hidden; text-overflow: ellipsis; }
  table.data th.n, table.data td.n { text-align: right; font-variant-numeric: tabular-nums; }
  table.data td.c { font-weight: 650; color: var(--accent); text-align: right; font-variant-numeric: tabular-nums; }
</style>
