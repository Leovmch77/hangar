import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { custoDesconhecido, custoSemCacheDe, equivalenteDe, fillDayGaps, intlLocale, mergeReports, mergeUso, partirOcultos, precoParcial, tarifasPorModelo, type DimBucket } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { Action, Bar, Card, Choice, Copy, dollars, number, Paged, percent, ReportControls, ReportFrame, ReportStatus, useReportSelection } from './ReportUI';
import { comparison, costView, dimensionBuckets, dimensions, filterCombos, groupCombos, priceLabel, rawTokens, setCostFilter, sumCombos, type CostFilter, type Dimension } from './costs-model';
import { useReports } from './useReports';
import * as m from '../../paraglide/messages';

type Panel = 'daily' | Dimension | 'sessions' | 'comparison' | 'areas' | 'method';
const dimensionNames = () => ({ provider: m.custos_dim_provedor(), source: m.custos_dim_fonte(), project: m.custos_dim_projeto(), model: m.custos_dim_modelo(), servidor: m.custos_dim_maquina() });
const typeNames = () => ({ input: m.custos_input_sem_cache(), output: m.custos_output_total(), cache_write: m.custos_tipo_cache_escrito(), cache_read: m.custos_tipo_cache_lido() });
const tokenTypes = ['input', 'output', 'cache_write', 'cache_read'] as const;
type TokenType = typeof tokenTypes[number];

export function CostsScreen() {
  const router = useRouter();
  const focused = useIsFocused();
  const { period, own, selected } = useReportSelection();
  const [filter, setFilter] = useState<CostFilter>({});
  const [panel, setPanel] = useState<Panel>('daily');
  const [brl, setBrl] = useState(false);
  const [hidden, setHidden] = useState(new Set<string>());
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const [layer, setLayer] = useState<Dimension | 'type'>('type');
  const [visibleTypes, setVisibleTypes] = useState<TokenType[]>(['input', 'output', 'cache_write']);
  const [day, setDay] = useState<string | null>(null);
  const [compareDimension, setCompareDimension] = useState<Dimension>('provider');
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const load = useReports('costs', selected, period, {}, focused);
  const report = mergeReports(load.parts, period).report;
  const areaServers = selected.filter((server) => !filter.servidor?.length || filter.servidor.includes(server.id));
  const areaLoad = useReports('usage', areaServers, period, { projeto: filter.project ?? [], modelo: filter.model ?? [] }, focused && panel === 'areas');
  const areas = mergeUso(areaLoad.parts, period).report;
  const areasMax = Math.max(1, ...areas.by_area.map(rawTokens));
  const view = costView(report, filter);
  const activeFilter = dimensions.some((d) => filter[d]?.length) || filter.sub !== undefined;
  const rates = tarifasPorModelo(report.rates);
  const validRate = report.usd_brl !== null && Number.isFinite(report.usd_brl) && report.usd_brl > 0;
  const money = (value: number) => brl && validRate ? new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: 'BRL', maximumFractionDigits: 4 }).format(value * report.usd_brl!) : dollars(value);
  const cost = (bucket: Pick<DimBucket, 'input' | 'output' | 'cache_write' | 'cache_read' | 'cost'>, model?: string) => priceLabel(bucket, model) === 'priced' ? money(bucket.cost) : '—';
  const labelPrice = (bucket: DimBucket, model?: string) => priceLabel(bucket, model) === 'free' ? m.custos_gratis() : custoDesconhecido(bucket) ? m.custos_sem_tarifa() : '';
  const names = dimensionNames();
  const types = typeNames();
  const total = view.total;
  const raw = rawTokens(total);
  const newTokens = total.input + total.output + total.cache_write;
  const noCache = view.cross ? custoSemCacheDe(view.rows, rates) : activeFilter ? null : report.custo_sem_cache;
  const equivalent = view.cross ? equivalenteDe(view.rows, rates) : activeFilter ? null : report.equivalente_cobrado;
  const namesOfServers = new Map(own.map((s) => [s.id, s.label]));
  const labelOf = (dim: Dimension, key: string) => dim === 'servidor' ? namesOfServers.get(key) ?? key : key;

  useEffect(() => {
    if (!load.accepted || load.loading || view.cross) return;
    const dim = dimensions.find((d) => filter[d]?.length);
    const restricted = dim ? { [dim]: [filter[dim]![0]] } : {};
    if (JSON.stringify(restricted) !== JSON.stringify(filter)) setFilter(restricted);
  }, [load.accepted, load.loading, view.cross, filter]);

  const optionBuckets = (dim: Dimension) => {
    const rest = { ...filter }; delete rest[dim];
    const buckets = view.cross ? groupCombos(filterCombos(report.combos, rest), dim) : dimensionBuckets(report, dim);
    return buckets.map((item) => ({ key: item.key, label: labelOf(dim, item.key) }));
  };
  const filters = <Card><Copy title>{m.custos_filtros()}</Copy>
    {dimensions.map((dim) => <Choice key={dim} label={names[dim]} options={optionBuckets(dim)} values={filter[dim] ?? []} max={view.cross ? undefined : 1} onChange={(values) => setFilter(setCostFilter(filter, dim, values, view.cross))} />)}
    {view.cross && <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{[[undefined, m.custos_tudo()], [false, m.custos_so_conversa()], [true, m.custos_so_subagente()]].map(([value, label]) => <Action key={String(value)} label={String(label)} selected={filter.sub === value} onPress={() => setFilter({ ...filter, sub: value as boolean | undefined })} />)}</View>}
    <Action label={m.custos_limpar_filtros()} onPress={() => setFilter({})} />
    {!view.cross && <Copy muted>{m.custos_recorte_parcial()}</Copy>}
  </Card>;
  const panels: [Panel, string][] = [['daily', m.custos_gasto_por_dia()], ['provider', m.custos_por_provedor()], ['source', m.custos_por_fonte()], ['servidor', m.custos_por_maquina()], ['project', m.custos_por_projeto()], ['model', m.custos_por_modelo()], ['sessions', m.custos_sessoes_caras()], ['comparison', m.lista_comparar()], ['areas', m.uso_graf_areas()], ['method', m.custos_como_calculamos()]];
  const renderTypes = (bucket: DimBucket) => <View style={{ gap: 8 }}>{tokenTypes.map((type) => <Bar key={type} label={types[type]} value={bucket[type]} max={rawTokens(bucket)} detail={`${number(bucket[type])} · ${custoDesconhecido(bucket) && bucket[type] > 0 ? '—' : money(bucket[`cost_${type}`])}`} />)}</View>;

  function renderDaily() {
    const days = fillDayGaps(view.days);
    const valueOf = (bucket: Pick<DimBucket, 'input' | 'output' | 'cache_write' | 'cache_read' | 'cost'>) => metric === 'tokens' ? rawTokens(bucket) : bucket.cost;
    const max = Math.max(1, ...days.map(valueOf));
    return <Card><Copy title>{m.custos_gasto_por_dia()}</Copy>
      <View style={{ flexDirection: 'row' }}><Action label={m.custos_custo()} selected={metric === 'cost'} onPress={() => setMetric('cost')} /><Action label={m.ctx_tokens()} selected={metric === 'tokens'} onPress={() => setMetric('tokens')} /></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}><Action label={m.custos_tipo_token()} selected={layer === 'type'} onPress={() => setLayer('type')} />{dimensions.map((dim) => <Action key={dim} label={names[dim]} selected={layer === dim} disabled={!view.cross} onPress={() => setLayer(dim)} />)}</View>
      {layer === 'type' && <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{tokenTypes.map((type) => <Action key={type} label={types[type]} selected={visibleTypes.includes(type)} onPress={() => setVisibleTypes((old) => old.includes(type) ? old.filter((v) => v !== type) : [...old, type])} />)}</View>}
      <Copy muted>{m.custos_empilhado_por({ modo: layer === 'type' ? m.custos_tipo_token() : names[layer] })}</Copy>
      <Copy muted>{m.custos_hover_detalhe()}</Copy>
      <Paged key={`${period}:${layer}:${metric}`} items={days} render={(item) => <View>
        <Bar label={item.key} value={valueOf(item)} max={max} detail={metric === 'tokens' ? number(rawTokens(item)) : cost(item as DimBucket)} onPress={() => setDay(item.key)} />
        {layer === 'type' ? visibleTypes.map((type) => <Bar key={type} label={types[type]} value={metric === 'tokens' ? item[type] : (item as DimBucket)[`cost_${type}`] ?? 0} max={max} detail={metric === 'tokens' ? number(item[type]) : custoDesconhecido(item as DimBucket) && item[type] > 0 ? '—' : money((item as DimBucket)[`cost_${type}`] ?? 0)} />)
          : groupCombos(view.rows.filter((row) => row.dia === item.key), layer).map((bucket) => <Bar key={bucket.key} label={labelOf(layer, bucket.key)} value={valueOf(bucket)} max={max} detail={metric === 'tokens' ? number(rawTokens(bucket)) : cost(bucket)} />)}
      </View>} />
    </Card>;
  }

  function renderRanking(dim: Dimension) {
    const buckets = [...view.groups[dim]].sort((a, b) => metric === 'tokens' ? rawTokens(b) - rawTokens(a) : b.cost - a.cost);
    const split = partirOcultos(buckets, dim === 'project' ? hidden : new Set());
    const max = Math.max(1, ...split.visiveis.map((b) => metric === 'tokens' ? rawTokens(b) : b.cost));
    const hiddenTotal = split.escondidos.reduce((s, b) => s + b.cost, 0);
    return <Card><Copy title>{panels.find(([key]) => key === dim)![1]}</Copy>
      <Action label={m.custos_metrica()} onPress={() => setMetric(metric === 'tokens' ? 'cost' : 'tokens')} /><Copy>{metric === 'tokens' ? m.ctx_tokens() : m.custos_custo()}</Copy>
      {dim === 'model' && <Copy muted>{m.custos_com_tarifa()}</Copy>}
      <Paged key={`${dim}:${period}:${metric}`} items={split.visiveis} render={(bucket) => <View style={{ gap: 6 }}>
        <Bar label={labelOf(dim, bucket.key)} value={metric === 'tokens' ? rawTokens(bucket) : bucket.cost} max={max} detail={`${cost(bucket, dim === 'model' ? bucket.key : undefined)} · ${number(rawTokens(bucket))}`} onPress={() => setFilter(setCostFilter(filter, dim, [bucket.key], view.cross))} />
        {!!labelPrice(bucket, dim === 'model' ? bucket.key : undefined) && <Copy muted>{labelPrice(bucket, dim === 'model' ? bucket.key : undefined)}</Copy>}
        {dim === 'project' && <Action label={m.custos_tirar_da_lista({ nome: bucket.key })} icon="EyeOff" onPress={() => setHidden(new Set([...hidden, bucket.key]))} />}
        {dim === 'model' && <>
          {precoParcial(bucket.key, rates.has(bucket.key), report.sem_tarifa) && <Copy>{m.custos_preco_parcial()}</Copy>}
          {report.rates.filter((rate) => rate.model === bucket.key).map((rate, index) => <Copy key={index} muted>{`${rate.provider} · ${m.custos_tarifa_in_out()}: ${money(rate.input)} / ${money(rate.output)} · ${m.custos_tipo_cache_escrito()}: ${money(rate.cache_write)} · ${m.custos_tipo_cache_lido()}: ${money(rate.cache_read)} · ${m.custos_origem()}: ${rate.origin}${rate.cache_estimado ? ` · ${m.custos_cache_estimado()}` : ''}`}</Copy>)}
        </>}
      </View>} />
      {split.escondidos.length > 0 && <><Copy muted>{m.custos_fora_da_lista({ n: split.escondidos.length, valor: hiddenTotal === 0 && split.escondidos.some(custoDesconhecido) ? '—' : money(hiddenTotal) })}</Copy>
        <Paged items={split.escondidos} render={(bucket) => <Action label={bucket.key} onPress={() => setHidden(new Set([...hidden].filter((key) => key !== bucket.key)))} />} /><Action label={m.custos_mostrar_todos()} onPress={() => setHidden(new Set())} /></>}
    </Card>;
  }

  function renderSessions() {
    const sessions = report.sessoes.filter((session) => dimensions.every((dim) => !filter[dim]?.length || filter[dim]!.includes(session[dim]))).sort((a, b) => b.cost - a.cost);
    return <Card><Copy title>{m.custos_sessoes_caras()}</Copy><Copy muted>{m.custos_sessoes_hint()}</Copy>
      {!report.sessoes.length && <Copy muted>{load.parts.some((p) => p.report && !Array.isArray(p.report.sessoes)) ? m.custos_sessoes_atualize() : m.custos_sessoes_vazio()}</Copy>}
      <Paged items={sessions} render={(session) => <Card><Copy title>{session.project || session.session_id}</Copy><Copy>{`${session.source} · ${session.provider} · ${session.model} · ${labelOf('servidor', session.servidor)}`}</Copy><Copy>{`${cost(session, session.model)} · ${number(rawTokens(session))} · ${m.custos_sessoes_e_subagentes()}: ${number(session.subagentes + 1)}`}</Copy><Copy muted>{`${session.session_id} · ${session.inicio} — ${session.fim}`}</Copy></Card>} />
    </Card>;
  }

  function renderComparison() {
    const comparisons = comparison(report, filter, compareDimension, compareKeys);
    const comparisonMax = Math.max(1, ...comparisons.flatMap((v) => v.days.map((d) => metric === 'tokens' ? rawTokens(d) : d.cost)));
    return <Card><Copy title>{m.lista_comparar()}</Copy><Copy muted>{m.custos_comparar_hint({ n: 4 })}</Copy>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{dimensions.map((dim) => <Action key={dim} label={`${m.custos_comparar_por()} ${names[dim]}`} selected={compareDimension === dim} onPress={() => { setCompareDimension(dim); setCompareKeys([]); }} />)}</View>
      <Choice label={m.custos_entidades_comparadas()} options={optionBuckets(compareDimension)} values={compareKeys} max={4} onChange={setCompareKeys} />
      {!view.cross && <Copy muted>{m.custos_sem_detalhamento()}</Copy>}
      {compareKeys.length < 2 && <Copy>{m.custos_marque_duas()}</Copy>}
      {comparisons.length >= 2 && <Paged items={comparisons} render={(entity) => <Card><Copy title>{labelOf(compareDimension, entity.key)}</Copy><Copy>{`${cost(entity.total, compareDimension === 'model' ? entity.key : undefined)} · ${number(rawTokens(entity.total))}`}</Copy>
        <Paged items={fillDayGaps(entity.days)} render={(item) => <Bar label={item.key} value={metric === 'tokens' ? rawTokens(item) : item.cost} max={comparisonMax} detail={metric === 'tokens' ? number(rawTokens(item)) : cost(item as DimBucket)} />} />
      </Card>} />}
    </Card>;
  }

  const dayBucket = day ? view.days.find((item) => item.key === day) ?? { ...sumCombos([]), key: day } : undefined;
  return <ReportFrame title={m.nav_custos()} back={() => router.back()} sibling={m.uso_painel_titulo()} onSibling={() => router.push('/stats' as never)}>
    <ReportControls own={own} refresh={() => { load.refresh(); areaLoad.refresh(); }} />
    <ReportStatus {...load} selected={selected.length} />
    {load.accepted && <>
      <Copy muted>{m.custos_aviso_estimativa()}</Copy>
      {report.sem_tarifa.length > 0 && <Copy muted>{`${m.custos_estimativa_incompleta({ n: report.sem_tarifa.length })} ${report.sem_tarifa.join(', ')}`}</Copy>}
      <Card><Copy title>{m.custos_moeda()}</Copy><View style={{ flexDirection: 'row' }}><Action label="USD" selected={!brl || !validRate} onPress={() => setBrl(false)} /><Action label="BRL" disabled={!validRate} selected={brl && validRate} onPress={() => setBrl(true)} /></View>
        <Copy muted>{validRate ? m.custos_usd_brl({ taxa: number(report.usd_brl!, 4) }) : m.custos_cotacao_indisponivel()}</Copy>
      </Card>
      {filters}
      <View style={{ gap: 10 }}>
        <Card><Copy>{m.custos_custo_periodo()}</Copy><Copy title>{cost(total)}</Copy><Copy muted>{labelPrice(total)}</Copy><Copy muted>{m.custos_preco_tabela()}</Copy></Card>
        <Card><Copy>{m.custos_tokens_novos()}</Copy><Copy title>{number(newTokens)}</Copy><Copy muted>{m.custos_tokens_novos_pe()}</Copy></Card>
        <Card><Copy>{m.custos_tokens_processados()}</Copy><Copy title>{number(raw)}</Copy><Copy muted>{m.custos_tokens_processados_pe({ relidos: number(total.cache_read), pct: percent(total.cache_read, raw) })}</Copy></Card>
        <Card><Copy>{m.custos_cache_na_entrada()}</Copy><Copy title>{percent(total.cache_read, total.input + total.cache_write + total.cache_read)}</Copy></Card>
        <Card><Copy>{m.custos_economia_cache()}</Copy><Copy title>{noCache === null || custoDesconhecido(total) ? '—' : money(Math.max(0, noCache - total.cost))}</Copy><Copy muted>{m.custos_mesmos_tokens()}</Copy></Card>
        <Card><Copy>{m.custos_equivalente_cobrado()}</Copy><Copy title>{equivalent === null || custoDesconhecido(total) ? '—' : number(equivalent)}</Copy><Copy muted>{m.custos_equivalente_metodo()}</Copy></Card>
        <Card><Copy>{m.custos_custo_por_milhao()}</Copy><Copy title>{raw && !custoDesconhecido(total) ? money(total.cost / raw * 1e6) : '—'}</Copy><Copy muted>{m.custos_por_milhao_novos({ valor: newTokens && !custoDesconhecido(total) ? money(total.cost / newTokens * 1e6) : '—' })}</Copy></Card>
        <Card><Copy>{m.custos_cache_perdido()}</Copy><Copy title>{report.cache_detalhado && !custoDesconhecido(total) ? money(total.custo_regravado ?? 0) : '—'}</Copy><Copy muted>{report.cache_detalhado ? m.custos_cache_perdido_pe({ tokens: number(total.regravado ?? 0) }) : m.custos_cache_sem_dado()}</Copy></Card>
        <Card><Copy>{m.custos_cache_1h()}</Copy><Copy title>{report.cache_detalhado ? percent(total.cache_write_1h ?? 0, total.cache_write) : '—'}</Copy><Copy muted>{report.cache_detalhado ? m.custos_cache_1h_pe({ h1: number(total.cache_write_1h ?? 0), total: number(total.cache_write) }) : m.custos_cache_sem_dado()}</Copy></Card>
      </View>
      {raw === 0 && <Copy>{activeFilter ? m.custos_sem_dados_recorte() : m.custos_sem_dados_periodo()}</Copy>}
      <Card><Copy title>{m.custos_para_onde_dolar()}</Copy><Copy muted>{m.custos_tipo_token_conta()}</Copy>{renderTypes(total)}</Card>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={{ flexDirection: 'row' }}>{panels.map(([key, label]) => <Action key={key} label={label} selected={panel === key} onPress={() => { setPanel(key); setDay(null); }} />)}</View></ScrollView>
      {panel === 'daily' ? renderDaily() : dimensions.includes(panel as Dimension) ? renderRanking(panel as Dimension) : panel === 'sessions' ? renderSessions() : panel === 'comparison' ? renderComparison() : panel === 'areas' ? <Card>
        <Copy title>{m.uso_graf_areas()}</Copy><Copy muted>{m.uso_graf_areas_nota()}</Copy><Copy muted>{m.mobile_costs_area_scope()}</Copy>
        <ReportStatus {...areaLoad} selected={areaServers.length} />
        {areaLoad.accepted && <Paged items={areas.by_area} render={(item) => <Bar label={item.label ?? item.key} value={rawTokens(item)} max={areasMax} detail={`${number(rawTokens(item))} · ${cost(item)}`} />} />}
        {areaLoad.accepted && <Paged items={areas.by_area_dia} render={(item) => <Copy>{`${item.key}: ${number(rawTokens(item))} · ${cost(item)}`}</Copy>} />}
      </Card> : <Card><Copy title>{m.custos_como_calculamos()}</Copy><Copy>{m.custos_custo_tabela()}{m.custos_nao_fatura()}{m.custos_assinatura()}</Copy><Copy>{m.custos_metodo_standard()}</Copy><Copy>{m.custos_metodo_codex()}</Copy><Copy>{m.custos_equivalente_metodo()}</Copy><Copy>{m.custos_tarifas_models()}</Copy></Card>}
      {day !== null && <Sheet open onDismiss={() => setDay(null)} sizes={['large']} scrollable><ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}><Copy title>{day}</Copy>{dayBucket && <><Copy>{`${number(rawTokens(dayBucket))} · ${cost(dayBucket)}`}</Copy>{renderTypes(dayBucket)}</>}<Action label={m.native_close()} onPress={() => setDay(null)} /></ScrollView></Sheet>}
    </>}
  </ReportFrame>;
}
