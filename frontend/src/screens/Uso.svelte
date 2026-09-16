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

  // ── Estado de carga ──────────────────────────────────────────────────────────
  // `merged` só é null antes da PRIMEIRA resposta: depois disso a tela nunca esvazia. Trocar
  // filtro/período mostra uma barra fina de "atualizando" por cima do que já está montado.
  let merged = $state<MergedUso | null>(null);
  let atualizando = $state(false);
  let pendingServers = $state(0);
  let period = $state<Periodo>('30d');
  let currency = $state<Cur>(localStorage.getItem('cp_costs_currency') === 'BRL' ? 'BRL' : 'USD');
  function setCurrency(c: Cur) { currency = c; localStorage.setItem('cp_costs_currency', c); }

  // Mesmas máquinas desmarcadas da tela de custos (cp_costs_servers_off).
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

  // Filtros do servidor. `foco` NÃO entra aqui: a série de um item é consulta própria do painel
  // de detalhe, pra clicar numa linha não refazer a tela inteira.
  let filtros = $state<UsoFiltros>({});
  let busca = $state('');
  type DimF = 'conta' | 'projeto' | 'modelo' | 'plugin';
  const DIMS_F: DimF[] = ['conta', 'projeto', 'modelo', 'plugin'];
  const temFiltro = $derived(DIMS_F.some((d) => (filtros[d]?.length ?? 0) > 0));
  let listas = $state<{ conta: UsoBucket[]; projeto: UsoBucket[]; modelo: UsoBucket[]; plugin: UsoBucket[] }>({
    conta: [], projeto: [], modelo: [], plugin: [],
  });
  function setFiltro(k: DimF, v: string[]) { filtros = { ...filtros, [k]: v.length ? v : undefined }; }
  function limpar() { filtros = {}; busca = ''; }
  // Rótulo do chip: "conta: todas", "conta: um@x" ou "conta: 2 de 5".
  function rotuloFiltro(d: DimF, todos: string, nome: (k: string) => string): (v: string[]) => string {
    const texto = { conta: m.uso_filtro_conta, projeto: m.uso_filtro_projeto, modelo: m.uso_filtro_modelo, plugin: m.uso_filtro_plugin }[d];
    return (v) => texto({ v: v.length === 0 ? todos : v.length === 1 ? nome(v[0]) : m.uso_n_de_m({ n: v.length, m: listas[d].length }) });
  }

  let desktop = $state(window.matchMedia('(min-width: 820px)').matches);
  $effect(() => {
    const mq = window.matchMedia('(min-width: 820px)');
    const f = () => (desktop = mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  });

  // 202 "aquecendo": faixa com progresso e repergunta a cada 3 s.
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
    atualizando = true;
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
        plugin: !f.plugin?.length && r.by_plugin.length ? r.by_plugin : listas.plugin,
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
      }),
    );
    if (meu !== geracao) return;
    aplicar();
    atualizando = false;
  }
  const chaveAtivos = $derived(servidoresAtivos.map((s) => `${s.id}|${s.baseUrl}|${s.token}`).join('\n'));
  const chaveFiltros = $derived(JSON.stringify(filtros));
  $effect(() => { const p = period; chaveFiltros; chaveAtivos; load(p, untrack(() => filtros), untrack(() => servidoresAtivos)); });

  const report = $derived(merged?.report ?? null);
  const rate = $derived(report?.usd_brl ?? null);
  const moeda = (n: number) => money(n, currency, rate);
  const m2 = (n: number) => money2(n, currency, rate);
  const vazioNoPeriodo = $derived(!!report && !atualizando && report.totals.chamadas === 0 && report.totals.ctx_chars === 0);
  const tokensReais = (b: UsoBucket) => b.input + b.output + b.cache_write + b.cache_read;
  const porChamada = (b: UsoBucket) => (b.chamadas > 0 ? b.cost / b.chamadas : 0);
  const ctxPorChamada = (b: UsoBucket) => (b.chamadas > 0 ? b.ctx_tokens_est / b.chamadas : 0);
  const porSessao = (b: UsoBucket) => (b.sessions > 0 ? b.ctx_tokens_est / b.sessions : 0);
  const totalImagens = $derived((report?.by_imagem ?? []).reduce((n, b) => n + b.chamadas, 0));
  const custoAgentes = $derived((report?.by_agente ?? []).reduce((n, b) => n + b.cost, 0));
  const ctxSkills = $derived((report?.by_skill ?? []).reduce((n, b) => n + b.ctx_tokens_est, 0));
  const ctxPorSessaoTotal = $derived(report && report.totals.sessions > 0
    ? report.by_contexto.reduce((n, b) => n + b.ctx_tokens_est, 0) / report.totals.sessions : 0);

  // ── Seleção + detalhe (consulta própria com `foco`) ──────────────────────────
  type Aba = 'skill' | 'agente' | 'plugin' | 'tool' | 'bash' | 'mcp' | 'imagem' | 'contexto';
  let aba = $state<Aba>('skill');
  let selecionado = $state<{ aba: Aba; key: string } | null>(null);
  let serie = $state<UsoBucket[]>([]);
  let serieCarregando = $state(false);
  const itemSelecionado = $derived.by(() => {
    if (!report || !selecionado) return null;
    return listaDa(selecionado.aba).find((b) => b.key === selecionado!.key) ?? null;
  });
  function selecionar(a: Aba, key: string) {
    selecionado = selecionado?.key === key && selecionado.aba === a ? null : { aba: a, key };
  }
  $effect(() => {
    const sel = selecionado;
    const p = period;
    const f = filtros;
    const alvo = servidoresAtivos;
    if (!sel) { serie = []; return; }
    let vivo = true;
    serieCarregando = true;
    Promise.all(alvo.map((s) => clienteQuery.fetchQuery(uso(s, p, { ...f, foco: sel.key })).catch(() => null)))
      .then((rs) => {
        if (!vivo) return;
        serie = mergeUso(rs.map((r, i) => ({ report: r, id: alvo[i].id, label: alvo[i].label })), p).report.by_day;
        serieCarregando = false;
      });
    return () => { vivo = false; };
  });

  // ── Tabela com abas ──────────────────────────────────────────────────────────
  // `custo`: só AGENTES têm custo real (o transcript do subagente). Skill e plugin carregam
  // `turno`: o gasto do turno inteiro em que rodaram, que inclui o trabalho que veio depois; a
  // medida de peso de uma skill é o CONTEXTO que ela injeta (tamanho × vezes), exato.
  const ABAS: { id: Aba; label: string; custo: boolean; turno: boolean }[] = [
    { id: 'skill', label: m.uso_aba_skills(), custo: false, turno: true },
    { id: 'agente', label: m.uso_aba_agentes(), custo: true, turno: false },
    { id: 'plugin', label: m.uso_aba_plugins(), custo: false, turno: true },
    { id: 'tool', label: m.uso_aba_tools(), custo: false, turno: false },
    { id: 'bash', label: m.uso_aba_bash(), custo: false, turno: false },
    { id: 'mcp', label: m.uso_aba_mcp(), custo: false, turno: false },
    { id: 'contexto', label: m.uso_aba_contexto(), custo: false, turno: false },
    { id: 'imagem', label: m.uso_aba_imagens(), custo: false, turno: false },
  ];
  function listaDa(a: Aba): UsoBucket[] {
    if (!report) return [];
    return ({ skill: report.by_skill, agente: report.by_agente, plugin: report.by_plugin, tool: report.by_tool,
      bash: report.by_bash, mcp: report.by_mcp, contexto: report.by_contexto, imagem: report.by_imagem })[a];
  }
  const rotulo = (a: Aba, b: UsoBucket) =>
    a === 'imagem' ? (b.key === 'enviada' ? m.uso_img_enviada() : m.uso_img_lida({ tool: b.key.replace(/^lida:/, '') })) : (b.label ?? b.key);
  type Col = 'nome' | 'chamadas' | 'cost' | 'custoChamada' | 'ctx' | 'ctxChamada' | 'sessions' | 'porSessao';
  const valorDe = (b: UsoBucket, c: Col): number | string => ({
    nome: b.label ?? b.key, chamadas: b.chamadas, cost: b.cost, custoChamada: porChamada(b),
    ctx: b.ctx_tokens_est, ctxChamada: ctxPorChamada(b), sessions: b.sessions, porSessao: porSessao(b),
  })[c];
  let ordem = $state<Partial<Record<Aba, { col: Col; desc: boolean }>>>({});
  const abaAtual = $derived(ABAS.find((a) => a.id === aba)!);
  const padrao = $derived<Col>(abaAtual.custo ? 'cost' : 'ctx');
  const ordemAtual = $derived(ordem[aba] ?? { col: padrao, desc: true });
  function ordenar(col: Col) {
    const o = ordemAtual;
    ordem = { ...ordem, [aba]: o.col === col ? { col, desc: !o.desc } : { col, desc: col !== 'nome' } };
  }
  const linhas = $derived.by(() => {
    const termo = busca.trim().toLowerCase();
    const base = listaDa(aba).filter((b) => !termo || rotulo(aba, b).toLowerCase().includes(termo) || (b.plugin ?? '').toLowerCase().includes(termo));
    const o = ordemAtual;
    return [...base].sort((a, b) => {
      const va = valorDe(a, o.col), vb = valorDe(b, o.col);
      const r = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - vb;
      return (o.desc ? -r : r) || a.key.localeCompare(b.key);
    });
  });
  const maxChamadas = $derived(Math.max(...linhas.map((b) => b.chamadas), 1));
  const maxCusto = $derived(Math.max(...linhas.map((b) => b.cost), 0.000001));
  const maxCtx = $derived(Math.max(...linhas.map((b) => b.ctx_tokens_est), 1));
  // Fora da curva: custo/chamada ≥ 3× a mediana da aba — é a linha "chamei 3 vezes e gastou 1M".
  const medianaChamada = $derived.by(() => {
    const v = linhas.map(porChamada).filter((x) => x > 0).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  });
  const foraDaCurva = (b: UsoBucket) => medianaChamada > 0 && b.chamadas >= 1 && porChamada(b) >= 3 * medianaChamada;
  const medianaCtxChamada = $derived.by(() => {
    const v = linhas.map(ctxPorChamada).filter((x) => x > 0).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  });
  const foraDaCurvaCtx = (b: UsoBucket) => medianaCtxChamada > 0 && ctxPorChamada(b) >= 3 * medianaCtxChamada;
  const cols = $derived<{ col: Col; rotulo: string; n?: boolean; titulo?: string }[]>([
    { col: 'nome', rotulo: m.uso_col_nome() },
    { col: 'chamadas', rotulo: m.uso_col_chamadas(), n: true },
    ...(abaAtual.custo
      ? [{ col: 'cost' as Col, rotulo: m.uso_col_custo(), n: true }, { col: 'custoChamada' as Col, rotulo: m.uso_col_custo_chamada(), n: true }]
      : [{ col: 'ctx' as Col, rotulo: m.uso_col_ctx(), n: true },
         aba === 'contexto' ? { col: 'porSessao' as Col, rotulo: m.uso_col_media(), n: true } : { col: 'ctxChamada' as Col, rotulo: m.uso_col_ctx_chamada(), n: true }]),
    ...(abaAtual.turno ? [{ col: 'cost' as Col, rotulo: m.uso_col_custo_turno(), n: true, titulo: m.uso_custo_turno_nota() }] : []),
    { col: 'sessions', rotulo: m.uso_col_sessoes(), n: true },
  ]);
  const TOPO = 20;
  let expandida = $state(false);
  $effect(() => { aba; expandida = false; });

  // ── Gráfico principal: chamadas × custo (bolhas, log-log) ────────────────────
  let larguraBolhas = $state(0);
  let hoverBolha = $state<string | null>(null);
  // Dois modos, uma medida cada (nunca custo e contexto no mesmo eixo): skills pesam pelo
  // contexto que injetam; agentes, pelo custo real do transcript filho.
  let modoBolhas = $state<'skills' | 'agentes'>('skills');
  const medidaBolha = (b: UsoBucket) => (modoBolhas === 'skills' ? b.ctx_tokens_est : b.cost);
  const medidaPorChamada = (b: UsoBucket) => (b.chamadas > 0 ? medidaBolha(b) / b.chamadas : 0);
  const fmtMedida = (v: number) => (modoBolhas === 'skills' ? `≈ ${tok(v)}` : m2(v));
  const bolhas = $derived.by(() => {
    if (!report) return null;
    const tipo: Aba = modoBolhas === 'skills' ? 'skill' : 'agente';
    const itens = (modoBolhas === 'skills' ? report.by_skill : report.by_agente)
      .filter((b) => b.chamadas > 0 && medidaBolha(b) > 0).map((b) => ({ b, tipo }));
    if (!itens.length) return null;
    const W = Math.max(larguraBolhas, 320), H = desktop ? 380 : 300;
    const padL = 66, padR = 16, padT = 22, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    // Eixo Y na moeda/unidade que a tela mostra, senão os ticks "redondos" saem R$ 5,15.
    const fatorY = modoBolhas === 'agentes' && currency === 'BRL' && rate ? rate : 1;
    const lx = itens.map(({ b }) => Math.log10(b.chamadas));
    const ly = itens.map(({ b }) => Math.log10(medidaBolha(b) * fatorY));
    const x0 = Math.min(...lx) - 0.15, x1 = Math.max(...lx) + 0.15;
    const y0 = Math.min(...ly) - 0.15, y1 = Math.max(...ly) + 0.15;
    const sx = (v: number) => padL + ((v - x0) / (x1 - x0 || 1)) * plotW;
    const sy = (v: number) => padT + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
    const pcMax = Math.max(...itens.map(({ b }) => medidaPorChamada(b)));
    const med = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const mx = sx(med(lx)), my = sy(med(ly));
    const pontos = itens.map(({ b, tipo }, i) => ({
      b, tipo, x: sx(lx[i]), y: sy(ly[i]),
      r: 4 + 14 * Math.sqrt(medidaPorChamada(b) / (pcMax || 1)),
    }));
    // Rótulo direto só nos que importam (3 maiores no total, 3 maiores por chamada), e nunca
    // dois rótulos em cima um do outro: o segundo que cair a menos de 14px do primeiro fica só
    // no tooltip. Perto da borda direita o texto vai pra esquerda da bolha.
    const candidatos = [
      ...[...pontos].sort((p, q) => medidaBolha(q.b) - medidaBolha(p.b)).slice(0, 3),
      ...[...pontos].sort((p, q) => medidaPorChamada(q.b) - medidaPorChamada(p.b)).slice(0, 3),
    ];
    const rotulados = new Map<string, { x: number; y: number; fim: boolean; texto: string }>();
    const maxRotulos = desktop ? 6 : 3;
    for (const p of candidatos) {
      if (rotulados.has(p.b.key) || rotulados.size >= maxRotulos) continue;
      const colide = [...rotulados.values()].some((r) => Math.abs(r.y - p.y) < 14 && Math.abs(r.x - p.x) < 160);
      if (colide) continue;
      const fim = p.x > padL + plotW * 0.72;
      const nome = p.b.label ?? p.b.key;
      const texto = desktop || nome.length <= 22 ? nome : nome.slice(0, 20) + '…';
      rotulados.set(p.b.key, { x: fim ? p.x - p.r - 4 : p.x + p.r + 4, y: p.y + 4, fim, texto });
    }
    const ticks = (v0: number, v1: number) => {
      const out: number[] = [];
      for (let e = Math.ceil(v0); e <= Math.floor(v1); e++) out.push(e);
      return out;
    };
    return { W, H, padL, padT, plotW, plotH, mx, my, pontos, rotulados, fatorY, xt: ticks(x0, x1).map((e) => ({ x: sx(e), v: 10 ** e })), yt: ticks(y0, y1).map((e) => ({ y: sy(e), v: 10 ** e })) };
  });
  const bolhaHover = $derived(bolhas?.pontos.find((p) => p.b.key === hoverBolha) ?? null);

  // ── Por dia e contexto (como antes) ──────────────────────────────────────────
  const ALT = 140;
  let larguraDia = $state(0);
  let hoverDia = $state<number | null>(null);
  let hoverCtx = $state<number | null>(null);
  const dias = $derived(report?.by_day ?? []);
  function colunas(lista: UsoBucket[], valor: (b: UsoBucket) => number, largura: number, alt = ALT) {
    const n = lista.length;
    const padL = 6, padR = 6, padT = 8, padB = 20;
    const W = Math.max(largura, 160), H = alt;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const teto = Math.max(...lista.map(valor), 0) || 1;
    const passo = n ? plotW / n : plotW;
    const bw = Math.min(22, Math.max(2, passo - 2));
    return {
      W, H, padT, plotH, base: padT + plotH,
      barras: lista.map((b, i) => {
        const v = valor(b);
        const h = Math.max(v > 0 ? 2 : 0, (v / teto) * plotH);
        return { b, v, x: padL + i * passo + (passo - bw) / 2, w: bw, y: padT + plotH - h, h, cx: padL + i * passo + passo / 2 };
      }),
      rotulos: n ? [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => ({ i, x: padL + i * passo + passo / 2 })) : [],
    };
  }
  const grafChamadas = $derived(colunas(dias, (b) => b.chamadas, larguraDia));
  const grafCusto = $derived(colunas(dias, (b) => b.cost, larguraDia));
  const grafSerie = $derived(colunas(serie, (b) => (abaAtual.custo ? b.cost : b.ctx_tokens_est), 300, 90));
  const diaCurto = (k: string) => k.slice(5).replace('-', '/');

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
    for (const b of report?.by_contexto ?? []) soma[categoria(b.key)] += b.ctx_tokens_est;
    const sessoes = report?.totals.sessions || 1;
    const total = Object.values(soma).reduce((a, b) => a + b, 0) || 1;
    return CATS.map((c) => ({ ...c, tokens: soma[c.id], porSessao: soma[c.id] / sessoes, frac: soma[c.id] / total }));
  });

  const nomeConta = (k: string) => listas.conta.find((b) => b.key === k)?.label ?? k;
</script>

<NavBar title={m.nav_uso()} showBack={true} onBack={onBack} />

<div class="uso">
 <div class="inner">
  <header class="topo">
    <div class="titulo">
      <h1>{m.uso_titulo()}</h1>
      <a class="link" href="#/costs">{m.uso_ir_custos()}</a>
    </div>
    <div class="toolbar">
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
      <button class="clear" disabled={atualizando} onclick={() => load(period, filtros, servidoresAtivos, true)}>{m.custos_atualizar()}</button>
    </div>
  </header>

  <!-- Filtros como uma linha de seletores, sem caixa: cada um mostra o valor atual no próprio botão. -->
  <div class="filtros" role="group" aria-label={m.uso_filtros()}>
    <!-- Múltipla escolha: a opção vazia é "todas"; marcar várias soma as contas/projetos/… -->
    <span class="fsel" class:ativo={!!filtros.conta?.length}><Select ariaLabel={m.uso_conta()} value="" onchange={() => {}} class="chipsel"
      values={filtros.conta ?? []} onchangeMulti={(v) => setFiltro('conta', v)}
      rotuloMulti={rotuloFiltro('conta', m.uso_todas(), (k) => listas.conta.find((b) => b.key === k)?.label ?? k)}
      opcoes={[{ value: '', label: m.uso_todas() },
               ...listas.conta.map((b) => ({ value: b.key, label: b.label ?? b.key, title: b.key, hint: moeda(b.cost) }))]} /></span>
    <span class="fsel" class:ativo={!!filtros.projeto?.length}><Select ariaLabel={m.uso_projeto()} value="" onchange={() => {}} class="chipsel"
      values={filtros.projeto ?? []} onchangeMulti={(v) => setFiltro('projeto', v)}
      rotuloMulti={rotuloFiltro('projeto', m.uso_todos(), projectLabel)}
      opcoes={[{ value: '', label: m.uso_todos() },
               ...listas.projeto.map((b) => ({ value: b.key, label: projectLabel(b.key), title: b.key, hint: moeda(b.cost) }))]} /></span>
    <span class="fsel" class:ativo={!!filtros.modelo?.length}><Select ariaLabel={m.uso_modelo()} value="" onchange={() => {}} class="chipsel"
      values={filtros.modelo ?? []} onchangeMulti={(v) => setFiltro('modelo', v)}
      rotuloMulti={rotuloFiltro('modelo', m.uso_todos(), (k) => k)}
      opcoes={[{ value: '', label: m.uso_todos() },
               ...listas.modelo.map((b) => ({ value: b.key, label: b.key, hint: moeda(b.cost) }))]} /></span>
    <span class="fsel" class:ativo={!!filtros.plugin?.length}><Select ariaLabel={m.uso_plugin()} value="" onchange={() => {}} class="chipsel"
      values={filtros.plugin ?? []} onchangeMulti={(v) => setFiltro('plugin', v)}
      rotuloMulti={rotuloFiltro('plugin', m.uso_todos(), (k) => k)}
      opcoes={[{ value: '', label: m.uso_todos() },
               ...listas.plugin.map((b) => ({ value: b.key, label: b.key, hint: dec(b.chamadas, 0) }))]} /></span>
    <input class="busca" type="search" placeholder={m.uso_busca()} bind:value={busca} aria-label={m.uso_busca()} />
    {#if servidores.length > 1}
      <button class="chip" aria-expanded={mostrarServidores} onclick={() => (mostrarServidores = !mostrarServidores)}>
        {m.custos_de_servidores({ n: servidoresAtivos.length, m: servidores.length })}
      </button>
    {/if}
    {#if temFiltro || busca}
      <button class="retry" onclick={limpar}>{m.uso_limpar()}</button>
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

  <div class="faixa-status" aria-live="polite">
    {#if atualizando && merged}<span class="atualizando"><span class="pulso"></span>{m.uso_atualizando()}</span>{/if}
    {#if merged?.partial}
      <span class="warn">
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
      </span>
    {/if}
    {#each Object.values(aquecendo) as a (a.label)}
      <span class="aquecendo">
        {a.total > 0 ? m.custos_aquecendo_progresso({ maquina: a.label, lidos: a.lidos, total: a.total }) : m.custos_aquecendo({ maquina: a.label })}
        <progress max={a.total || undefined} value={a.total ? a.lidos : undefined}></progress>
      </span>
    {/each}
  </div>

  {#if !report}
    <div class="esqueleto" aria-label={m.uso_carregando_primeira()}>
      <div class="bloco kpi-sk"></div><div class="bloco grande"></div><div class="bloco medio"></div>
    </div>
  {:else if vazioNoPeriodo}
    <p class="muted vazio">{m.uso_vazio()}</p>
  {:else}
    <dl class="numeros">
      <div><dt>{m.uso_kpi_custo_agentes()}</dt><dd>{moeda(custoAgentes)}</dd></div>
      <div><dt>{m.uso_kpi_ctx_skills()}</dt><dd>≈ {tok(ctxSkills)}</dd></div>
      <div><dt>{m.uso_kpi_chamadas()}</dt><dd>{tok(report.totals.chamadas)}</dd></div>
      <div><dt>{m.uso_graf_ctx()}</dt><dd>≈ {tok(ctxPorSessaoTotal)}</dd></div>
      <div><dt>{m.uso_kpi_imagens()}</dt><dd>{dec(totalImagens, 0)}</dd></div>
      <div><dt>{m.uso_kpi_sessoes()}</dt><dd>{dec(report.totals.sessions, 0)}</dd></div>
    </dl>

    <div class="painel" class:com-detalhe={desktop && itemSelecionado}>
      <div class="principal">
        <section class="bloco-graf hero">
          <div class="cab">
            <div>
              <h2>{m.uso_graf_bolhas()}</h2>
              <p class="hint">{modoBolhas === 'skills' ? m.uso_graf_bolhas_nota_skills() : m.uso_graf_bolhas_nota_agentes()}</p>
            </div>
            <span class="seg" role="group" aria-label={m.uso_graf_bolhas()}>
              <button aria-pressed={modoBolhas === 'skills'} onclick={() => (modoBolhas = 'skills')}>{m.uso_modo_skills()}</button>
              <button aria-pressed={modoBolhas === 'agentes'} onclick={() => (modoBolhas = 'agentes')}>{m.uso_modo_agentes()}</button>
            </span>
          </div>
          <div class="svgbox" bind:clientWidth={larguraBolhas}>
            {#if bolhas}
              <svg viewBox="0 0 {bolhas.W} {bolhas.H}" width={bolhas.W} height={bolhas.H} role="img" aria-label={m.uso_graf_bolhas()}
                   onmouseleave={() => (hoverBolha = null)}>
                <!-- quadrantes: linhas na mediana, rótulos nos cantos, em tinta de texto -->
                <line x1={bolhas.mx} x2={bolhas.mx} y1={bolhas.padT} y2={bolhas.padT + bolhas.plotH} class="mediana" />
                <line x1={bolhas.padL} x2={bolhas.padL + bolhas.plotW} y1={bolhas.my} y2={bolhas.my} class="mediana" />
                <!-- rótulos de cima ficam ACIMA da área das bolhas, pra não brigar com o nome de um item no canto -->
                <text x={bolhas.padL + 6} y={12} class="quad">{m.uso_quad_raras_pesadas()}</text>
                <text x={bolhas.padL + bolhas.plotW - 6} y={12} text-anchor="end" class="quad">{m.uso_quad_freq_pesadas()}</text>
                <text x={bolhas.padL + 6} y={bolhas.padT + bolhas.plotH - 6} class="quad">{m.uso_quad_raras_leves()}</text>
                <text x={bolhas.padL + bolhas.plotW - 6} y={bolhas.padT + bolhas.plotH - 6} text-anchor="end" class="quad">{m.uso_quad_freq_leves()}</text>                {#each bolhas.xt as t (t.v)}
                  {#if t.x < bolhas.padL + bolhas.plotW - 90}
                    <text x={t.x} y={bolhas.H - 8} text-anchor="middle" class="tick">{dec(t.v, 0)}</text>
                  {/if}
                {/each}
                {#each bolhas.yt as t (t.v)}
                  <text x={bolhas.padL - 6} y={t.y + 3} text-anchor="end" class="tick">{modoBolhas === 'skills' ? tok(t.v) : money(t.v / bolhas.fatorY, currency, rate)}</text>
                {/each}
                <text x={bolhas.padL + bolhas.plotW} y={bolhas.H - 8} text-anchor="end" class="eixo-nome">{m.uso_eixo_chamadas()}</text>
                {#each bolhas.pontos as p (p.b.key)}
                  <circle cx={p.x} cy={p.y} r={p.r} fill={p.tipo === 'skill' ? 'var(--chart-1)' : 'var(--chart-2)'}
                          class="bolha" class:apagada={hoverBolha !== null && hoverBolha !== p.b.key}
                          class:sel={selecionado?.key === p.b.key} />
                  {#if bolhas.rotulados.get(p.b.key)}
                    {@const r = bolhas.rotulados.get(p.b.key)!}
                    <text x={r.x} y={r.y} text-anchor={r.fim ? 'end' : 'start'} class="rotulo">{r.texto}</text>
                  {/if}
                  <!-- alvo maior que a bolha -->
                  <circle cx={p.x} cy={p.y} r={Math.max(p.r + 6, 14)} fill="transparent" role="presentation"
                          onmouseenter={() => (hoverBolha = p.b.key)} onclick={() => { aba = p.tipo; selecionar(p.tipo, p.b.key); }} />
                {/each}
              </svg>
              {#if bolhaHover}
                <div class="tip" style="left: {Math.min(Math.max(bolhaHover.x, 90), bolhas.W - 90)}px; top: {Math.max(bolhaHover.y - bolhaHover.r - 54, 0)}px">
                  <b>{bolhaHover.b.label ?? bolhaHover.b.key}</b>
                  <span>{dec(bolhaHover.b.chamadas, 0)} {m.uso_graf_chamadas()} · {fmtMedida(medidaBolha(bolhaHover.b))} · {fmtMedida(medidaPorChamada(bolhaHover.b))} {m.uso_por_chamada()}</span>
                </div>
              {/if}
            {:else}
              <p class="muted">{m.uso_vazio_secao()}</p>
            {/if}
          </div>
        </section>

        <div class="linha-graf">
          <section class="bloco-graf">
            <div class="cab"><h2>{m.uso_graf_dia()}</h2></div>
            {#if !dias.length}
              <p class="muted">{m.uso_sem_dias()}</p>
            {:else}
              <div class="duplo" bind:clientWidth={larguraDia}>
                {#each [{ g: grafChamadas, titulo: m.uso_graf_chamadas(), fmt: (v: number) => tok(v), cor: 'var(--chart-1)' },
                        { g: grafCusto, titulo: m.uso_graf_custo(), fmt: (v: number) => m2(v), cor: 'var(--chart-2)' }] as p (p.titulo)}
                  <div class="mini">
                    <h3>{p.titulo}</h3>
                    <div class="svgbox">
                      <svg viewBox="0 0 {p.g.W} {p.g.H}" width={p.g.W} height={p.g.H} role="img" aria-label={p.titulo} onmouseleave={() => (hoverDia = null)}>
                        <line x1="0" x2={p.g.W} y1={p.g.base} y2={p.g.base} class="eixo" />
                        {#each p.g.barras as c, i (c.b.key)}
                          <rect x={c.x} y={c.y} width={c.w} height={c.h} rx="3" fill={p.cor} opacity={hoverDia === null || hoverDia === i ? 1 : 0.45} />
                          <rect x={c.cx - Math.max(c.w, 12) / 2} y={p.g.padT} width={Math.max(c.w, 12)} height={p.g.plotH}
                                fill="transparent" role="presentation" onmouseenter={() => (hoverDia = i)} />
                        {/each}
                        {#each p.g.rotulos as r (r.i)}
                          <text x={r.x} y={p.g.H - 6} text-anchor="middle" class="tick">{diaCurto(dias[r.i].key)}</text>
                        {/each}
                      </svg>
                      {#if hoverDia !== null && p.g.barras[hoverDia]}
                        <div class="tip" style="left: {Math.min(Math.max(p.g.barras[hoverDia].cx, 60), p.g.W - 60)}px; top: 0">
                          <b>{p.fmt(p.g.barras[hoverDia].v)}</b><span>{dias[hoverDia].key}</span>
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>

          <section class="bloco-graf">
            <div class="cab">
              <h2>{m.uso_graf_ctx()}</h2>
              <span class="total">≈ {tok(ctxPorSessaoTotal)} <span class="dim">{m.uso_por_sessao()}</span></span>
            </div>
            <div class="pilha" role="img" aria-label={m.uso_graf_ctx()} onmouseleave={() => (hoverCtx = null)}>
              {#each ctxPorCat as s, i (s.id)}
                {#if s.frac > 0}
                  <span class="seg-pilha" style="width: {s.frac * 100}%; background: {s.slot}" class:apagada={hoverCtx !== null && hoverCtx !== i}
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

        <section class="ranking">
          <div class="abas" role="tablist">
            {#each ABAS as a (a.id)}
              <button role="tab" aria-selected={aba === a.id} onclick={() => (aba = a.id)}>
                {a.label} <span class="dim">{listaDa(a.id).length}</span>
              </button>
            {/each}
          </div>
          {#if !linhas.length}
            <p class="muted">{m.uso_vazio_secao()}</p>
          {:else}
            <div class="scroll">
              <table class="data">
                <thead>
                  <tr>
                    {#each cols as c (c.col)}
                      <th class:n={c.n} aria-sort={ordemAtual.col === c.col ? (ordemAtual.desc ? 'descending' : 'ascending') : undefined}>
                        <button class="th" onclick={() => ordenar(c.col)} aria-label={m.uso_ordenar_por({ col: c.rotulo })}>
                          {c.rotulo}{#if ordemAtual.col === c.col}<span class="seta">{ordemAtual.desc ? '▾' : '▴'}</span>{/if}
                        </button>
                      </th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each (expandida ? linhas : linhas.slice(0, TOPO)) as b (b.key)}
                    <tr class="click" aria-selected={selecionado?.key === b.key && selecionado.aba === aba} onclick={() => selecionar(aba, b.key)}>
                      <td class="nome" title={b.key}>
                        {rotulo(aba, b)}
                        {#if b.plugin && aba !== 'plugin'}<span class="tag">{b.plugin}</span>{/if}
                      </td>
                      <td class="n"><span class="ibar"><i style="width: {(b.chamadas / maxChamadas) * 100}%"></i></span>{dec(b.chamadas, 0)}</td>
                      {#if abaAtual.custo}
                        <td class="n"><span class="ibar custo"><i style="width: {(b.cost / maxCusto) * 100}%"></i></span>{b.cost > 0 ? m2(b.cost) : '—'}</td>
                        <td class="n">
                          {#if foraDaCurva(b)}<span class="marca" title={m.uso_caro_por_chamada({ x: dec(porChamada(b) / medianaChamada, 0) })}>●</span>{/if}
                          {b.cost > 0 ? m2(porChamada(b)) : '—'}
                        </td>
                      {:else}
                        <td class="n"><span class="ibar"><i style="width: {(b.ctx_tokens_est / maxCtx) * 100}%"></i></span>≈ {tok(b.ctx_tokens_est)}</td>
                        <td class="n">
                          {#if aba !== 'contexto' && foraDaCurvaCtx(b)}<span class="marca" title={m.uso_pesada_por_chamada({ x: dec(ctxPorChamada(b) / medianaCtxChamada, 0) })}>●</span>{/if}
                          ≈ {tok(aba === 'contexto' ? porSessao(b) : ctxPorChamada(b))}
                        </td>
                      {/if}
                      {#if abaAtual.turno}<td class="n dim" title={m.uso_custo_turno_nota()}>{b.cost > 0 ? m2(b.cost) : '—'}</td>{/if}
                      <td class="n">{dec(b.sessions, 0)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if !desktop && itemSelecionado}
              <div class="detalhe-movel">{@render detalhe(itemSelecionado)}</div>
            {/if}
            {#if linhas.length > TOPO}
              <button class="retry" onclick={() => (expandida = !expandida)}>
                {expandida ? m.uso_mostrar_menos() : m.uso_mostrar_mais({ n: linhas.length - TOPO })}
              </button>
            {/if}
          {/if}
        </section>
      </div>

      {#if desktop && itemSelecionado}
        <aside class="lateral">{@render detalhe(itemSelecionado)}</aside>
      {/if}
    </div>
  {/if}
 </div>
</div>

{#snippet detalhe(b: UsoBucket)}
  <div class="detalhe">
    <div class="det-cab">
      <div>
        <h3 title={b.key}>{rotulo(selecionado!.aba, b)}</h3>
        <p class="dim">{abaAtual.label}{#if b.plugin} · {b.plugin}{/if}</p>
      </div>
      <button class="retry" onclick={() => (selecionado = null)}>{m.uso_detalhe_fechar()}</button>
    </div>
    <dl class="det-grade">
      <div><dt>{m.uso_col_chamadas()}</dt><dd>{dec(b.chamadas, 0)}</dd></div>
      <div><dt>{m.uso_col_sessoes()}</dt><dd>{dec(b.sessions, 0)}</dd></div>
      {#if selecionado!.aba === 'skill' || selecionado!.aba === 'agente'}
        <div><dt>{selecionado!.aba === 'skill' ? m.uso_col_origem_skill() : m.uso_col_origem_agente()}</dt><dd>{dec(b.pedidas, 0)} / {dec(b.chamadas - b.pedidas, 0)}</dd></div>
      {/if}
      {#if abaAtual.custo}
        <div><dt>{m.uso_col_custo()}</dt><dd>{m2(b.cost)}</dd></div>
        <div><dt>{m.uso_detalhe_custo_chamada()}</dt><dd>{m2(porChamada(b))}</dd></div>
        <div><dt>{m.uso_detalhe_tokens()}</dt><dd>{tok(tokensReais(b))}</dd></div>
      {/if}
      {#if abaAtual.turno}
        <div title={m.uso_custo_turno_nota()}><dt>{m.uso_col_custo_turno()}</dt><dd>{m2(b.cost)}</dd></div>
        <div><dt>{m.uso_detalhe_tokens()}</dt><dd>{tok(tokensReais(b))}</dd></div>
      {/if}
      <div><dt>{m.uso_col_ctx()}</dt><dd>≈ {tok(b.ctx_tokens_est)}</dd></div>
      <div><dt>{m.uso_detalhe_ctx_chamada()}</dt><dd>≈ {tok(ctxPorChamada(b))}</dd></div>
      <div><dt>{m.uso_detalhe_media_sessao()}</dt><dd>≈ {tok(porSessao(b))}</dd></div>
    </dl>
    <h4>{m.uso_detalhe_por_dia()} <span class="dim">({abaAtual.custo ? m.uso_graf_custo() : m.uso_col_ctx()})</span></h4>
    {#if serieCarregando}
      <div class="bloco medio sk-serie"></div>
    {:else if !serie.length}
      <p class="muted">{m.uso_detalhe_sem_serie()}</p>
    {:else}
      <svg viewBox="0 0 {grafSerie.W} {grafSerie.H}" class="serie" role="img" aria-label={m.uso_detalhe_por_dia()}>
        <line x1="0" x2={grafSerie.W} y1={grafSerie.base} y2={grafSerie.base} class="eixo" />
        {#each grafSerie.barras as c (c.b.key)}
          <rect x={c.x} y={c.y} width={c.w} height={c.h} rx="2" fill="var(--chart-1)"><title>{c.b.key}: {abaAtual.custo ? m2(c.v) : tok(c.v)}</title></rect>
        {/each}
        {#each grafSerie.rotulos as r (r.i)}
          <text x={r.x} y={grafSerie.H - 5} text-anchor="middle" class="tick">{diaCurto(serie[r.i].key)}</text>
        {/each}
      </svg>
    {/if}
  </div>
{/snippet}

<style>
  .uso { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: var(--navbar-fade) var(--space-5) var(--space-10); }
  .inner { max-width: 1560px; margin-inline: auto; }

  .topo { display: flex; justify-content: space-between; align-items: end; gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-3); }
  .titulo h1 { font-size: var(--text-xl); font-weight: 650; }
  .link { font-size: var(--text-xs); color: var(--accent); }
  .toolbar { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
  .seg { display: inline-flex; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button { background: transparent; border: 0; border-right: 1px solid var(--border-default); color: var(--text-secondary); font: inherit; font-size: var(--text-xs); padding: 6px 12px; cursor: pointer; min-height: 34px; }
  .seg button:last-child { border-right: 0; }
  .seg button[aria-pressed='true'] { background: var(--accent); color: #fff; }
  .seg button:hover:not([aria-pressed='true']) { background: var(--bg-hover); }
  .seg button:disabled { opacity: 0.5; cursor: default; }
  .clear, .retry { background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); border-radius: var(--radius-sm); font: inherit; font-size: var(--text-xs); padding: 6px 12px; cursor: pointer; min-height: 34px; }
  .retry { padding: 4px 10px; min-height: 0; }
  .clear:disabled { opacity: 0.45; cursor: default; }
  .clear:hover:not(:disabled), .retry:hover { background: var(--bg-hover); }
  .chip { background: var(--surface-raised); border: 1px solid var(--border-default); color: var(--text-secondary); border-radius: var(--radius-full); font: inherit; font-size: var(--text-xs); padding: 6px 12px; cursor: pointer; min-height: 34px; }
  .chip[aria-pressed='true'] { color: var(--text-primary); border-color: var(--accent); }
  .chip:disabled { opacity: 0.45; cursor: default; }
  .chip.todos { color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-2); }

  .filtros { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); }
  .fsel { display: inline-block; width: clamp(150px, 16vw, 240px); }
  .fsel :global(.chipsel) { height: 34px; font-size: var(--text-xs); border-radius: var(--radius-full); background: var(--surface-raised); }
  .fsel.ativo :global(.chipsel) { border-color: var(--accent); color: var(--text-primary); }
  .busca { min-height: 34px; min-width: 200px; padding: 4px 10px; font: inherit; font-size: var(--text-xs); background: var(--surface-inset); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); }

  .faixa-status { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; min-height: 20px; margin-bottom: var(--space-3); font-size: var(--text-xs); color: var(--text-secondary); }
  .atualizando { display: inline-flex; align-items: center; gap: 6px; }
  .pulso { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulso 1s ease-out infinite; }
  @keyframes pulso { 0% { opacity: 1; } 100% { opacity: 0.25; } }
  .warn { color: var(--warning); }
  .aquecendo progress { width: 160px; height: 5px; accent-color: var(--accent); margin-left: 6px; vertical-align: middle; }
  .muted { color: var(--text-secondary); }
  .dim { color: var(--text-secondary); font-weight: 400; }
  .vazio { padding: var(--space-6) 0; }

  .esqueleto { display: grid; gap: var(--space-4); }
  .bloco { background: var(--surface-inset); border-radius: var(--radius-md); animation: pulso 1.2s ease-in-out infinite alternate; }
  .kpi-sk { height: 56px; } .grande { height: 380px; } .medio { height: 160px; }
  .sk-serie { height: 90px; }

  /* números discretos: uma linha, sem cartão */
  .numeros { display: flex; flex-wrap: wrap; gap: var(--space-6); margin: var(--space-2) 0 var(--space-5); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border-subtle); }
  .numeros div { min-width: 0; }
  .numeros dt { font-size: var(--text-xs); color: var(--text-muted); margin-bottom: 2px; }
  .numeros dd { font-size: var(--text-lg); font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .numeros div:first-child dd { color: var(--accent); }

  .painel { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); align-items: start; }
  .painel.com-detalhe { grid-template-columns: minmax(0, 1fr) 340px; }
  .principal { min-width: 0; }
  .lateral { position: sticky; top: 0; }

  /* Sobre papel de parede, gráfico e tabela precisam de material próprio pra ler: --surface-card
     acompanha o slider de solidez do app (nunca --bg-* cru). */
  .bloco-graf, .ranking { min-width: 0; margin-bottom: var(--space-5); background: var(--surface-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-4); }
  .cab { display: flex; justify-content: space-between; align-items: start; gap: var(--space-3); margin-bottom: var(--space-2); }
  .cab h2 { font-size: var(--text-base); font-weight: 650; }
  .cab .hint { font-size: var(--text-xs); color: var(--text-secondary); max-width: 80ch; margin-top: 2px; }
  .cab .total { font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap; }
  .hero .svgbox { border-radius: var(--radius-sm); background: var(--surface-inset); }
  .linha-graf { display: grid; grid-template-columns: 3fr 2fr; gap: var(--space-5); }
  .svgbox { position: relative; }
  .svgbox svg { display: block; max-width: 100%; height: auto; }
  .eixo { stroke: var(--border-default); stroke-width: 1; }
  .mediana { stroke: var(--border-default); stroke-width: 1; stroke-dasharray: none; opacity: 0.8; }
  .tick { fill: var(--text-muted); font-size: 10px; }
  .quad { fill: var(--text-muted); font-size: 11px; letter-spacing: 0.02em; text-transform: uppercase; }
  .eixo-nome { fill: var(--text-muted); font-size: 10px; }
  .rotulo { fill: var(--text-primary); font-size: 11px; pointer-events: none; }
  .bolha { opacity: 0.85; stroke: var(--surface-inset); stroke-width: 2; transition: opacity 120ms; }
  .bolha.apagada { opacity: 0.25; }
  .bolha.sel { stroke: var(--text-primary); }
  .tip { position: absolute; transform: translateX(-50%); pointer-events: none; background: var(--bg-elevated); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 4px 8px; font-size: var(--text-xs); display: flex; flex-direction: column; gap: 2px; white-space: nowrap; z-index: 2; }
  .tip b { font-variant-numeric: tabular-nums; }
  .tip span { color: var(--text-secondary); }
  .duplo { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
  .mini h3 { font-size: var(--text-xs); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: var(--space-1); }
  .pilha { display: flex; height: 20px; gap: 2px; border-radius: 4px; overflow: hidden; margin-bottom: var(--space-3); }
  .seg-pilha { display: block; height: 100%; min-width: 2px; transition: opacity 120ms; }
  .seg-pilha.apagada { opacity: 0.35; }
  .legenda { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .legenda li { display: grid; grid-template-columns: 12px 1fr auto auto; gap: var(--space-2); align-items: center; font-size: var(--text-sm); }
  .legenda.inline { display: flex; gap: var(--space-3); font-size: var(--text-xs); color: var(--text-secondary); }
  .legenda.inline li { display: inline-flex; gap: 6px; }
  .legenda li.apagada { opacity: 0.45; }
  .legenda .swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .legenda .lab { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legenda b { font-variant-numeric: tabular-nums; }

  .abas { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--border-subtle); margin-bottom: var(--space-2); scrollbar-width: none; }
  .abas button { background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--text-secondary); font: inherit; font-size: var(--text-sm); padding: 8px 12px; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
  .abas button[aria-selected='true'] { color: var(--text-primary); border-bottom-color: var(--accent); }
  .abas .dim { margin-left: 5px; font-size: var(--text-xs); }
  .abas button:hover { color: var(--text-primary); }
  .scroll { overflow-x: auto; }
  table.data { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
  table.data th { text-align: left; font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); font-weight: 600; padding: 4px var(--space-2) 6px; white-space: nowrap; }
  table.data th .th { background: transparent; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-transform: inherit; letter-spacing: inherit; }
  table.data th .th:hover, table.data th[aria-sort] .th { color: var(--text-primary); }
  .seta { margin-left: 3px; }
  table.data td { padding: 6px var(--space-2); border-top: 1px solid var(--border-subtle); white-space: nowrap; }
  table.data td.nome { max-width: 40ch; overflow: hidden; text-overflow: ellipsis; }
  table.data th.n, table.data td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .ibar { display: inline-block; width: 64px; height: 6px; border-radius: 3px; background: var(--surface-inset); overflow: hidden; vertical-align: middle; margin-right: 8px; }
  .ibar > i { display: block; height: 100%; background: var(--chart-1); }
  .ibar.custo > i { background: var(--chart-2); }
  .marca { color: var(--warning); margin-right: 4px; font-size: 9px; vertical-align: 2px; }
  .tag { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: var(--radius-full); border: 1px solid var(--border-default); color: var(--text-muted); margin-left: 6px; vertical-align: 1px; }
  table.data tr.click { cursor: pointer; }
  table.data tr.click:hover td { background: var(--bg-hover); }
  table.data tr[aria-selected='true'] td { background: var(--accent-dim); }
  .detalhe-movel { margin-top: var(--space-3); }

  .detalhe { border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-4); background: var(--surface-inset); }
  .det-cab { display: flex; justify-content: space-between; align-items: start; gap: var(--space-2); margin-bottom: var(--space-3); }
  .det-cab h3 { font-size: var(--text-base); font-weight: 650; overflow-wrap: anywhere; }
  .det-cab p { font-size: var(--text-xs); }
  .det-grade { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3) var(--space-4); margin-bottom: var(--space-4); }
  .det-grade dt { font-size: var(--text-xs); color: var(--text-muted); }
  .det-grade dd { font-size: var(--text-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
  .detalhe h4 { font-size: var(--text-xs); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: var(--space-1); }
  .serie { display: block; width: 100%; max-width: 360px; height: auto; }

  @media (max-width: 819px) {
    .uso { padding-inline: var(--space-3); }
    .numeros { gap: var(--space-4); }
    .numeros dd { font-size: var(--text-base); }
    .linha-graf, .duplo { grid-template-columns: 1fr; }
    .busca { min-width: 0; flex: 1 1 140px; }
    .ibar { width: 36px; }
    table.data td.nome { max-width: 24ch; }
  }
</style>
