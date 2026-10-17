import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { agruparPorPlugin, mergeUso, type Server, type UsoBucket, type UsoFiltros } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { Action, Bar, Card, Choice, Copy, dollars, number, Paged, ReportControls, ReportFrame, ReportStatus, Search, useReportSelection } from './ReportUI';
import { contextCategory, measure, toolsOf, usageTabs, type UsageTab } from './stats-model';
import { useReports } from './useReports';
import * as m from '../../paraglide/messages';

type FilterKey = 'conta' | 'projeto' | 'modelo' | 'plugin';
type Sort = 'weight' | 'calls' | 'name' | 'cost';
const filterKeys: FilterKey[] = ['conta', 'projeto', 'modelo', 'plugin'];
const groupName = (key: string) => {
  const names: Record<string, string> = { '@repo': m.uso_grupo_repo(), '@pessoal': m.uso_grupo_pessoal(), '@avulsa': m.uso_grupo_avulsa(), '@embutida': m.uso_grupo_embutida(), '@nativo': m.uso_grupo_nativo(), '': m.uso_grupo_sem() };
  return names[key] ?? key;
};
const weight = (item: UsoBucket) => item.ocupados_eq_tokens_est ?? 0;
const filterNames = () => ({ conta: m.uso_conta(), projeto: m.uso_projeto(), modelo: m.uso_modelo(), plugin: m.uso_plugin() });

function UsageDetail({ servers, period, filters, focus, plugin, active, close }: { servers: Server[]; period: string; filters: UsoFiltros; focus: string; plugin: boolean; active: boolean; close: () => void }) {
  const detailFilters = plugin ? { ...filters, plugin: [focus] } : { ...filters, foco: focus };
  const load = useReports('usage', servers, period, detailFilters, active);
  const report = mergeUso(load.parts, period).report;
  return <Sheet open onDismiss={close} sizes={['large']} scrollable><ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
    <Copy title>{`${m.uso_foco()}: ${focus}`}</Copy>
    <Action label={m.custos_atualizar()} icon="RefreshCw" onPress={load.refresh} />
    <ReportStatus {...load} selected={servers.length} />
    {load.accepted && <><Copy title>{m.uso_detalhe_por_dia()}</Copy>
      {!report.by_day.length && <Copy>{m.uso_detalhe_sem_serie()}</Copy>}
      <Paged items={report.by_day} render={(day) => <Card><Copy>{day.key}</Copy><Copy>{`${m.uso_col_chamadas()}: ${number(day.chamadas)}${plugin ? '' : ` · ${m.uso_detalhe_tokens()}: ${number(day.input + day.output)}`}`}</Copy><Copy>{`${m.uso_col_ctx()}: ≈ ${number(day.ctx_tokens_est)} · ${m.uso_col_custo_real()}: ${dollars(day.cost)}`}</Copy></Card>} />
    </>}
    <Action label={m.native_close()} icon="X" onPress={close} />
  </ScrollView></Sheet>;
}

export function StatsScreen() {
  const router = useRouter();
  const active = useIsFocused();
  const { period, own, selected } = useReportSelection();
  const [filters, setFilters] = useState<UsoFiltros>({});
  const [options, setOptions] = useState<Record<FilterKey, UsoBucket[]>>({ conta: [], projeto: [], modelo: [], plugin: [] });
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<UsageTab>('by_skill');
  const [sort, setSort] = useState<Sort>('weight');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [advanced, setAdvanced] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
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
  const list = (tab === 'by_tool' ? toolsOf(report) : report[tab]).filter((item) => matches(`${item.label ?? ''} ${item.key} ${item.plugin ?? ''}`));
  list.sort((a, b) => (effectiveSort === 'name' ? 0 : effectiveSort === 'calls' ? b.chamadas - a.chamadas : effectiveSort === 'cost' ? b.cost - a.cost : measure(b, tab).value - measure(a, tab).value) || (a.label ?? a.key).localeCompare(b.label ?? b.key));
  const groups = agruparPorPlugin(report.by_skill.filter((item) => matches(`${item.key} ${item.plugin ?? ''}`)), presenceAvailable ? weight : (item) => item.chamadas);
  groups.sort((a, b) => (effectiveSort === 'calls' ? b.vezes - a.vezes : effectiveSort === 'name' ? 0 : b.peso - a.peso) || a.plugin.localeCompare(b.plugin));
  const tools = toolsOf(report);
  const allGroups = agruparPorPlugin(report.by_skill, weight);
  const heavySkill = [...report.by_skill].sort((a, b) => weight(b) - weight(a))[0];
  const loadedSkill = [...report.by_skill].sort((a, b) => b.chamadas - a.chamadas)[0];
  const loadedPlugin = [...report.by_plugin].sort((a, b) => b.chamadas - a.chamadas)[0];
  const costlyAgent = [...report.by_agente].sort((a, b) => b.cost - a.cost)[0];
  const costlyPlugin = agruparPorPlugin(report.by_agente, (item) => item.cost)[0];
  const brief = (label: string, item: string | undefined, value?: string) => <Card><Copy>{label}</Copy><Copy title>{item ?? '—'}</Copy>{value && <Copy muted>{value}</Copy>}</Card>;
  const categories = [m.uso_ctx_cat_instrucoes(), m.uso_ctx_cat_catalogo(), m.uso_ctx_cat_hooks(), m.uso_ctx_cat_lembretes(), m.uso_ctx_cat_outros()];
  const categoryTotals = categories.map((label, index) => ({ label, value: report.by_contexto.filter((item) => contextCategory(item.key) === index).reduce((sum, item) => sum + item.ctx_tokens_est, 0) / Math.max(1, report.totals.sessions) }));

  const rowValue = (item: UsoBucket) => effectiveSort === 'calls' || !presenceAvailable && presenceTab ? item.chamadas : effectiveSort === 'cost' && tab === 'by_agente' ? item.cost : measure(item, tab).value;
  const listMax = Math.max(1, ...list.map(rowValue));
  const dailyMax = Math.max(1, ...report.by_day.map((item) => item.chamadas));
  const row = (item: UsoBucket) => {
    const measured = measure(item, tab);
    return <Card><Bar label={item.label ?? item.key} value={rowValue(item)} max={listMax} detail={!presenceAvailable && presenceTab ? '—' : `${measured.approximate ? '≈ ' : ''}${number(measured.value)}`} onPress={() => setFocus(item.key)} />
      <Copy muted>{`${m.uso_col_chamadas()}: ${number(item.chamadas)} · ${m.uso_col_sessoes()}: ${number(item.sessions)} · ${tab === 'by_contexto' ? m.uso_col_media() : tab === 'by_agente' ? m.uso_col_tok_chamada() : tab === 'by_plugin' ? m.uso_col_tamanho() : m.uso_col_ctx_chamada()}: ${measured.approximate ? '≈ ' : ''}${number(measured.perCall, 1)}`}</Copy>
      {tab === 'by_agente' && <><Copy>{`${m.uso_col_custo_real()}: ${dollars(item.cost)}`}</Copy><Copy>{`${m.custos_input_sem_cache()}: ${number(item.input)} · ${m.custos_output_total()}: ${number(item.output)} · ${m.custos_tipo_cache_escrito()}: ${number(item.cache_write)} · ${m.custos_tipo_cache_lido()}: ${number(item.cache_read)}`}</Copy></>}
    </Card>;
  };

  return <ReportFrame title={m.uso_painel_titulo()} back={() => router.back()} sibling={m.uso_ir_custos()} onSibling={() => router.back()}>
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
      <View style={{ gap: 10 }}>
        {brief(m.uso_resp_skill_contexto(), presenceAvailable ? heavySkill?.key : undefined, presenceAvailable && heavySkill ? `≈ ${number(weight(heavySkill))}` : undefined)}
        {brief(m.uso_resp_skill_usada(), loadedSkill?.key, loadedSkill ? `${number(loadedSkill.chamadas)} · ${m.uso_col_vezes()}` : undefined)}
        {brief(m.uso_resp_plugin_skills(), presenceAvailable && allGroups[0] ? groupName(allGroups[0].plugin) : undefined, presenceAvailable && allGroups[0] ? `≈ ${number(allGroups[0].peso)}` : undefined)}
        {brief(m.mobile_usage_most_loaded_plugin(), loadedPlugin ? groupName(loadedPlugin.key) : undefined, loadedPlugin ? `${number(loadedPlugin.chamadas)} · ${m.uso_col_vezes()}` : undefined)}
        {brief(m.uso_resp_plugin_agentes(), costlyPlugin ? groupName(costlyPlugin.plugin) : undefined, costlyPlugin ? dollars(costlyPlugin.peso) : undefined)}
        {brief(m.uso_resp_agente_caro(), costlyAgent?.key, costlyAgent ? dollars(costlyAgent.cost) : undefined)}
        {brief(m.uso_resp_ferramenta(), tools[0]?.key, tools[0] ? number(tools[0].chamadas) : undefined)}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={{ flexDirection: 'row' }}>{usageTabs.map((key) => <Action key={key} label={tabs[key]} selected={tab === key} onPress={() => { setTab(key); setFocus(null); setSort(key === 'by_tool' ? 'calls' : 'weight'); }} />)}</View></ScrollView>
      <Card><Copy title>{tabs[tab]}</Copy>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Action label={m.uso_ordenar_por({ col: m.uso_col_peso() })} selected={effectiveSort === 'weight'} disabled={!presenceAvailable && presenceTab} onPress={() => setSort('weight')} />
          <Action label={m.uso_ordenar_por({ col: m.uso_col_chamadas() })} selected={effectiveSort === 'calls'} onPress={() => setSort('calls')} />
          <Action label={m.uso_ordenar_por({ col: m.uso_col_nome() })} selected={effectiveSort === 'name'} onPress={() => setSort('name')} />
          {tab === 'by_agente' && <Action label={m.uso_ordenar_por({ col: m.uso_col_custo_real() })} selected={sort === 'cost'} onPress={() => setSort('cost')} />}
        </View>
        {tab === 'by_skill' ? <>
          <Copy title>{m.uso_sec_por_plugin()}</Copy><Copy muted>{m.uso_grupo_nota()}</Copy><Copy muted>{m.uso_ocupados_eq_nota()}</Copy>
          <Paged key={`${tab}:${query}:${sort}`} items={groups} render={(group) => {
            const groupMax = Math.max(1, ...group.itens.map((item) => effectiveSort === 'calls' ? item.vezes : item.peso));
            return <Card>
              <Action label={groupName(group.plugin)} icon={collapsed.has(group.plugin) ? 'ChevronRight' : 'ChevronDown'} onPress={() => setCollapsed((old) => old.has(group.plugin) ? new Set([...old].filter((key) => key !== group.plugin)) : new Set([...old, group.plugin]))} />
              <Copy>{`${presenceAvailable ? `≈ ${number(group.peso)}` : '—'} · ${number(group.vezes)} ${m.uso_col_vezes()}`}</Copy>
              {!collapsed.has(group.plugin) && <Paged key={effectiveSort} items={[...group.itens].sort((a, b) => (effectiveSort === 'calls' ? b.vezes - a.vezes : effectiveSort === 'name' ? 0 : b.peso - a.peso) || a.nome.localeCompare(b.nome))} render={(item) => <Bar label={item.nome} value={effectiveSort === 'calls' ? item.vezes : item.peso} max={groupMax} detail={`${presenceAvailable ? `≈ ${number(item.peso)}` : '—'} · ${number(item.vezes)}`} onPress={() => setFocus(item.keys[0])} />} />}
            </Card>;
          }} />
        </> : <>
          {tab === 'by_agente' && <><Copy muted>{m.uso_sec_agentes_nota()}</Copy><Copy muted>{m.uso_cache_legado_nota()}</Copy></>}
          {tab === 'by_tool' && <><Copy title>{m.uso_rank_ferramentas()}</Copy><Copy muted>{m.uso_ferr_nota()}</Copy></>}
          {tab === 'by_contexto' && <Copy muted>{m.uso_sec_contexto_nota()}</Copy>}
          {tab === 'by_imagem' && <Copy muted>{m.uso_sec_imagens_nota()}</Copy>}
          <Paged key={`${tab}:${query}:${sort}`} items={list} render={row} />
        </>}
      </Card>
      <Action label={m.uso_avancado()} icon={advanced ? 'ChevronDown' : 'ChevronRight'} selected={advanced} onPress={() => setAdvanced(!advanced)} />
      {advanced && <>
        <Card><Copy title>{m.uso_graf_chamadas_dia()}</Copy><Copy muted>{m.uso_graf_chamadas_dia_nota()}</Copy><Paged items={report.by_day} render={(item) => <Bar label={item.key} value={item.chamadas} max={dailyMax} detail={`${number(item.chamadas)} · ${dollars(item.cost)}`} />} /></Card>
        <Card><Copy title>{m.uso_graf_ctx()}</Copy><Copy muted>{m.uso_graf_ctx_nota()}</Copy>{categoryTotals.map((item) => <Bar key={item.label} label={item.label} value={item.value} max={Math.max(1, ...categoryTotals.map((b) => b.value))} detail={`≈ ${number(item.value, 1)}`} />)}</Card>
      </>}
    </>}
    {focus !== null && <UsageDetail key={focus} servers={selected} period={period} filters={filters} focus={focus} plugin={tab === 'by_plugin'} active={active} close={() => setFocus(null)} />}
  </ReportFrame>;
}
