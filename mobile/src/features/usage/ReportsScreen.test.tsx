// @vitest-environment happy-dom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureLocale, localeAtual, mergeReports, zeroUso, type ComboRow, type CostReport, type Server, type UsoFiltros } from '@hangar/core';
const net = vi.hoisted(() => ({ costs: vi.fn(), usage: vi.fn(), push: vi.fn(), back: vi.fn(), screen: vi.fn(), canGoBack: false, focused: true }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), fetchCostsForServer: net.costs, fetchUsoForServer: net.usage }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: net.push, back: net.back, canGoBack: () => net.canGoBack }),
  useIsFocused: () => net.focused,
  Stack: { Screen: ({ options }: { options: { title: string; headerLeft?: () => ReactNode } }) => {
    net.screen(options);
    return options.headerLeft?.() ?? null;
  } },
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 72 }));
vi.mock('expo-blur', () => ({ BlurView: ({ children }: { children: ReactNode }) => children }));
vi.mock('expo-glass-effect', () => ({ GlassView: ({ children }: { children: ReactNode }) => children, isLiquidGlassAvailable: () => false }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}) }));
vi.mock('../../ui/Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => React.createElement('section', { 'data-sheet-mounted': true }, open ? React.createElement('aside', null, children) : null) }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('react-native', async (original) => ({ ...await original<typeof import('react-native')>(), TextInput: ({ value, onChangeText, accessibilityLabel }: { value: string; onChangeText: (text: string) => void; accessibilityLabel: string }) => React.createElement('input', { value, 'aria-label': accessibilityLabel, onInput: (event: React.FormEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value) }) }));
import CostsScreen from '../../../app/costs';
import StatsScreen from '../../../app/stats';
import { useServers } from '../../stores/servers';
import { useUsagePreferences } from './ReportUI';
import * as m from '../../paraglide/messages';
import { getLocale, overwriteGetLocale } from '../../paraglide/runtime';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const a: Server = { id: 'a', label: 'Machine A', baseUrl: 'https://a.test', token: 'token' };
const b: Server = { ...a, id: 'b', label: 'Machine B' };
const combo: ComboRow = { dia: '2026-10-01', provider: 'provider-one', source: 'claude', project: '/project-one', model: 'missing', subagente: false, sessions: 1, session_ids: ['one'], input: 100, output: 20, cache_write: 10, cache_read: 50, cost: 0, cost_input: 0, cost_output: 0, cost_cache_write: 0, cost_cache_read: 0 };
const costs = (period: string): Partial<CostReport> => {
  const full = mergeReports([{ id: a.id, report: { applied: { period }, totals: { key: 'totals', ...combo }, combos: [combo], by_model: [{ key: combo.model, ...combo }], by_provider: [{ key: combo.provider, ...combo }], by_project: [{ key: combo.project, ...combo }], by_day: [{ key: combo.dia, ...combo }], sessoes: [{ ...combo, session_id: 'one', inicio: combo.dia, fim: combo.dia, subagentes: 0, custo_regravado: 0 }] } }], period).report;
  return full;
};
const skill = { ...zeroUso('plugin:heavy'), plugin: 'plugin', chamadas: 4, ctx_tokens_est: 20, ocupados_eq_tokens_est: 800, input: 10, output: 2, cost: 0.1, sessions: 2 };
const usage = (period: string, filters: UsoFiltros) => ({ ...filters, applied: { period }, totals: skill, by_skill: [skill], by_plugin: [{ ...skill, key: 'plugin' }], by_conta: [{ ...zeroUso('account'), label: 'account' }], by_projeto: [zeroUso('/project-one')], by_modelo: [zeroUso('known')], by_agente: [{ ...skill, key: 'reviewer', input: 200, output: 40, cost: 2 }], by_tool: [{ ...skill, key: 'Read' }, { ...skill, key: 'Agent', chamadas: 100 }], by_contexto: [{ ...skill, key: 'instructions' }], by_area: [{ ...skill, key: 'front' }], by_day: filters.foco ? [{ ...skill, key: '2026-10-02' }] : [{ ...skill, key: '2026-10-01' }] });
let root: Root;
let node: HTMLDivElement;
const click = async (label: string) => {
  const button = [...node.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.getAttribute('aria-label')?.startsWith(`${label}: `) || b.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
};
const previousLocale = localeAtual();
const previousMessageLocale = getLocale();
beforeEach(() => {
  configureLocale({ getLocale: () => 'pt' });
  overwriteGetLocale(() => 'pt');
  vi.clearAllMocks(); net.focused = true; net.canGoBack = false;
  net.costs.mockImplementation((_server: Server, period: string) => Promise.resolve(costs(period)));
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve(usage(period, filters)));
  useServers.setState({ servers: [a, b, { ...a, id: 'guest', invite: true }, { ...a, id: 'disabled', disabled: true }] });
  useUsagePreferences.setState({ period: '30d', off: [] });
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); configureLocale({ getLocale: () => previousLocale }); overwriteGetLocale(() => previousMessageLocale); });

it.each([false, true])('relatórios configuram cabeçalho nativo e voltar alternativo somente sem histórico: %s', async (canGoBack) => {
  net.canGoBack = canGoBack;
  for (const [Screen, title, sibling] of [
    [CostsScreen, m.nav_custos(), m.uso_painel_titulo()],
    [StatsScreen, m.uso_painel_titulo(), m.uso_ir_custos()],
  ] as const) {
    await act(async () => root.render(React.createElement(Screen)));
    expect(net.screen).toHaveBeenLastCalledWith(expect.objectContaining({ title, headerShown: true, headerTransparent: true }));
    const options = net.screen.mock.calls.at(-1)![0];
    expect(typeof options.headerBackground).toBe('function');
    if (canGoBack) {
      expect(options.headerLeft).toBeUndefined();
      expect(node.querySelector(`button[aria-label="${m.comum_voltar()}"]`)).toBeNull();
    } else {
      expect(typeof options.headerLeft).toBe('function');
      const before = net.back.mock.calls.length;
      await click(m.comum_voltar());
      expect(net.back).toHaveBeenCalledTimes(before + 1);
    }
    await click(sibling);
  }
  expect(net.push).toHaveBeenCalledWith('/stats');
});

it.each(['costs', 'stats'] as const)('folhas fechadas não montam e desmontam ao fechar em %s', async (screen) => {
  await act(async () => root.render(React.createElement(screen === 'costs' ? CostsScreen : StatsScreen)));
  const sheets = () => node.querySelectorAll('[data-sheet-mounted]');
  expect(sheets()).toHaveLength(0);
  await click(m.custos_servidores_relatorio());
  expect(sheets()).toHaveLength(1);
  expect(node.querySelector('aside')?.textContent).toContain('Machine A');
  await click(m.native_close());
  expect(sheets()).toHaveLength(0);
  await click(screen === 'costs' ? '2026-10-01' : 'heavy');
  expect(sheets()).toHaveLength(1);
  expect(node.querySelector('aside')?.textContent).toContain(screen === 'costs' ? '360' : '2026-10-02');
  await click(m.native_close());
  expect(sheets()).toHaveLength(0);
});

it('custos públicos têm cartões honestos, painéis tocáveis, comparação, áreas e navegação inteira', async () => {
  await act(async () => root.render(React.createElement(CostsScreen)));
  expect(node.textContent).toContain(m.custos_custo_periodo());
  expect(node.textContent).toContain(m.custos_sem_tarifa());
  expect(net.costs).toHaveBeenCalledWith(a, '30d', false, false);
  await click(m.custos_gasto_por_dia());
  await click('2026-10-01');
  expect(node.textContent).toContain('360');
  await click(m.custos_por_modelo());
  expect(node.textContent).toContain('missing');
  await click(m.custos_por_projeto());
  await click(m.custos_tirar_da_lista({ nome: '/project-one' }));
  expect(node.textContent).toContain(m.custos_fora_da_lista({ n: 1, valor: '—' }));
  await click(m.lista_comparar());
  expect(node.textContent).toContain(m.custos_comparar_hint({ n: 4 }));
  await click(m.custos_sessoes_caras());
  expect(node.textContent).toContain(m.custos_sessoes_hint());
  await click(m.uso_graf_areas());
  expect(node.textContent).toContain('front');
  expect(net.usage).toHaveBeenCalledWith(a, '30d', { projeto: [], modelo: [] }, false);
  await click(m.custos_como_calculamos());
  expect(node.textContent).toContain(m.custos_metodo_standard());
  await click(m.uso_painel_titulo());
  expect(net.push).toHaveBeenCalledWith('/stats');
  await click(m.comum_voltar());
  expect(net.back).toHaveBeenCalledTimes(1);
});

it.each([
  ['pt', 'Detalhado por tipo de token. Cada linha é um dia.', 'toque numa linha para o detalhe do dia', 'Detalhado por conta / provedor. Cada linha é um dia.'],
  ['en', 'Detailed by token type. Each row is a day.', "tap a row for the day's detail", 'Detailed by account / provider. Each row is a day.'],
] as const)('instruções diárias descrevem linhas e sublinhas sem empilhamento em %s', async (locale, description, hint, providerDescription) => {
  configureLocale({ getLocale: () => locale });
  overwriteGetLocale(() => locale);
  await act(async () => root.render(React.createElement(CostsScreen)));
  expect(node.textContent).toContain(description);
  expect(node.textContent).toContain(hint);
  expect(node.textContent).not.toContain(m.custos_empilhado_por({ modo: m.custos_tipo_token() }));
  expect(node.textContent).not.toContain(m.custos_hover_detalhe());
  const day = [...node.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.startsWith('2026-10-01: '));
  expect(day?.parentElement?.textContent).toContain(m.custos_input_sem_cache());
  expect(day?.parentElement?.textContent).toContain(m.custos_output_total());
  const provider = [...node.querySelectorAll('button')].filter((button) => button.getAttribute('aria-label') === m.custos_dim_provedor()).at(-1);
  expect(provider).toBeTruthy();
  await act(async () => provider!.click());
  expect(node.textContent).toContain(providerDescription);
});

it('estatísticas conservam filtros, detalhe usa foco sem refazer tabela e abas não ficam escondidas montadas', async () => {
  await act(async () => root.render(React.createElement(StatsScreen)));
  expect(node.textContent).toContain(m.uso_resp_skill_contexto());
  expect(node.textContent).toContain('≈ 1.600');
  await click(m.uso_conta());
  await click(`${m.uso_conta()}: account`);
  await click(m.native_close());
  expect(net.usage).toHaveBeenLastCalledWith(b, '30d', { conta: ['account'] }, false);
  const before = net.usage.mock.calls.filter((call) => !call[2].foco).length;
  await click('heavy');
  expect(net.usage).toHaveBeenLastCalledWith(b, '30d', { conta: ['account'], foco: 'plugin:heavy' }, false);
  expect(net.usage.mock.calls.filter((call) => !call[2].foco)).toHaveLength(before);
  expect(node.textContent).toContain('2026-10-02');
  await click(m.uso_aba_agentes());
  expect(node.textContent).toContain('480');
  expect(node.textContent).not.toContain(m.uso_sec_por_plugin());
  await click(m.uso_ir_custos());
  expect(net.back).toHaveBeenCalledTimes(1);
});

it('imagens exibem rótulos humanos na lista e no detalhe mantendo o foco técnico na API', async () => {
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters),
    by_imagem: [{ ...skill, key: 'lida:Read' }, { ...skill, key: 'enviada' }, { ...skill, key: 'lida:mcp:captura' }],
    by_tool: [{ ...skill, key: 'Read', label: 'ferramenta preservada' }],
    by_plugin: [{ ...skill, key: '@repo', label: 'plugin preservado' }],
  }));
  await act(async () => root.render(React.createElement(StatsScreen)));
  await click(m.uso_aba_imagens());
  expect(node.textContent).toContain('lidas por Read');
  expect(node.textContent).toContain('enviadas por você');
  expect(node.textContent).toContain('lidas por mcp:captura');
  expect(node.innerHTML).not.toContain('lida:');
  const before = net.usage.mock.calls.filter((call) => !call[2].foco).length;
  await click('lidas por Read');
  expect(net.usage).toHaveBeenCalledWith(a, '30d', { foco: 'lida:Read' }, false);
  expect(net.usage).toHaveBeenLastCalledWith(b, '30d', { foco: 'lida:Read' }, false);
  expect(net.usage.mock.calls.filter((call) => !call[2].foco)).toHaveLength(before);
  expect(node.querySelector('aside')?.textContent).toContain('foco: lidas por Read');
  expect(node.querySelector('aside')?.textContent).not.toContain('lida:Read');
  await click(m.native_close());
  await click('enviadas por você');
  expect(net.usage).toHaveBeenLastCalledWith(b, '30d', { foco: 'enviada' }, false);
  expect(node.querySelector('aside')?.textContent).toContain('foco: enviadas por você');
  await click(m.native_close());
  for (const [tab, label] of [[m.uso_aba_tools(), 'ferramenta preservada'], [m.uso_aba_plugins(), 'plugin preservado'], [m.uso_aba_agentes(), 'reviewer'], [m.uso_aba_contexto(), 'instructions']] as const) {
    await click(tab);
    expect(node.textContent).toContain(label);
  }
});

it.each(['pt', 'en'] as const)('busca de imagens inclui rótulos exibidos e preserva chaves e metadados em %s', async (locale) => {
  configureLocale({ getLocale: () => locale });
  overwriteGetLocale(() => locale);
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters),
    by_imagem: [{ ...skill, key: 'lida:Read', label: 'read-metadata', plugin: 'read-plugin' }, { ...skill, key: 'enviada', label: 'sent-metadata', plugin: 'sent-plugin' }],
  }));
  await act(async () => root.render(React.createElement(StatsScreen)));
  await click(m.uso_aba_imagens());
  const readLabel = m.uso_img_lida({ tool: 'Read' });
  const sentLabel = m.uso_img_enviada();
  const search = node.querySelector<HTMLInputElement>(`input[aria-label="${m.uso_busca()}"]`);
  expect(search).toBeTruthy();
  for (const [query, expected, hidden] of [
    [readLabel, readLabel, sentLabel], [sentLabel, sentLabel, readLabel],
    ['lida:Read', readLabel, sentLabel], ['enviada', sentLabel, readLabel],
    ['read-metadata', readLabel, sentLabel], ['sent-metadata', sentLabel, readLabel],
    ['read-plugin', readLabel, sentLabel], ['sent-plugin', sentLabel, readLabel],
  ]) {
    await act(async () => { search!.value = query; search!.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(node.querySelectorAll(`button[aria-label^="${expected}: "]`)).toHaveLength(1);
    expect(node.querySelector(`button[aria-label^="${hidden}: "]`)).toBeNull();
  }
});

it('cartões dividem custo por tokens processados e cache de uma hora pela escrita, como no desktop', async () => {
  net.costs.mockImplementation((_server: Server, period: string) => {
    const priced = { ...combo, input: 100_000, output: 100_000, cache_write: 100_000, cache_read: 700_000, cache_write_1h: 50_000, regravado: 10_000, custo_regravado: 0.25, cost: 2, cost_input: 0.4, cost_output: 1, cost_cache_write: 0.5, cost_cache_read: 0.1 };
    return Promise.resolve({ ...costs(period), totals: { ...priced, key: 'totals' }, combos: [priced] });
  });
  await act(async () => root.render(React.createElement(CostsScreen)));
  const card = (label: string) => [...node.querySelectorAll('span')].find((span) => span.textContent === label)?.parentElement;
  expect(card(m.custos_custo_por_milhao())?.textContent?.replace(/\s/g, '')).toContain('US$2,00');
  expect(card(m.custos_cache_1h())?.textContent).toContain('50%');
});

it.each([
  ['pt', 0, 'US$ 0,00', 'R$ 0,00'],
  ['pt', 91.9602, 'US$ 91,96', 'R$ 459,80'],
  ['pt', 1_234_567.8912, 'US$ 1.234.567,89', 'R$ 6.172.839,46'],
  ['en', 0, 'US$ 0.00', 'R$0.00'],
  ['en', 91.9602, 'US$ 91.96', 'R$459.80'],
  ['en', 1_234_567.8912, 'US$ 1,234,567.89', 'R$6,172,839.46'],
] as const)('moedas dos relatórios mantêm duas casas em %s para %s', async (locale, value, usd, brl) => {
  configureLocale({ getLocale: () => locale });
  overwriteGetLocale(() => locale);
  useServers.setState({ servers: [a] });
  net.costs.mockImplementation((_server: Server, period: string) => Promise.resolve({ ...costs(period), usd_brl: 5, combos: [{ ...combo, input: value === 0 ? 0 : 100, output: 0, cache_write: 0, cache_read: 0, cost: value, cost_input: value }] }));
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters), by_agente: [{ ...skill, key: 'reviewer', cost: value }], by_day: [{ ...skill, key: '2026-10-02', cost: value }] }));
  const amount = (label: string, index = 1) => [...node.querySelectorAll('span')].find((span) => span.textContent === label)?.parentElement?.querySelectorAll('span')[index]?.textContent?.replace(/\s/g, ' ');
  await act(async () => root.render(React.createElement(CostsScreen)));
  expect.soft(amount(m.custos_custo_periodo())).toBe(usd);
  await click('BRL');
  expect.soft(amount(m.custos_custo_periodo())).toBe(brl);
  await act(async () => root.render(React.createElement(StatsScreen)));
  expect.soft(amount(m.uso_resp_agente_caro(), 2)).toBe(usd);
  await click(m.uso_aba_agentes());
  await click('reviewer');
  expect(node.querySelector('aside')?.textContent?.replace(/\s/g, ' ')).toContain(`${m.uso_col_custo_real()}: ${usd}`);
});

it('cache perdido medido sem tarifa mostra traço em vez de custo zero', async () => {
  net.costs.mockImplementation((_server: Server, period: string) => Promise.resolve({ ...costs(period), cache_detalhado: true, combos: [{ ...combo, regravado: 50, custo_regravado: 0 }] }));
  await act(async () => root.render(React.createElement(CostsScreen)));
  const card = [...node.querySelectorAll('span')].find((span) => span.textContent === m.custos_cache_perdido())?.parentElement;
  expect(card?.textContent).toContain('—');
  expect(card?.textContent).not.toContain('US$');
});

it('resumo distingue plugin mais carregado do mais pesado e agente mostra tokens reais por chamada', async () => {
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters), by_plugin: [{ ...skill, key: 'frequent', plugin: 'frequent', chamadas: 30, ocupados_eq_tokens_est: 10 }, { ...skill, key: 'heavy-plugin', plugin: 'heavy-plugin', chamadas: 1, ocupados_eq_tokens_est: 900 }] }));
  await act(async () => root.render(React.createElement(StatsScreen)));
  const summary = [...node.querySelectorAll('span')].find((span) => span.textContent === m.mobile_usage_most_loaded_plugin())?.parentElement;
  expect(summary?.textContent).toContain('frequent');
  expect(summary?.textContent).toContain('60');
  await click(m.uso_aba_agentes());
  expect(node.textContent).toContain(`${m.uso_col_tok_chamada()}: 60`);
});

it('dia sem movimento entre dois dias abre detalhe com zero explícito', async () => {
  net.costs.mockImplementation((_server: Server, period: string) => Promise.resolve({ ...costs(period), combos: [combo, { ...combo, dia: '2026-10-03' }] }));
  await act(async () => root.render(React.createElement(CostsScreen)));
  await click('2026-10-02');
  const detail = node.querySelector('aside');
  expect(detail?.textContent?.replace(/\s/g, '')).toContain('0·US$0,00');
  expect(detail?.textContent).toContain(m.custos_tipo_cache_lido());
});

it('avançado mostra chamadas diárias e contexto sem enviar data como foco de item', async () => {
  await act(async () => root.render(React.createElement(StatsScreen)));
  await click(m.uso_avancado());
  expect(node.textContent).toContain('2026-10-01');
  expect(node.textContent).toContain(m.uso_ctx_cat_instrucoes());
  expect(node.querySelector('button[aria-label="2026-10-01"]')).toBeNull();
  expect(net.usage.mock.calls.every((call) => !call[2].foco)).toBe(true);
});

it('custos distinguem carregamento, sucesso incremental, parcial, falha total e período vazio', async () => {
  let finishA!: (report: Partial<CostReport>) => void;
  let failB!: (error: Error) => void;
  net.costs.mockImplementation((server: Server) => server.id === 'a' ? new Promise((resolve) => { finishA = resolve; }) : new Promise((_resolve, reject) => { failB = reject; }));
  await act(async () => root.render(React.createElement(CostsScreen)));
  expect(node.textContent).toContain(m.custos_carregando_maquinas({ n: 2 }));
  expect(node.textContent).not.toContain(m.custos_custo_periodo());
  await act(async () => finishA(costs('30d')));
  expect(node.textContent).toContain(m.custos_custo_periodo());
  expect(node.textContent).toContain(m.custos_carregando_maquinas({ n: 1 }));
  await act(async () => failB(new Error('offline')));
  expect(node.textContent).toContain(m.custos_total_parcial());
  expect(node.textContent).toContain('Machine B: offline');
  net.costs.mockRejectedValue(new Error('offline'));
  await click(m.custos_atualizar());
  expect(node.textContent).toContain(m.home_usage_load_failed());
  expect(node.textContent).not.toContain(m.custos_custo_periodo());
  net.costs.mockImplementation((_server: Server, period: string) => Promise.resolve(mergeReports([{ id: a.id, report: { applied: { period } } }], period).report));
  await click(m.custos_atualizar());
  expect(node.textContent).toContain(m.custos_sem_dados_periodo());
  expect(node.textContent).toContain(m.custos_custo_periodo());
});

it('detalhe de uso separa vazio, parcial e erro e opções sobrevivem ao recorte vazio', async () => {
  net.usage.mockImplementation((server: Server, period: string, filters: UsoFiltros) => filters.foco
    ? server.id === 'b' ? Promise.reject(new Error('detail offline')) : Promise.resolve({ ...usage(period, filters), by_day: [] })
    : Promise.resolve(usage(period, filters)));
  await act(async () => root.render(React.createElement(StatsScreen)));
  await click('heavy');
  expect(node.querySelector('aside')?.textContent).toContain(m.uso_detalhe_sem_serie());
  expect(node.querySelector('aside')?.textContent).toContain(m.custos_total_parcial());
  expect(node.querySelector('aside')?.textContent).toContain('Machine B: detail offline');
  net.usage.mockRejectedValue(new Error('detail offline'));
  const refresh = node.querySelector('aside button[aria-label="' + m.custos_atualizar() + '"]') as HTMLButtonElement;
  await act(async () => refresh.click());
  expect(node.querySelector('aside')?.textContent).toContain(m.home_usage_load_failed());
  expect(node.querySelector('aside')?.textContent).not.toContain(m.uso_detalhe_por_dia());
  await click(m.native_close());
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...filters, applied: { period }, totals: zeroUso('totals') }));
  await click(m.uso_conta());
  await click(`${m.uso_conta()}: account`);
  await click(m.native_close());
  await click(m.uso_conta());
  expect(node.querySelector('aside')?.textContent).toContain('account');
});

it('comparação pública ignora provedor selecionado e conserva o projeto; áreas atualizam frescas', async () => {
  net.costs.mockImplementation((_server: Server, period: string) => Promise.resolve({ ...costs(period), combos: [{ ...combo, cost: 3 }, { ...combo, provider: 'provider-two', cost: 7 }, { ...combo, provider: 'provider-two', project: '/other', cost: 99 }] }));
  await act(async () => root.render(React.createElement(CostsScreen)));
  await click(m.custos_dim_provedor()); await click(`${m.custos_dim_provedor()}: provider-one`); await click(m.native_close());
  await click(m.custos_dim_projeto()); await click(`${m.custos_dim_projeto()}: /project-one`); await click(m.native_close());
  await click(m.lista_comparar());
  await click(m.custos_entidades_comparadas());
  await click(`${m.custos_entidades_comparadas()}: provider-one`);
  await click(`${m.custos_entidades_comparadas()}: provider-two`);
  await click(m.native_close());
  const entity = [...node.querySelectorAll('span')].find((span) => span.textContent === 'provider-two' && span.style.fontWeight === '600')?.parentElement;
  expect(entity?.textContent?.replace(/\s/g, '')).toContain('US$14,00');
  await click(m.uso_graf_areas());
  await click(m.custos_atualizar());
  expect(net.usage).toHaveBeenLastCalledWith(b, '30d', { projeto: ['/project-one'], modelo: [] }, true);
});

it('atualização preserva filtros cruzados enquanto outra máquina ainda entrega os detalhes', async () => {
  await act(async () => root.render(React.createElement(CostsScreen)));
  await click(m.custos_dim_provedor()); await click(`${m.custos_dim_provedor()}: provider-one`); await click(m.native_close());
  await click(m.custos_dim_projeto()); await click(`${m.custos_dim_projeto()}: /project-one`); await click(m.native_close());
  let finish!: (report: Partial<CostReport>) => void;
  net.costs.mockImplementation((server: Server, period: string) => server.id === 'a' ? Promise.resolve({ applied: { period }, totals: { ...combo, key: 'totals', sessions: 0, input: 0, output: 0, cache_write: 0, cache_read: 0 }, combos: [] }) : new Promise((resolve) => { finish = resolve; }));
  await click(m.custos_atualizar());
  expect(node.textContent).toContain('/project-one');
  await act(async () => finish(costs('30d')));
  expect(node.textContent).toContain('/project-one');
});

it('plugin abre série pelo filtro de plugin sem transformar nome do grupo em foco de item', async () => {
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters), by_plugin: [{ ...skill, key: 'usage-plugin', plugin: 'usage-plugin' }] }));
  await act(async () => root.render(React.createElement(StatsScreen)));
  await click(m.uso_aba_plugins());
  await click('usage-plugin');
  expect(net.usage).toHaveBeenLastCalledWith(b, '30d', { plugin: ['usage-plugin'] }, false);
  expect(node.querySelector('aside')?.textContent).toContain('2026-10-01');
});

it('detalhe de plugin conserva chamadas contexto e custo sem inventar tokens reais', async () => {
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters), by_plugin: [{ ...skill, key: 'detail-plugin' }], by_day: [{ ...skill, key: '2026-10-01', input: 0, output: 0 }] }));
  await act(async () => root.render(React.createElement(StatsScreen)));
  await click(m.uso_aba_plugins()); await click('detail-plugin');
  const detail = node.querySelector('aside');
  expect(detail?.textContent).not.toContain(m.uso_detalhe_tokens());
  expect(detail?.textContent).toContain(`${m.uso_col_chamadas()}: 8`);
  expect(detail?.textContent).toContain(`${m.uso_col_ctx()}: ≈ 40`);
  expect(detail?.textContent?.replace(/\s/g, '')).toContain('US$0,20');
});

it('áreas diárias separam data e área inteira sem trocar tokens ou custo', async () => {
  useServers.setState({ servers: [a] });
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters), by_area: [], by_area_dia: [
    { ...zeroUso('2026-09-17|back: serviços de autorização'), input: 153_583_509, cost: 91.96 },
    { ...zeroUso('2026-09-18|front – área compartilhada'), output: 43, cache_read: 7, cost: 2.5 },
  ] }));
  await act(async () => root.render(React.createElement(CostsScreen)));
  await click(m.uso_graf_areas());
  const dates = [...node.querySelectorAll('span')].filter((span) => ['2026-09-17', '2026-09-18'].includes(span.textContent ?? ''));
  expect(dates.map((span) => span.textContent)).toEqual(['2026-09-17', '2026-09-18']);
  expect(dates[0].parentElement?.textContent?.replace(/\s/g, '')).toBe('2026-09-17back:serviçosdeautorização:153.583.509·US$91,96');
  expect(dates[1].parentElement?.textContent?.replace(/\s/g, '')).toBe('2026-09-18front–áreacompartilhada:50·US$2,50');
  expect(node.textContent).not.toContain('|');
});

it('áreas sem tarifa mantêm traço e barras interativas anunciam valores além do nome', async () => {
  net.usage.mockImplementation((_server: Server, period: string, filters: UsoFiltros) => Promise.resolve({ ...usage(period, filters), by_area: [{ ...skill, key: 'front', cost: 0 }], by_area_dia: [{ ...skill, key: '2026-10-01|front', cost: 0 }] }));
  await act(async () => root.render(React.createElement(CostsScreen)));
  await click(m.custos_por_provedor());
  const bar = [...node.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.startsWith('provider-one'));
  expect(bar?.getAttribute('aria-label')).toContain('360');
  await click(m.uso_graf_areas());
  const area = node.querySelector('[aria-label^="front:"]');
  expect(area?.getAttribute('aria-label')).toContain('—');
  const daily = [...node.querySelectorAll('span')].find((span) => span.textContent === '2026-10-01');
  expect(daily?.parentElement?.textContent).toContain('front: 24 · —');
});

it('áreas respeitam a máquina do filtro sem consultar ou somar a outra máquina', async () => {
  await act(async () => root.render(React.createElement(CostsScreen)));
  await click(m.custos_dim_maquina()); await click(`${m.custos_dim_maquina()}: Machine A`); await click(m.native_close());
  let finish!: (report: ReturnType<typeof usage>) => void;
  net.usage.mockImplementation((server: Server, period: string, filters: UsoFiltros) => server.id === 'a' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ...usage(period, filters), by_area: [{ ...skill, key: 'area-from-b' }] }));
  await click(m.uso_graf_areas());
  expect(net.usage.mock.calls.map((call) => call[0].id)).toEqual(['a']);
  expect(node.textContent).toContain(m.custos_carregando_maquinas({ n: 1 }));
  await act(async () => finish({ ...usage('30d', {}), by_area: [{ ...skill, key: 'area-from-a' }] }));
  expect(node.textContent).toContain('area-from-a');
  expect(node.textContent).not.toContain('area-from-b');
});

it.each([[false, true, true], [true, true, true], [false, true, false], [false, false, true]] as const)('presença ausente preserva dados e usa chamadas na malha; somente antiga: %s, skill: %s, plugin: %s', async (onlyOld, skillMissing, pluginMissing) => {
  useServers.setState({ servers: onlyOld ? [b] : [a, b] });
  net.usage.mockImplementation((server: Server, period: string, filters: UsoFiltros) => {
    const report = usage(period, filters);
    const legacy = { ...skill, key: 'legacy-plugin:legacy', plugin: 'legacy-plugin', chamadas: 12, ctx_tokens_est: 60, ocupados_eq_tokens_est: undefined };
    return Promise.resolve(server.id === 'b' ? { ...report, by_skill: [{ ...legacy, ocupados_eq_tokens_est: skillMissing ? undefined : 800 }], by_plugin: [{ ...legacy, key: 'legacy-plugin', ocupados_eq_tokens_est: pluginMissing ? undefined : 800 }] } : report);
  });
  await act(async () => root.render(React.createElement(StatsScreen)));
  expect(node.textContent).toContain(m.mobile_usage_presence_unavailable({ machines: 'Machine B' }));
  const card = (label: string) => [...node.querySelectorAll('span')].find((span) => span.textContent === label)?.parentElement;
  expect(card(m.uso_resp_skill_contexto())?.textContent).toBe(`${m.uso_resp_skill_contexto()}—`);
  expect(card(m.uso_resp_plugin_skills())?.textContent).toBe(`${m.uso_resp_plugin_skills()}—`);
  expect(card(m.uso_resp_skill_usada())?.textContent).toContain('legacy-plugin:legacy');
  const weightButton = node.querySelector<HTMLButtonElement>(`button[aria-label="${m.uso_ordenar_por({ col: m.uso_col_peso() })}"]`);
  expect(weightButton?.disabled).toBe(true);
  const skillRows = [...node.querySelectorAll('button')].filter((button) => ['legacy:', 'heavy:'].some((prefix) => button.getAttribute('aria-label')?.startsWith(prefix)));
  expect(skillRows[0]?.getAttribute('aria-label')).toBe('legacy: — · 12');
  await click(m.uso_aba_plugins());
  const pluginRows = [...node.querySelectorAll('button')].filter((button) => ['legacy-plugin:', 'plugin:'].some((prefix) => button.getAttribute('aria-label')?.startsWith(prefix)));
  expect(pluginRows[0]?.getAttribute('aria-label')).toBe('legacy-plugin: —');
  expect(pluginRows[0]?.parentElement?.textContent).toContain(`${m.uso_col_chamadas()}: 12`);
  expect(pluginRows[0]?.parentElement?.textContent).toContain('≈ 5');
  await click(m.uso_aba_agentes());
  expect(node.textContent).toContain(`${m.uso_col_tok_chamada()}: 60`);
  expect(node.textContent?.replace(/\s/g, '')).toContain(onlyOld ? 'US$2,00' : 'US$4,00');
});

it('escolha de máquinas e período é compartilhada, sem consultas em tela sem foco', async () => {
  await act(async () => root.render(React.createElement(CostsScreen)));
  await click(m.custos_servidores_relatorio());
  await click(`${m.custos_servidores_relatorio()}: Machine B`);
  await click(m.native_close());
  await click(m.custos_periodo_7d());
  await act(async () => root.render(React.createElement(StatsScreen)));
  expect(net.usage).toHaveBeenLastCalledWith(a, '7d', {}, false);
  net.usage.mockClear(); net.focused = false;
  await act(async () => root.render(React.createElement(StatsScreen)));
  expect(net.usage).not.toHaveBeenCalled();
});
