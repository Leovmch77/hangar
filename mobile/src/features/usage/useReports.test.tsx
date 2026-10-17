// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Aquecendo, mergeReports, mergeUso, zeroUso, type CostReport, type Server, type UsoFiltros, type UsoReport } from '@hangar/core';
import { useReports, type ReportKind } from './useReports';
import * as m from '../../paraglide/messages';

const net = vi.hoisted(() => ({ costs: vi.fn(), usage: vi.fn(), state: null as null | ((state: string) => void) }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), fetchCostsForServer: net.costs, fetchUsoForServer: net.usage }));
vi.mock('react-native', async (original) => ({ ...await original<typeof import('react-native')>(), AppState: { currentState: 'active', addEventListener: (_: string, cb: (state: string) => void) => { net.state = cb; return { remove: () => { net.state = null; } }; } } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const server = (id: string, patch: Partial<Server> = {}): Server => ({ id, label: id, baseUrl: `https://${id}.test`, token: 'token', ...patch });
const a = server('a');
const b = server('b');
const cost = (period = '30d', value = 4): Partial<CostReport> => ({ applied: { period }, totals: { key: 'totals', sessions: 1, input: 100, output: 1, cache_write: 0, cache_read: 0, cost: value, cost_input: value, cost_output: 0, cost_cache_write: 0, cost_cache_read: 0 } });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
let root: Root;
let node: HTMLDivElement;
let latest: ReturnType<typeof useReports>;
let latestCosts: ReturnType<typeof useReports<'costs'>>;
type ProbeProps = { kind?: ReportKind; servers?: Server[]; period?: string; filters?: UsoFiltros; active?: boolean };
function CostProbe({ servers = [a, b], period = '30d', filters = {}, active = true }: ProbeProps) {
  const load = useReports('costs', servers, period, filters, active);
  latest = load;
  latestCosts = load;
  const merged = mergeReports(load.parts, period).report;
  return React.createElement('output', null, load.accepted ? merged.totals.cost : 'no-report', load.parts.map((p) => p.error).filter(Boolean).join('|'));
}
function UsageProbe({ servers = [a, b], period = '30d', filters = {}, active = true }: ProbeProps) {
  const load = useReports('usage', servers, period, filters, active);
  latest = load;
  const merged = mergeUso(load.parts, period).report;
  return React.createElement('output', null, load.accepted ? merged.totals.cost : 'no-report', load.parts.map((p) => p.error).filter(Boolean).join('|'));
}
function Probe({ kind = 'costs', ...props }: ProbeProps) {
  return React.createElement(kind === 'costs' ? CostProbe : UsageProbe, props);
}
const render = async (props: React.ComponentProps<typeof Probe> = {}) => { await act(async () => root.render(React.createElement(Probe, props))); };
beforeEach(() => { vi.useFakeTimers(); net.costs.mockReset(); net.usage.mockReset(); node = document.createElement('div'); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

it('carrega máquinas próprias em paralelo, mostra parcial cedo e atualizar pede relatório completo fresco', async () => {
  const wait = deferred<Partial<CostReport>>();
  net.costs.mockImplementation((s: Server) => s.id === 'a' ? Promise.resolve(cost()) : wait.promise);
  await render({ servers: [a, b, server('guest', { invite: true }), server('off', { disabled: true })] });
  expect(node.textContent).toBe('4');
  expect(latest.loading).toBe(true);
  expect(net.costs.mock.calls).toEqual([[a, '30d', false, false], [b, '30d', false, false]]);
  await act(async () => wait.resolve(cost('30d', 3)));
  expect(node.textContent).toBe('7');
  expect(latest.loading).toBe(false);
  await act(async () => latest.refresh());
  expect(net.costs).toHaveBeenLastCalledWith(b, '30d', true, false);
});

it('aquecimento espera 3s e cancela resposta antiga por período, conexão, foco e segundo plano', async () => {
  const old = deferred<Partial<CostReport>>();
  net.costs.mockRejectedValueOnce(new Aquecendo(1, 20)).mockImplementation(() => old.promise);
  await render({ servers: [a] });
  expect(latest.parts[0]?.warming).toEqual({ read: 1, total: 20 });
  await act(async () => vi.advanceTimersByTimeAsync(2999));
  expect(net.costs).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(net.costs).toHaveBeenCalledTimes(2);
  net.costs.mockResolvedValue(cost('7d', 7));
  await render({ servers: [a], period: '7d' });
  await act(async () => old.resolve(cost('30d', 90)));
  expect(node.textContent).toBe('7');
  const replaced = deferred<Partial<CostReport>>();
  net.costs.mockImplementationOnce(() => replaced.promise);
  await render({ servers: [{ ...a, token: 'new' }], period: '7d' });
  await render({ servers: [{ ...a, token: 'new' }], period: '7d', active: false });
  await act(async () => replaced.resolve(cost('7d', 90)));
  expect(latest.accepted).toBe(false);
  net.costs.mockRejectedValue(new Aquecendo(2, 20));
  await render({ servers: [a] });
  const count = net.costs.mock.calls.length;
  await act(async () => net.state?.('background'));
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(net.costs).toHaveBeenCalledTimes(count);
  await act(async () => net.state?.('active'));
  expect(net.costs).toHaveBeenCalledTimes(count + 1);
});

it('falha total não vira zeros, parcial nomeia causa e período incompatível não soma', async () => {
  net.costs.mockRejectedValue(new Error('offline'));
  await render();
  expect(latest.accepted).toBe(false);
  expect(latest.parts.map((p) => [p.label, p.error])).toEqual([['a', m.native_network_error()], ['b', m.native_network_error()]]);
  net.costs.mockImplementation((s: Server) => s.id === 'a' ? Promise.resolve(cost('7d', 100)) : Promise.resolve(cost()));
  await act(async () => latest.refresh());
  expect(node.textContent).toContain('4');
  expect(latest.parts[0].error).toBe(m.home_usage_period_unsupported());
  expect(mergeReports(latestCosts.parts, '30d').mismatched).toEqual(['a']);
});

it.each(['costs', 'usage'] as const)('erros codificados preservam motivo do servidor em %s', async (kind) => {
  const error = Object.assign(new Error(m.costs_no_disk()), { code: 'costs_no_disk' });
  net.costs.mockRejectedValue(error);
  net.usage.mockRejectedValue(error);
  await render({ kind, servers: [a] });
  expect(latest.accepted).toBe(false);
  expect(latest.parts[0].error).toBe(m.costs_no_disk());
  expect(node.textContent).toBe(`no-report${m.costs_no_disk()}`);
});

it.each(['conta', 'projeto', 'modelo', 'plugin', 'foco'] as const)('uso recusa eco ausente ou divergente de %s sem somar relatório errado', async (key) => {
  const filters: UsoFiltros = key === 'foco' ? { foco: 'wanted:skill' } : { [key]: ['wanted'] };
  const ignored: Partial<UsoReport> = { applied: { period: '30d' }, totals: { ...zeroUso('totals'), cost: 99 }, ...(key === 'foco' ? { foco: 'other:skill' } : {}) };
  net.usage.mockImplementation((server: Server) => Promise.resolve(server.id === 'a' ? ignored : { ...ignored, ...filters, totals: { ...zeroUso('totals'), cost: 4 } }));
  await render({ kind: 'usage', filters });
  expect(latest.parts[0].report).toBeNull();
  expect(latest.parts[0].error).toBe(m.mobile_usage_filters_unsupported());
  expect(latest.accepted).toBe(true);
  expect(mergeUso(latest.parts as { report: Partial<UsoReport> | null }[], '30d').report.totals.cost).toBe(4);
});

it('uso aceita eco como conjunto e ausência de conta quando nenhum filtro foi pedido', async () => {
  const filters = { conta: ['c1', 'c2'], projeto: ['/one', '/two'], modelo: ['m1', 'm2'], plugin: ['p1', 'p2'], foco: 'p1:skill' };
  net.usage.mockResolvedValue({ applied: { period: '30d' }, totals: { ...zeroUso('totals'), cost: 4 }, conta: ['c2', 'c1', 'c1'], projeto: ['/two', '/one'], modelo: ['m2', 'm1'], plugin: ['p2', 'p1'], foco: filters.foco });
  await render({ kind: 'usage', servers: [a], filters });
  expect(latest.parts[0].error).toBeUndefined();
  expect(node.textContent).toBe('4');
  net.usage.mockResolvedValue({ applied: { period: '30d' }, totals: { ...zeroUso('totals'), cost: 5 } });
  await render({ kind: 'usage', servers: [a] });
  expect(latest.parts[0].error).toBeUndefined();
  expect(node.textContent).toBe('5');
});

it('uso envia filtros repetíveis e foco separadamente, ignora filtros anteriores e limita aquecimento', async () => {
  const old = deferred<Partial<UsoReport>>();
  const filters = { conta: ['c1', 'c2'], projeto: ['/one'], modelo: ['m'], plugin: ['p'] };
  const usage = (value = 4, echo: UsoFiltros = filters): Partial<UsoReport> => ({ ...echo, applied: { period: '30d' }, totals: { ...zeroUso('totals'), cost: value } });
  net.usage.mockImplementationOnce(() => old.promise).mockImplementation((_server: Server, _period: string, echo: UsoFiltros) => Promise.resolve(usage(4, echo)));
  await render({ kind: 'usage', servers: [a], filters });
  expect(net.usage).toHaveBeenCalledWith(a, '30d', filters, false);
  await render({ kind: 'usage', servers: [a], filters: { ...filters, foco: 'p:skill' } });
  await act(async () => old.resolve(usage(100)));
  expect(node.textContent).toBe('4');
  expect(net.usage).toHaveBeenLastCalledWith(a, '30d', { ...filters, foco: 'p:skill' }, false);
  net.usage.mockReset().mockRejectedValue(new Aquecendo(0, 20));
  await act(async () => latest.refresh());
  await act(async () => vi.advanceTimersByTimeAsync(3000 * 100));
  expect(net.usage).toHaveBeenCalledTimes(100);
  expect(latest.loading).toBe(false);
  expect(latest.parts[0].error).toBe(m.home_usage_warming_timeout());
});
