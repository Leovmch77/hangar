import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { agruparPorPlugin, mergeUso, zeroUso, type Server, type UsoBucket, type UsoFiltros } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { Action, Bar, Card, Choice, Columns, Composition, Copy, dollars, Grid, number, Paged, percent, ReportControls, ReportFrame, ReportStatus, Search, useChartColors, useReportSelection } from './ReportUI';
import { contextCategory, measure, toolsOf, usageTabs, type UsageTab } from './stats-model';
import { useReports } from './useReports';
import * as m from '../../paraglide/messages';

type FilterKey = 'conta' | 'projeto' | 'modelo' | 'plugin';
type Sort = 'weight' | 'calls' | 'name' | 'cost' | 'perCall' | 'replies' | 'sessions';
const filterKeys: FilterKey[] = ['conta', 'projeto', 'modelo', 'plugin'];
const groupName = (key: string) => {
  const names: Record<string, string> = { '@repo': m.uso_grupo_repo(), '@pessoal': m.uso_grupo_pessoal(), '@avulsa': m.uso_grupo_avulsa(), '@embutida': m.uso_grupo_embutida(), '@nativo': m.uso_grupo_nativo(), '': m.uso_grupo_sem() };
  return names[key] ?? key;
};
const imageLabel = (key: string) => key === 'enviada' ? m.uso_img_enviada() : m.uso_img_lida({ tool: key.replace(/^lida:/, '') });
const weight = (item: UsoBucket) => item.ocupados_eq_tokens_est ?? 0;
const sumItems = (items: UsoBucket[]) => {
  const total = zeroUso('total');
  const fields = ['sessions', 'chamadas', 'pedidas', 'ctx_chars', 'ctx_tokens_est', 'input', 'output', 'cache_write', 'cache_read', 'cost', 'cost_input', 'cost_output', 'cost_cache_write', 'cost_cache_read', 'ocupados_tokens_est', 'ocupados_eq_tokens_est', 'respostas'] as const;
  for (const field of fields) total[field] = items.reduce((sum, item) => sum + (item[field] ?? 0), 0);
  return total;
};
const agentGroups = (items: UsoBucket[]) => agruparPorPlugin(items, (item) => item.cost, '@nativo').map((group) => {
  const agents = group.itens.map((item) => ({ ...item, total: sumItems(items.filter((bucket) => item.keys.includes(bucket.key))) })).sort((a, b) => b.total.cost - a.total.cost || b.total.chamadas - a.total.chamadas || a.nome.localeCompare(b.nome));
  return { plugin: group.plugin, total: sumItems(agents.map((item) => item.total)), agents };
});
const filterNames = () => ({ conta: m.uso_conta(), projeto: m.uso_projeto(), modelo: m.uso_modelo(), plugin: m.uso_plugin() });

type UsageSelection = { tab: UsageTab; item: UsoBucket; label: string };

function UsageDetail({ servers, period, filters, selection, presenceAvailable, active, close }: { servers: Server[]; period: string; filters: UsoFiltros; selection: UsageSelection; presenceAvailable: boolean; active: boolean; close: () => void }) {
  const { tab, item: selectedItem, label } = selection;
  const held = tab === 'by_skill' || tab === 'by_plugin';
  const detailFilters = tab === 'by_plugin' ? { ...filters, plugin: [selectedItem.key] } : { ...filters, foco: selectedItem.key };
  const load = useReports('usage', servers, period, detailFilters, active);
  const report = mergeUso(load.parts, period).report;
  const item = load.accepted ? report[tab].find((bucket) => bucket.key === selectedItem.key) ?? selectedItem : selectedItem;
  const colors = useChartColors();
  const metric = tab === 'by_plugin' ? m.uso_col_chamadas() : held ? m.uso_col_peso() : tab === 'by_agente' ? m.uso_col_tokens() : m.uso_col_ctx();
  return <Sheet open onDismiss={close} sizes={['large']} scrollable><ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
    <Copy title>{`${m.uso_foco()}: ${label}`}</Copy>
    {item.plugin && <Copy muted>{groupName(item.plugin)}</Copy>}
    <Card>
      <Copy>{`${m.uso_col_chamadas()}: ${number(item.chamadas)} · ${m.uso_col_sessoes()}: ${number(item.sessions)}`}</Copy>
      {(tab === 'by_skill' || tab === 'by_agente') && <Copy>{`${tab === 'by_skill' ? m.uso_col_origem_skill() : m.uso_col_origem_agente()}: ${number(item.pedidas)} / ${number(item.chamadas - item.pedidas)}`}</Copy>}
      {tab === 'by_agente' && <>
        <Copy>{`${m.uso_col_custo_real()}: ${dollars(item.cost)}`}</Copy>
        {(['input', 'output', 'cache_write', 'cache_read'] as const).map((type, index) => <Copy key={type}>{`${[m.custos_input_sem_cache(), m.custos_output_total(), m.custos_tipo_cache_escrito(), m.custos_tipo_cache_lido()][index]}: ${number(item[type])} · ${dollars(item[`cost_${type}`])}`}</Copy>)}
        <Copy>{`${m.uso_col_tok_sem_cache_chamada()}: ${number(item.chamadas > 0 ? (item.input + item.output) / item.chamadas : 0, 1)}`}</Copy>
      </>}
      {held && <>
        <Copy>{`${m.uso_col_ocupados_eq()}: ${presenceAvailable ? `≈ ${number(item.ocupados_eq_tokens_est ?? 0)}` : '—'}`}</Copy>
        <Copy>{`${m.uso_col_ocupados()}: ${presenceAvailable ? `≈ ${number(item.ocupados_tokens_est ?? 0)}` : '—'}`}</Copy>
        <Copy>{`${m.uso_col_respostas()}: ${number(item.respostas ?? 0)}`}</Copy>
      </>}
      <Copy>{`${m.uso_col_ctx()}: ≈ ${number(item.ctx_tokens_est)}`}</Copy>
      <Copy>{`${m.uso_detalhe_ctx_chamada()}: ≈ ${number(item.chamadas > 0 ? item.ctx_tokens_est / item.chamadas : 0, 1)}`}</Copy>
      <Copy>{`${m.uso_detalhe_media_sessao()}: ≈ ${number(item.sessions > 0 ? item.ctx_tokens_est / item.sessions : 0, 1)}`}</Copy>
    </Card>
    <Action label={m.custos_atualizar()} icon="RefreshCw" onPress={load.refresh} />
    <ReportStatus {...load} selected={servers.length} />
    {load.accepted && <><Copy title>{`${m.uso_detalhe_por_dia()} (${metric})`}</Copy>
      {!report.by_day.length ? <Copy>{m.uso_detalhe_sem_serie()}</Copy> : <Columns label={m.uso_detalhe_por_dia()} days={[...report.by_day].sort((a, b) => a.key.localeCompare(b.key)).map((day) => ({ key: day.key, values: [tab === 'by_plugin' ? day.chamadas : held && !presenceAvailable ? null : measure(day, tab).value] }))} series={[{ key: tab, label: metric, color: colors[0] }]} />}
    </>}
    <Action label={m.native_close()} icon="X" onPress={close} />
  </ScrollView></Sheet>;
}

export function StatsScreen() {
  const router = useRouter();
  const back = useCallback(() => router.back(), [router]);
  const active = useIsFocused();
  const { period, own, selected } = useReportSelection();
  const [filters, setFilters] = useState<UsoFiltros>({});
  const [options, setOptions] = useState<Record<FilterKey, UsoBucket[]>>({ conta: [], projeto: [], modelo: [], plugin: [] });
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<UsageTab>('by_skill');
  const [orders, setOrders] = useState<Partial<Record<UsageTab, { column: Sort; descending: boolean }>>>({});
  const order = orders[tab] ?? { column: 'weight' as Sort, descending: true };
  const sort = order.column;
  const setSort = (column: Sort) => setOrders((old) => ({ ...old, [tab]: { column, descending: order.column === column ? !order.descending : column !== 'name' } }));
  const [openGroups, setOpenGroups] = useState<Set<string> | null>(null);
  const [skillSort, setSkillSort] = useState<'weight' | 'calls'>('weight');
  const colors = useChartColors();
  const [advanced, setAdvanced] = useState(false);
  const [focus, setFocus] = useState<UsageSelection | null>(null);
  const load = useReports('usage', selected, period, filters, active);
  const report = mergeUso(load.parts, period).report;
  const presenceMissing = load.parts.filter((part) => part.report && !part.error && (['by_skill', 'by_plugin'] as const).some((dimension) => part.report![dimension]?.some((item) => item.ocupados_eq_tokens_est == null)));
  const presenceAvailable = presenceMissing.length === 0;
  const presenceTab = tab === 'by_skill' || tab === 'by_plugin';
  const effectiveSort = !presenceAvailable && presenceTab && sort === 'weight' ? 'calls' : sort;
  const names = filterNames();
  const tabs: Record<UsageTab, string> = { by_skill: m.uso_aba_skills(), by_agente: m.uso_aba_agentes(), by_plugin: m.uso_aba_plugins(), by_tool: m.uso_aba_tools(), by_bash: m.uso_aba_bash(), by_mcp: m.uso_aba_mcp(), by_contexto: m.uso_aba_contexto(), by_imagem: m.uso_aba_imagens() };

  useEffect(() => {
    if (!load.accepted) return;
    const merged = mergeUso(load.parts, period).report;
    setOptions((previous) => Object.fromEntries(filterKeys.map((key) => {
      const list = new Map(previous[key].map((item) => [item.key, item]));
      for (const item of merged[`by_${key}`]) list.set(item.key, item);
      return [key, [...list.values()]];
    })) as Record<FilterKey, UsoBucket[]>);
  }, [load.parts, load.accepted, period]);

  const matches = (text: string) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim());
  const list = (tab === 'by_tool' ? toolsOf(report) : report[tab]).filter((item) => matches(`${item.label ?? ''} ${item.key} ${item.plugin ?? ''} ${tab === 'by_imagem' ? imageLabel(item.key) : ''}`));
  const sortValue = (item: UsoBucket) => effectiveSort === 'calls' ? item.chamadas : effectiveSort === 'cost' ? item.cost : effectiveSort === 'perCall' ? measure(item, tab).perCall : effectiveSort === 'replies' ? item.respostas ?? 0 : effectiveSort === 'sessions' ? item.sessions : measure(item, tab).value;
  list.sort((a, b) => (effectiveSort === 'name' ? (a.label ?? a.key).localeCompare(b.label ?? b.key) : sortValue(a) - sortValue(b)) * (order.descending ? -1 : 1) || a.key.localeCompare(b.key));
  const groupSort = presenceAvailable ? skillSort : 'calls';
  const groups = agruparPorPlugin(report.by_skill.filter((item) => matches(`${item.key} ${item.plugin ?? ''} ${groupName(item.plugin ?? '')}`)), weight);
  groups.sort((a, b) => (groupSort === 'calls' ? b.vezes - a.vezes || b.peso - a.peso : b.peso - a.peso || b.vezes - a.vezes) || a.plugin.localeCompare(b.plugin));
  const tools = toolsOf(report).filter((item) => item.chamadas > 0);
  const toolCalls = tools.reduce((sum, item) => sum + item.chamadas, 0);
  const allGroups = agruparPorPlugin(report.by_skill, weight);
  const skillItems = allGroups.flatMap((group) => group.itens.map((item) => ({ ...item, plugin: group.plugin })));
  const pluginTop = allGroups.find((group) => group.plugin && !group.plugin.startsWith('@') && group.peso > 0);
  const heavySkill = [...skillItems].filter((item) => item.peso > 0).sort((a, b) => b.peso - a.peso)[0];
  const loadedSkill = [...skillItems].filter((item) => item.vezes > 0).sort((a, b) => b.vezes - a.vezes)[0];
  const agents = agentGroups(report.by_agente);
  const costlyAgent = agents.flatMap((group) => group.agents).filter((item) => item.total.cost > 0).sort((a, b) => b.total.cost - a.total.cost)[0];
  const costlyPlugin = agents.find((group) => group.plugin && !group.plugin.startsWith('@') && group.total.cost > 0);
  const totalWeight = allGroups.reduce((sum, group) => sum + group.peso, 0);
  const commands = [...report.by_bash].sort((a, b) => b.chamadas - a.chamadas).slice(0, 5).map((item) => `${item.key} ${number(item.chamadas)}`).join(', ');
  const brief = (label: string, item: string | undefined, value?: string) => <Card><Copy>{label}</Copy><Copy title>{item ?? '—'}</Copy>{value && <Copy muted>{value}</Copy>}</Card>;
  const categories = [m.uso_ctx_cat_instrucoes(), m.uso_ctx_cat_catalogo(), m.uso_ctx_cat_hooks(), m.uso_ctx_cat_lembretes(), m.uso_ctx_cat_outros()];
  const categoryTotals = categories.map((label, index) => ({ label, value: report.by_contexto.filter((item) => contextCategory(item.key) === index).reduce((sum, item) => sum + item.ctx_tokens_est, 0) / Math.max(1, report.totals.sessions) }));

  const rowValue = (item: UsoBucket) => effectiveSort === 'calls' || !presenceAvailable && presenceTab ? item.chamadas : effectiveSort === 'cost' && tab === 'by_agente' ? item.cost : measure(item, tab).value;
  const listMax = Math.max(1, ...list.map(rowValue));
  const mainColumn = presenceTab ? m.uso_col_peso() : tab === 'by_agente' ? m.uso_col_tokens() : m.uso_col_ctx();
  const callsColumn = presenceTab ? m.uso_col_cargas() : m.uso_col_chamadas();
  const perColumn = tab === 'by_contexto' ? m.uso_col_media() : tab === 'by_agente' ? m.uso_col_tok_chamada() : presenceTab ? m.uso_col_tamanho() : m.uso_col_ctx_chamada();
  const columns: { key: Sort; label: string }[] = [{ key: 'name', label: m.uso_col_nome() }, { key: 'calls', label: callsColumn }, { key: 'weight', label: mainColumn }, { key: 'perCall', label: perColumn }, ...(presenceTab ? [{ key: 'replies' as Sort, label: m.uso_col_respostas() }] : []), { key: 'sessions', label: m.uso_col_sessoes() }, ...(tab === 'by_agente' ? [{ key: 'cost' as Sort, label: m.uso_col_custo_real() }] : [])];
  const contextTotal = categoryTotals.reduce((sum, item) => sum + item.value, 0);
  const row = (item: UsoBucket) => {
    const measured = measure(item, tab);
    return <Card><Bar label={tab === 'by_imagem' ? imageLabel(item.key) : item.label ?? item.key} value={rowValue(item)} max={listMax} detail={!presenceAvailable && presenceTab ? '—' : `${measured.approximate ? '≈ ' : ''}${number(measured.value)}`} onPress={() => setFocus({ tab, item, label: tab === 'by_imagem' ? imageLabel(item.key) : item.label ?? item.key })} />
      <Copy muted>{`${callsColumn}: ${number(item.chamadas)} · ${m.uso_col_sessoes()}: ${number(item.sessions)} · ${perColumn}: ${measured.approximate ? '≈ ' : ''}${number(measured.perCall, 1)}`}</Copy>
      {presenceTab && <Copy>{`${m.uso_col_respostas()}: ${number(item.respostas ?? 0)}`}</Copy>}
      {tab === 'by_agente' && <><Copy>{`${m.uso_col_custo_real()}: ${dollars(item.cost)}`}</Copy><Copy>{`${m.custos_input_sem_cache()}: ${number(item.input)} · ${m.custos_output_total()}: ${number(item.output)} · ${m.custos_tipo_cache_escrito()}: ${number(item.cache_write)} · ${m.custos_tipo_cache_lido()}: ${number(item.cache_read)}`}</Copy></>}
    </Card>;
  };

  const agentValues = (item: UsoBucket, sessions = true) => <>
    <Copy>{`${m.uso_col_custo_real()}: ${dollars(item.cost)} · ${m.uso_col_chamadas()}: ${number(item.chamadas)} · ${m.uso_col_sessoes()}: ${sessions ? number(item.sessions) : '—'}`}</Copy>
    {(['input', 'output', 'cache_write', 'cache_read'] as const).map((type, index) => <Copy key={type}>{`${[m.custos_input_sem_cache(), m.custos_output_total(), m.custos_tipo_cache_escrito(), m.custos_tipo_cache_lido()][index]}: ${number(item[type])} · ${dollars(item[`cost_${type}`])}`}</Copy>)}
  </>;

  return <ReportFrame title={m.uso_painel_titulo()} back={back} sibling={m.uso_ir_custos()} onSibling={back}>
    <ReportControls own={own} refresh={load.refresh} />
    <ReportStatus {...load} selected={selected.length} />
    {!presenceAvailable && <Copy>{m.mobile_usage_presence_unavailable({ machines: presenceMissing.map((part) => part.label).join(', ') })}</Copy>}
    <Copy muted>{m.uso_aviso()}</Copy>
    <Card><Copy title>{m.uso_filtros()}</Copy>
      {filterKeys.map((key) => <Choice key={key} label={names[key]} options={options[key]} values={filters[key] ?? []} onChange={(values) => { const next = { ...filters }; if (values.length) next[key] = values; else delete next[key]; setFilters(next); }} />)}
      <Search value={query} onChange={setQuery} />
      <Action label={m.uso_limpar()} onPress={() => { setFilters({}); setQuery(''); }} />
    </Card>
    {load.accepted && <>
      <Grid>
        {brief(m.uso_resp_plugin_skills(), presenceAvailable && pluginTop ? groupName(pluginTop.plugin) : undefined, presenceAvailable && pluginTop ? m.uso_resp_plugin_skills_sub({ n: number(pluginTop.peso), pct: number(totalWeight > 0 ? pluginTop.peso / totalWeight * 100 : 0) }) : undefined)}
        {brief(m.uso_resp_skill_contexto(), presenceAvailable ? heavySkill?.nome : undefined, presenceAvailable && heavySkill ? m.uso_resp_grupo_contexto({ grupo: groupName(heavySkill.plugin), n: number(heavySkill.peso) }) : undefined)}
        {brief(m.uso_resp_skill_usada(), loadedSkill?.nome, loadedSkill ? m.uso_resp_grupo_vezes({ grupo: groupName(loadedSkill.plugin), n: number(loadedSkill.vezes) }) : undefined)}
        {brief(m.uso_resp_plugin_agentes(), costlyPlugin ? groupName(costlyPlugin.plugin) : undefined, costlyPlugin ? m.uso_resp_agente_custo_sub({ custo: dollars(costlyPlugin.total.cost), n: number(costlyPlugin.total.chamadas) }) : undefined)}
        {brief(m.uso_resp_agente_caro(), costlyAgent?.nome, costlyAgent ? m.uso_resp_agente_custo_sub({ custo: dollars(costlyAgent.total.cost), n: number(costlyAgent.total.chamadas) }) : undefined)}
        {brief(m.uso_resp_ferramenta(), tools[0]?.key, tools[0] ? m.uso_resp_ferramenta_sub({ pct: number(tools[0].chamadas / toolCalls * 100), n: number(tools[0].chamadas) }) : undefined)}
      </Grid>
      <Card><Copy title>{m.uso_sec_por_plugin()}</Copy><Copy muted>{m.uso_legenda_peso()}</Copy><Copy muted>{m.uso_legenda_vezes()}</Copy><Copy muted>{m.uso_grupo_nota()}</Copy><Copy muted>{m.uso_ocupados_eq_nota()}</Copy>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}><Action label={m.uso_ordenar_por({ col: m.uso_col_peso() })} selected={groupSort === 'weight'} disabled={!presenceAvailable} onPress={() => setSkillSort('weight')} /><Action label={m.uso_ordenar_por({ col: m.uso_col_vezes() })} selected={groupSort === 'calls'} onPress={() => setSkillSort('calls')} /></View>
        <Paged key={query} items={groups} render={(group) => {
          const open = openGroups ? openGroups.has(group.plugin) : group.plugin === groups[0]?.plugin;
          const items = [...group.itens].sort((a, b) => (groupSort === 'calls' ? b.vezes - a.vezes || b.peso - a.peso : b.peso - a.peso || b.vezes - a.vezes) || a.nome.localeCompare(b.nome));
          return <Card><Action label={groupName(group.plugin)} icon={open ? 'ChevronDown' : 'ChevronRight'} onPress={() => setOpenGroups((old) => { const next = new Set(old ?? [groups[0]?.plugin]); if (!next.delete(group.plugin)) next.add(group.plugin); return next; })} />
            <Copy muted>{presenceAvailable ? m.uso_grupo_n_skills({ n: group.itens.length, pct: number(totalWeight > 0 ? group.peso / totalWeight * 100 : 0) }) : '—'}</Copy>
            <Bar label={m.uso_col_peso()} value={presenceAvailable ? group.peso : 0} max={Math.max(1, ...groups.map((item) => item.peso))} detail={presenceAvailable ? `≈ ${number(group.peso)}` : '—'} color={colors[0]} />
            <Bar label={m.uso_col_cargas()} value={group.vezes} max={Math.max(1, ...groups.map((item) => item.vezes))} detail={number(group.vezes)} color={colors[1]} />
            {open && <Paged key={groupSort} items={items} render={(item) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.nome}: ${presenceAvailable ? `≈ ${number(item.peso)}` : '—'} · ${number(item.vezes)}`} onPress={() => setFocus({ tab: 'by_skill', item: report.by_skill.find((bucket) => bucket.key === item.keys[0])!, label: item.nome })} style={{ minHeight: 44, gap: 6, paddingVertical: 8 }}><Copy>{item.nome}</Copy>
              <Bar label={m.uso_col_peso()} value={presenceAvailable ? item.peso : 0} max={Math.max(1, ...groups.flatMap((group) => group.itens.map((item) => item.peso)))} detail={presenceAvailable ? `≈ ${number(item.peso)}` : '—'} color={colors[0]} />
              <Bar label={m.uso_col_cargas()} value={item.vezes} max={Math.max(1, ...groups.flatMap((group) => group.itens.map((item) => item.vezes)))} detail={number(item.vezes)} color={colors[1]} />
            </Pressable>} />}
          </Card>;
        }} />
      </Card>
      <Card><Copy title>{m.uso_rank_ferramentas()}</Copy><Copy muted>{m.uso_ferr_nota()}</Copy>{!tools.length && <Copy muted>{m.uso_vazio_secao()}</Copy>}{tools.slice(0, 12).map((item) => <View key={item.key}><Bar label={item.key} value={item.chamadas} max={tools[0]?.chamadas ?? 1} detail={`${number(item.chamadas)} · ${percent(item.chamadas, toolCalls)}`} onPress={() => setFocus({ tab: 'by_tool', item, label: item.label ?? item.key })} />{item.key === 'Bash' && commands && <Copy muted>{m.uso_ferr_bash({ lista: commands })}</Copy>}</View>)}{tools.length > 12 && <Copy muted>{m.uso_mais_na_tabela({ n: tools.length - 12 })}</Copy>}</Card>
      <Card><Copy title>{m.uso_sub_titulo()}</Copy><Copy muted>{m.uso_sub_nota()}</Copy><Paged items={agents} render={(group) => <Card><Copy title>{groupName(group.plugin)}</Copy><Copy muted>{m.uso_agentes_n({ n: group.agents.length })}</Copy>{agentValues(group.total, false)}
        {group.agents.map((item) => <Pressable key={item.keys[0]} accessibilityRole="button" accessibilityLabel={`${item.nome}: ${dollars(item.total.cost)}`} onPress={() => setFocus({ tab: 'by_agente', item: report.by_agente.find((bucket) => bucket.key === item.keys[0])!, label: item.nome })} style={{ minHeight: 44, paddingVertical: 10, gap: 8 }}><Copy title>{item.nome}</Copy>{agentValues(item.total)}</Pressable>)}
      </Card>} /><Copy muted>{m.uso_cache_legado_nota()}</Copy></Card>
      <Action label={m.uso_avancado()} icon={advanced ? 'ChevronDown' : 'ChevronRight'} selected={advanced} onPress={() => setAdvanced(!advanced)} />
      {advanced && <>
        <Card><Copy title>{m.uso_graf_chamadas_dia()}</Copy><Copy muted>{m.uso_graf_chamadas_dia_nota()}</Copy><Columns label={m.uso_graf_chamadas_dia()} days={[...report.by_day].sort((a, b) => a.key.localeCompare(b.key)).map((item) => ({ key: item.key, values: [item.chamadas] }))} series={[{ key: 'calls', label: m.uso_col_chamadas(), color: colors[0] }]} /></Card>
        <Card><Copy title>{m.uso_graf_ctx()}</Copy><Copy muted>{m.uso_graf_ctx_nota()}</Copy><Copy>{`≈ ${number(contextTotal, 1)} ${m.uso_por_sessao()}`}</Copy><Composition label={m.uso_graf_ctx()} items={categoryTotals.map((item, index) => ({ ...item, color: colors[index] }))} />{categoryTotals.map((item, index) => <View key={item.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 8, height: 8, backgroundColor: colors[index] }} /><View style={{ flex: 1 }}><Copy>{item.label}</Copy><Copy muted>{`≈ ${number(item.value, 1)} · ${percent(item.value, contextTotal)}`}</Copy></View></View>)}</Card>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={{ flexDirection: 'row' }}>{usageTabs.map((key) => <Action key={key} label={tabs[key]} selected={tab === key} onPress={() => setTab(key)} />)}</View></ScrollView>
        <View accessibilityLabel={tabs[tab]}><Card><Copy title>{tabs[tab]}</Copy>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{columns.map((column) => <Action key={column.key} label={m.uso_ordenar_por({ col: column.label })} selected={effectiveSort === column.key} disabled={!presenceAvailable && presenceTab && column.key === 'weight'} onPress={() => setSort(column.key)} />)}</View>
          {tab === 'by_agente' && <Copy muted>{m.uso_sec_agentes_nota()}</Copy>}
          {tab === 'by_contexto' && <Copy muted>{m.uso_sec_contexto_nota()}</Copy>}
          {tab === 'by_imagem' && <Copy muted>{m.uso_sec_imagens_nota()}</Copy>}
          <Paged key={`${tab}:${query}:${sort}:${order.descending}`} items={list} render={row} />
        </Card></View>
      </>}
    </>}
    {focus !== null && <UsageDetail key={`${focus.tab}:${focus.item.key}`} servers={selected} period={period} filters={filters} selection={focus} presenceAvailable={presenceAvailable} active={active} close={() => setFocus(null)} />}
  </ReportFrame>;
}
