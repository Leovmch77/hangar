// @vitest-environment happy-dom
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Alert, AppState } from 'react-native';
import { configureApi, _limparEsfriamentoParaTestes, type AggSession, type OrqGrupo, type OrqPolitica, type Papel, type Server, providerName } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { useSessions } from '../../stores/sessions';
import * as m from '../../paraglide/messages';
import { OrchestrationTeam } from './OrchestrationTeam';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const navigation = vi.hoisted(() => ({ focused: true, prevented: false, prevent: null as null | ((event: { data: { action: unknown } }) => void), dispatch: vi.fn() }));
vi.mock('expo-router', () => ({ useIsFocused: () => navigation.focused }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 64, useNavigation: () => navigation, usePreventRemove: (prevented: boolean, callback: typeof navigation.prevent) => { navigation.prevented = prevented; navigation.prevent = callback; } }));
vi.mock('expo-secure-store', () => ({ setItemAsync: vi.fn().mockResolvedValue(undefined), getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children, open }: { children: ReactNode; open?: boolean }) => open === false ? null : createElement('section', null, children) }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: vi.fn(), ok: vi.fn() } }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Pressable = actual.Pressable as ComponentType<Record<string, unknown>>;
  const ScrollView = actual.ScrollView as ComponentType<Record<string, unknown>>;
  const FlatList = actual.FlatList as ComponentType<Record<string, unknown>>;
  return { ...actual,
    Pressable: ({ accessibilityState, accessibilityValue, ...props }: { accessibilityState?: { disabled?: boolean; selected?: boolean }; accessibilityValue?: { text?: string }; [key: string]: unknown }) => createElement(Pressable, { ...props, 'aria-disabled': accessibilityState?.disabled, 'aria-selected': accessibilityState?.selected, 'aria-valuetext': accessibilityValue?.text }),
    ScrollView: ({ contentContainerStyle: _style, keyboardShouldPersistTaps: _keyboard, ...props }: Record<string, unknown>) => createElement(ScrollView, props),
    FlatList: ({ ListHeaderComponent, contentInsetAdjustmentBehavior, contentContainerStyle, ...props }: Record<string, unknown>) => {
      const style = Object.assign({}, ...[contentContainerStyle].flat().filter(Boolean));
      return createElement('div', { 'data-list-inset': contentInsetAdjustmentBehavior, 'data-list-top': style.paddingTop }, ListHeaderComponent as ReactNode, createElement(FlatList, props));
    },
    TextInput: ({ value, onChangeText, accessibilityLabel, editable }: { value: string; onChangeText?: (value: string) => void; accessibilityLabel?: string; editable?: boolean }) => createElement('input', { value, onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value), 'aria-label': accessibilityLabel, readOnly: editable === false }),
    Switch: ({ value, onValueChange, accessibilityLabel, disabled }: { value: boolean; onValueChange: (value: boolean) => void; accessibilityLabel: string; disabled?: boolean }) => createElement('input', { type: 'checkbox', checked: value, onChange: () => onValueChange(!value), 'aria-label': accessibilityLabel, disabled }) };
});
const server: Server = { id: 'b', label: 'machine-b', baseUrl: 'http://b:8765', token: 'token-b' };
const role = (papel = 'executor', patch: Partial<Papel> = {}): Papel => ({ papel, sessao: 'work-t*', provider: 'claude', conta: 'account-b', modelo: 'opus', esforco: 'high', vez: '', viva: null, headless: null, permissao: '', motor: '', jev: false, subagente: '', perfil: '', janela: '', ...patch });
const group = (papeis = [role()], patch: Partial<OrqGrupo> = {}): OrqGrupo => ({ gid: 'group-b', grouped: false, session_prefix: 'work', session_identity: 'life-b', arquivo: '/work/team.md', mtime: 10, papeis, arbitro: null, prontidao: { phase: 'planner', plan: null, group: false, roles: true }, ...patch });
const policy = (): OrqPolitica => ({ arquivo: '/policy.md', mtime: 3, politica: [], inventario: [
  { provider: 'claude', conta: 'account-b', apelido: 'Account B', id_cota: 'claude:b', reduced: false, modelos: [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }] },
  { provider: 'codex', conta: 'codex-b', apelido: 'Codex B', id_cota: 'codex:b', reduced: false, modelos: [{ id: 'gpt', name: 'GPT', efforts: ['low', 'high'] }] },
  { provider: 'pi', conta: 'pi-b', apelido: 'Pi B', id_cota: null, reduced: false, modelos: [{ id: 'pi-model' }] },
] });
const live = (name: string, patch: Partial<AggSession> = {}): AggSession => ({ name, state: 'idle', provider: 'claude', jsonl: `/logs/${name}.jsonl`, serverId: 'b', serverLabel: 'machine-b', ...patch } as AggSession);
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let container: HTMLDivElement;
let root: Root;
let fetcher: ReturnType<typeof vi.fn>;
let currentGroup: OrqGrupo;
let currentPolicy: OrqPolitica;
let retain: ReturnType<typeof vi.fn<() => () => void>>;
let release: ReturnType<typeof vi.fn<() => void>>;
let appState: (state: string) => void;
let alerts: { title: string; message?: string; buttons: { text?: string; onPress?: () => void }[] }[];
const render = (name = 'origin', serverId = 'b') => act(async () => root.render(createElement(OrchestrationTeam, { serverId, name })));
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
const click = (label: string) => act(async () => { const item = button(label); expect(item, label).toBeTruthy(); item!.click(); });
async function input(label: string, value: string) {
  await act(async () => { const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); expect(element, label).toBeTruthy(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element!.dispatchEvent(new Event('input', { bubbles: true })); element!.dispatchEvent(new Event('change', { bubbles: true })); });
}
const chooseAlert = (label: string) => act(async () => { const item = alerts.at(-1)?.buttons.find(item => item.text === label); expect(item, label).toBeTruthy(); item!.onPress?.(); });
const writes = () => fetcher.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET');
const groupReads = () => fetcher.mock.calls.filter(([url]) => /\/api\/sessions\/[^/]+\/orq$/.test(String(url)));
const readData = (url: string): unknown => url.endsWith('/api/orquestracao/politica') ? currentPolicy : url.endsWith('/api/cotas') ? [] : url.endsWith('/api/engines') ? { motores: {}, arquivo_corrompido: false, arquivo_caminho: '/engines.json' } : currentGroup;
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  navigation.focused = true; navigation.prevent = null; navigation.prevented = false; navigation.dispatch.mockClear();
  _limparEsfriamentoParaTestes();
  useServers.setState({ ready: true, activeId: 'a', servers: [{ ...server, id: 'a', baseUrl: 'http://a:8765' }, server] });
  release = vi.fn<() => void>(); retain = vi.fn<() => () => void>(() => release);
  useSessions.setState({ byServerRecord: { b: [live('origin')] }, retain });
  appState = () => {}; vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { appState = listener as (state: string) => void; return { remove() {} } as never; });
  alerts = []; vi.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => { alerts.push({ title, message, buttons: buttons ?? [] }); });
  currentGroup = group(); currentPolicy = policy();
  configureApi({ getBaseUrl: () => 'http://a:8765', getToken: () => 'token-a', onUnauthorized: vi.fn(), origin: null, createEventSource: vi.fn() });
  fetcher = vi.fn(async (url: string) => reply(url.endsWith('/api/orquestracao/politica') ? currentPolicy : url.endsWith('/api/cotas') ? [] : url.endsWith('/api/engines') ? { motores: {} } : url.endsWith('/api/config') ? {} : currentGroup));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); _limparEsfriamentoParaTestes(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('rascunhos preserva seleção, null e false e salva todas as linhas em lote relendo o time completo', async () => {
  currentGroup = group([role(), role('revisor', { vez: '03', sessao: 'work-review*', modelo: 'legacy-model', janela: '55' })]);
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body));
      currentGroup = group([role('executor', body.papeis[0]), role('revisor', body.papeis[1]), role('untouched')], { mtime: 11 });
      return reply({ papeis: body.papeis, mtime: 11, arbitro: null, aviso: 'proxima_sessao', erro: null });
    }
    return reply(readData(url));
  });
  await render(); await click('executor');
  expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_papel()}"]`)?.readOnly).toBe(true);
  await input(m.orqcfg_sessao(), 'edited-t*');
  await click(m.criar_modo_exec()); await click(m.criar_modo_exec_tmux());
  await click(m.native_close());
  await click(`revisor, ${m.orqcfg_vez_n({ n: '03' })}`);
  expect(container.textContent).toContain('legacy-model'); expect(container.textContent).toContain('55%');
  await input(m.orqcfg_sessao(), 'edited-review*'); await click(m.native_close());
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('edited-t*');
  await click(m.orqcfg_salvar());
  expect(writes()).toHaveLength(1);
  const body = JSON.parse(String(writes()[0][1].body));
  expect(body.mtime).toBe(10); expect(body.papeis).toHaveLength(2);
  expect(body.papeis[0]).toMatchObject({ papel: 'executor', vez: '', sessao: 'edited-t*', headless: false });
  expect(body.papeis[1]).toMatchObject({ papel: 'revisor', vez: '03', sessao: 'edited-review*', headless: null, modelo: 'legacy-model', janela: '55' });
  expect(body.papeis.every((item: object) => !('viva' in item) && !('id_cota' in item))).toBe(true);
  expect(groupReads()).toHaveLength(2); expect(container.textContent).toContain('untouched');
  expect(container.textContent).toContain(m.orqcfg_aviso_proxima_sessao());
});

it('rascunhos troca provider sem vazar campos, mantém Jev e esforços Codex por modelo', async () => {
  currentGroup = group([role('executor', { motor: 'old-engine', subagente: 'old-agent', permissao: 'plan', perfil: 'old-profile', headless: false, jev: true })]);
  await render(); await click('executor'); await click(providerName('codex'));
  expect(container.textContent).not.toContain('old-engine');
  await click(m.native_ctl_effort()); expect(container.textContent).toContain('low'); expect(container.textContent).toContain('high'); expect(container.textContent).not.toContain('xhigh');
  await click('low'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? reply({ mtime: 11, papeis: [], arbitro: null, aviso: 'proxima_sessao', erro: null }) : reply(readData(url)));
  await click(m.orqcfg_salvar());
  expect(JSON.parse(String(writes()[0][1].body)).papeis[0]).toMatchObject({ provider: 'codex', conta: 'codex-b', modelo: 'gpt', esforco: 'low', headless: null, permissao: '', motor: '', subagente: '', perfil: '', jev: true });
});

it('rascunhos grava só campos de abertura permitidos no provider e trim do perfil OMP', async () => {
  currentPolicy.inventario.push({ provider: 'omp', conta: 'omp-b', apelido: 'OMP B', id_cota: null, reduced: false, modelos: [{ id: 'omp-model' }] });
  currentGroup = group([role('executor', { provider: 'omp', conta: 'omp-b', modelo: 'omp-model', headless: true, permissao: 'plan', motor: 'old', subagente: 'old', perfil: '  coding  ' })]);
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'changed'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? reply({ mtime: 11, papeis: currentGroup.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null }) : reply(readData(url)));
  await click(m.orqcfg_salvar()); expect(JSON.parse(String(writes()[0][1].body)).papeis[0]).toMatchObject({ headless: null, permissao: '', motor: '', subagente: '', perfil: 'coding' });
});

it('rascunhos conta travada força primeiro modelo e troca de conta conserva modelo permitido', async () => {
  currentPolicy.inventario.push({ ...currentPolicy.inventario[0], conta: 'second', apelido: 'Second', modelos: [{ id: 'sonnet' }, { id: 'opus' }] });
  currentPolicy.politica = [
    { provider: 'claude', conta: 'account-b', apelido: 'Account B', modelos: ['*'], trocar: true },
    { provider: 'claude', conta: 'second', apelido: 'Second', modelos: ['*'], trocar: false },
  ];
  await render(); await click('executor'); await click(m.orqcfg_conta()); await click('Second');
  expect(button(m.native_ctl_model_title())?.textContent).toContain('sonnet');
  expect(button(m.native_ctl_model_title())?.disabled).toBe(true);
  await click(m.orqcfg_conta()); await click('Account B');
  expect(button(m.native_ctl_model_title())?.textContent).toContain('Sonnet');
  await click(m.native_close());
});

it('modelo padrão pode ser escolhido e permanece vazio ao trocar conta liberada', async () => {
  currentPolicy.inventario.push({ ...currentPolicy.inventario[0], conta: 'second', apelido: 'Second', modelos: [{ id: 'sonnet', context_length: '200k' }] });
  currentPolicy.politica = [
    { provider: 'claude', conta: 'account-b', apelido: 'Account B', modelos: ['*'], trocar: true },
    { provider: 'claude', conta: 'second', apelido: 'Second', modelos: ['*'], trocar: true },
  ];
  await render(); await click('executor'); await click(m.native_ctl_model_title());
  expect(button(m.config_motores_padrao())).toBeTruthy();
  await click(m.config_motores_padrao()); await click(m.orqcfg_conta()); await click('Second');
  expect(button(m.native_ctl_model_title())?.getAttribute('aria-valuetext')).toBe(m.config_motores_padrao());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); currentGroup = group(body.papeis, { mtime: 11 });
      return reply({ mtime: 11, papeis: body.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null });
    }
    return reply(readData(url));
  });
  await click(m.orqcfg_salvar()); expect(JSON.parse(String(writes()[0][1].body)).papeis[0]).toMatchObject({ conta: 'second', modelo: '' });
});

it('rascunhos adiciona papel distinto sem conta de rodízio e deriva sessão do prefixo real', async () => {
  currentGroup = group([role('**ÉXECUTOR**', { vez: '1' })], { session_prefix: 'selected-work-' });
  await render(); await click(m.orqcfg_novo_papel());
  await input(m.orqcfg_papel(), '  `executor`  '); await click(m.orqcfg_salvar());
  expect(writes()).toHaveLength(0); expect(container.textContent).toContain(m.orqcfg_role_exists());
  await input(m.orqcfg_papel(), 'executor faixa B');
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? reply({ mtime: 11, papeis: [], arbitro: null, aviso: 'proxima_sessao', erro: null }) : reply(readData(url)));
  await click(m.orqcfg_salvar());
  expect(JSON.parse(String(writes()[0][1].body)).papeis[0]).toMatchObject({ papel: 'executor faixa B', vez: '', sessao: 'selected-work-t*' });
  expect(container.textContent).not.toContain(m.orqcfg_fila_adicionar());
});

it('rascunhos OMP sem inventário não vira Pi e conta faltante recusa lote inteiro', async () => {
  currentGroup = group([role(), role('revisor')]);
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'changed'); await click(m.native_close());
  await click('revisor'); await click(providerName('omp'));
  expect(container.textContent).toContain(m.orqcfg_nenhuma_conta());
  await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(0);
  expect(container.textContent).toContain('revisor'); expect(container.textContent).toContain(m.erro_orq_conta_desconhecida());
});

it('gravação bloqueia duplo toque e distingue ACK salvo de releitura falha sem repetir o lote', async () => {
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'edited'); await click(m.native_close());
  const pending = deferred<Response>();
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method === 'POST') return pending.promise; if (url.endsWith('/orq')) throw new Error('reload-failed'); return reply(readData(url)); });
  await act(async () => { button(m.orqcfg_salvar())!.click(); button(m.orqcfg_salvar())?.click(); });
  expect(writes()).toHaveLength(1);
  await act(async () => pending.resolve(reply({ mtime: 11, papeis: [role('executor', { sessao: 'edited' })], arbitro: null, aviso: 'proxima_sessao', erro: null })));
  expect(container.textContent).toContain(m.orqcfg_saved_reload_failed());
  expect(container.textContent).toContain('reload-failed');
  await click('executor'); expect(container.querySelector<HTMLButtonElement>(`section button[aria-label="${m.orqcfg_salvar()}"]`)?.disabled).toBe(true); expect(container.querySelector<HTMLButtonElement>(`section button[aria-label="${m.comum_apagar()}"]`)?.disabled).toBe(true);
  await input(m.orqcfg_sessao(), 'second'); await click(m.native_close()); await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(1);
  currentGroup = group([role('executor', { sessao: 'edited' })], { mtime: 11 });
  fetcher.mockImplementation(async (url: string) => reply(readData(url)));
  await click(m.orqcfg_recarregar());
  expect(button(m.orqcfg_salvar())?.disabled).toBe(true);
  await click('executor'); await input(m.orqcfg_sessao(), 'second'); await click(m.native_close());
  await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(2); expect(JSON.parse(String(writes()[1][1].body)).mtime).toBe(11);
});

it('gravação base bloqueada após ACK não aceita edição nem adicionar até releitura confirmada', async () => {
  await render(); await click('executor'); await click(m.native_ctl_model_title()); await click('Sonnet'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      currentGroup = group([role('executor', { modelo: 'sonnet' })], { mtime: 11 });
      return reply({ mtime: 11, papeis: currentGroup.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null });
    }
    if (url.endsWith('/orq')) throw new Error('reload-failed');
    return reply(readData(url));
  });
  await click(m.orqcfg_salvar()); expect(container.textContent).toContain(m.orqcfg_saved_reload_failed());
  expect(button(m.orqcfg_novo_papel())?.disabled).toBe(true);
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.readOnly).toBe(true);
  await input(m.orqcfg_sessao(), 'ignored'); await click(m.native_close()); expect(navigation.prevented).toBe(false); expect(writes()).toHaveLength(1);
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? reply({ mtime: 12, papeis: [], arbitro: null, aviso: 'proxima_sessao', erro: null }) : reply(readData(url)));
  await click(m.orqcfg_recarregar()); await click('executor');
  expect(button(m.native_ctl_model_title())?.getAttribute('aria-valuetext')).toBe('Sonnet');
  await input(m.orqcfg_sessao(), 'confirmed'); await click(m.orqcfg_salvar());
  expect(writes()).toHaveLength(2); expect(JSON.parse(String(writes()[1][1].body)).papeis[0]).toMatchObject({ modelo: 'sonnet', sessao: 'confirmed' });
});

it('gravação conflito e transporte incerto exigem releitura preservando os rascunhos', async () => {
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'draft'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? reply({ detail: 'arquivo_mudou' }, 409) : reply(readData(url)));
  await click(m.orqcfg_salvar()); expect(container.textContent).toContain(m.orqcfg_write_uncertain());
  await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(1);
  await click(m.orqcfg_recarregar()); await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('draft'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method === 'POST') throw new TypeError('network-lost'); return reply(readData(url)); });
  await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(2); expect(container.textContent).toContain('network-lost');
  await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(2);
});

it('remoção confirma linha exata sem renumerar e relê preservando rascunho de outro papel', async () => {
  currentGroup = group([role('executor', { vez: '1' }), role('executor', { vez: '03', conta: 'second' }), role('revisor')]);
  await render(); await click('revisor'); await input(m.orqcfg_sessao(), 'keep-review'); await click(m.native_close());
  await click(`executor, ${m.orqcfg_vez_n({ n: '03' })}`); await click(m.comum_apagar()); expect(writes()).toHaveLength(0);
  expect(alerts.at(-1)?.message).toContain('executor');
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') { currentGroup = group([role('executor', { vez: '1' }), role('revisor', { viva: 'real-review', id_cota: 'quota-live' })], { mtime: 12 }); return reply({ papeis: [role('executor', { vez: '1' })], mtime: 12 }); }
    return reply(readData(url));
  });
  await chooseAlert(m.comum_apagar()); expect(writes()).toHaveLength(1);
  expect(JSON.parse(String(writes()[0][1].body))).toEqual({ papel: 'executor', vez: '03', mtime: 10 });
  expect(button(`executor, ${m.orqcfg_vez_n({ n: '1' })}`)).toBeTruthy();
  await click('revisor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('keep-review');
  await click(m.native_close()); await click(m.orqcfg_salvar());
  expect(JSON.parse(String(writes()[1][1].body)).mtime).toBe(12);
});

it('começar não exige plano e trata entrega na fila como sucesso sem duplicar envio', async () => {
  await render(); const pending = deferred<Response>();
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? pending.promise : reply(readData(url)));
  await act(async () => { button(m.orqcfg_comecar())?.click(); button(m.orqcfg_comecar())?.click(); });
  expect(writes()).toHaveLength(1); expect(String(writes()[0][0])).toBe('http://b:8765/api/sessions/origin/orq/comecar');
  await act(async () => pending.resolve(reply({ ok: true, entregue: false, fase: 'planner', plano: '' })));
  expect(container.textContent).toContain(m.orqcfg_comecou_fila());
});

it('começar com rascunhos cancela ou salva e relê antes de enviar; ACK sem releitura não começa', async () => {
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'changed'); await click(m.native_close());
  await click(m.orqcfg_comecar()); expect(writes()).toHaveLength(0); await chooseAlert(m.comum_cancelar());
  await click(m.orqcfg_comecar());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return reply({ mtime: 11, papeis: [role()], arbitro: null, aviso: 'proxima_sessao', erro: null });
    if (url.endsWith('/orq')) throw new Error('reload-failed'); return reply(readData(url));
  });
  await chooseAlert(m.orqcfg_salvar_continuar());
  expect(writes().map(([url]) => String(url))).toEqual(['http://b:8765/api/sessions/origin/orq/papeis']);
  expect(container.textContent).toContain(m.orqcfg_saved_reload_failed());
});

it('saída nativa salva e continua com a ação original ou descarta todos, cancelando sem perder draft', async () => {
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'changed'); await click(m.native_close());
  expect(navigation.prevented).toBe(true); const action = { type: 'GO_BACK', source: 'route-key' };
  await act(async () => navigation.prevent?.({ data: { action } })); await chooseAlert(m.comum_cancelar()); expect(navigation.dispatch).not.toHaveBeenCalled();
  await act(async () => navigation.prevent?.({ data: { action } }));
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { currentGroup = group([role('executor', { sessao: 'changed' })], { mtime: 11 }); return reply({ mtime: 11, papeis: currentGroup.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null }); }
    return reply(readData(url));
  });
  await chooseAlert(m.orqcfg_salvar_continuar()); expect(navigation.dispatch).toHaveBeenCalledWith(action);
  await click('executor'); await input(m.orqcfg_sessao(), 'another'); await click(m.native_close());
  await act(async () => navigation.prevent?.({ data: { action } })); await chooseAlert(m.orqcfg_descartar()); expect(navigation.prevented).toBe(false); expect(navigation.dispatch).toHaveBeenCalledTimes(2);
});

it('catálogos mostra cota real, comparação viva e motor salvo fora da lista sem alterar ao abrir', async () => {
  currentGroup = group([role('executor', { motor: 'legacy-engine', id_cota: 'claude:b' })]);
  useSessions.setState({ byServerRecord: { b: [live('origin'), live('work-t1', { status_line: '🤖 Sonnet4.8 (low) │ 📁 x [main]', conta: 'claude:/home/.claude-account-b' })] } });
  fetcher.mockImplementation(async (url: string) => reply(url.endsWith('/orq') ? currentGroup : url.endsWith('/api/orquestracao/politica') ? currentPolicy : url.endsWith('/api/cotas') ? [{ id: 'claude:b', estado: 'lida', janelas: [{ rotulo: '5h', pct: 42 }] }] : { motores: { engine: { label: 'Available engine', model: 'gpt' } }, arquivo_corrompido: false }));
  await render(); expect(container.textContent).toContain('5h 42%');
  await click('executor'); expect(container.textContent).toContain('work-t1'); expect(container.textContent).toContain(m.orqcfg_agora_diverge({ modelo: 'opus', esforco: 'high' }));
  await click(m.comum_motor()); expect(container.textContent).toContain('Available engine'); expect(container.textContent).toContain('legacy-engine');
  await click(m.sessao_fechar()); await click(m.native_close()); expect(writes()).toHaveLength(0);
  await click('executor'); await click(m.comum_motor()); await click('Available engine'); expect(button(m.criar_subagente())).toBeUndefined();
});

it('catálogos falha de cota fica visível no detalhe sem bloquear política e não inventa zero', async () => {
  fetcher.mockImplementation(async (url: string) => { if (url.endsWith('/api/cotas')) return reply({ detail: 'quota-failed' }, 503); return reply(url.endsWith('/orq') ? currentGroup : url.endsWith('/api/orquestracao/politica') ? currentPolicy : { motores: {} }); });
  await render(); expect(container.textContent).toContain('quota-failed'); expect(container.textContent).toContain(m.orqcfg_cota_sem()); expect(container.textContent).not.toContain('0%');
  await click('executor'); expect(container.querySelector('section')?.textContent).toContain('quota-failed');
  await input(m.orqcfg_sessao(), 'edited'); await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(1);
});

it('ciclo identidade diferente pede cancelar ou descartar antes de adotar nova base', async () => {
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'old-draft'); await click(m.native_close());
  currentGroup = group([role('new-role')], { session_identity: 'new-life', mtime: 15 });
  await click(m.orqcfg_recarregar());
  expect(alerts.at(-1)?.message).toBe(m.orqcfg_target_changed()); expect(navigation.prevented).toBe(true);
  await chooseAlert(m.comum_cancelar()); await click('executor');
  expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('old-draft');
  expect(button(m.orqcfg_salvar())?.disabled).toBe(true); await click(m.native_close());
  await click(m.orqcfg_salvar()); await click(m.orqcfg_comecar()); expect(writes()).toHaveLength(0);
  await click(m.orqcfg_recarregar()); await chooseAlert(m.orqcfg_descartar());
  expect(button('executor')).toBeUndefined(); expect(navigation.prevented).toBe(false);
  await click('new-role'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('work-t*');
});

it('ciclo offline e clear com mesma identidade conservam drafts e permitem saída descartando offline', async () => {
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'keep-draft'); await click(m.native_close());
  const before = fetcher.mock.calls.length;
  await act(async () => useSessions.setState({ byServerRecord: { b: [] } }));
  expect(container.textContent).toContain(m.erro_sessao_orq()); expect(button('executor')).toBeTruthy(); expect(navigation.prevented).toBe(true);
  await click(m.orqcfg_recarregar()); await click(m.orqcfg_salvar()); expect(fetcher).toHaveBeenCalledTimes(before);
  await act(async () => useSessions.setState({ byServerRecord: { b: [live('origin')] } }));
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('keep-draft'); await click(m.native_close());
  currentGroup = group([role()], { mtime: 12 });
  const reads = groupReads().length;
  await act(async () => useSessions.setState({ byServerRecord: { b: [live('origin', { jsonl: '/logs/after-clear.jsonl' })] } }));
  expect(groupReads()).toHaveLength(reads + 1); expect(alerts).toHaveLength(0);
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('keep-draft'); await click(m.native_close());
  await act(async () => useServers.setState({ servers: [{ ...server, token: 'rotated-token' }] }));
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('keep-draft'); await click(m.native_close());
  const beforeInvite = fetcher.mock.calls.length;
  await act(async () => useServers.setState({ servers: [{ ...server, invite: true }] }));
  expect(container.textContent).toContain(m.lista_acesso_recusado()); await click(m.orqcfg_salvar()); await click(m.orqcfg_recarregar()); expect(fetcher).toHaveBeenCalledTimes(beforeInvite);
  await act(async () => useServers.setState({ servers: [] }));
  expect(container.textContent).toContain(m.chat_servidor_removido()); expect(button('executor')).toBeTruthy();
  const action = { type: 'GO_BACK', source: 'offline-route' };
  await act(async () => navigation.prevent?.({ data: { action } })); await chooseAlert(m.orqcfg_descartar());
  expect(navigation.dispatch).toHaveBeenCalledWith(action); expect(writes()).toHaveLength(0);
});

it('ciclo sucessão conserva draft antigo bloqueado até consentimento para identidade nova', async () => {
  useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'old' }), live('old')] } });
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'old-draft'); await click(m.native_close());
  currentGroup = group([role('new-role')], { session_identity: 'new-life', mtime: 18 });
  await act(async () => useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'new' }), live('new')] } }));
  expect(alerts.at(-1)?.message).toBe(m.orqcfg_target_changed()); await chooseAlert(m.comum_cancelar());
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('old-draft'); await click(m.native_close());
  await click(m.orqcfg_salvar()); await click(m.orqcfg_comecar()); expect(writes()).toHaveLength(0);
  await click(m.orqcfg_recarregar()); await chooseAlert(m.orqcfg_descartar()); expect(button('new-role')).toBeTruthy(); expect(navigation.prevented).toBe(false);
  expect(groupReads().at(-1)?.[0]).toBe('http://b:8765/api/sessions/new/orq');
});

it('ciclo refresh que perderia papel editado pede confirmação e preserva os demais drafts', async () => {
  currentGroup = group([role(), role('revisor')]);
  await render(); await click('executor'); await input(m.orqcfg_sessao(), 'old-executor'); await click(m.native_close());
  await click('revisor'); await input(m.orqcfg_sessao(), 'keep-review'); await click(m.native_close());
  currentGroup = group([role('revisor')], { mtime: 14 });
  await click(m.orqcfg_recarregar()); expect(alerts.at(-1)?.title).toBe(m.orqcfg_unsaved_title());
  await chooseAlert(m.comum_cancelar()); await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('old-executor'); await click(m.native_close());
  await click(m.orqcfg_recarregar()); await chooseAlert(m.orqcfg_descartar()); expect(button('executor')).toBeUndefined();
  await click('revisor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('keep-review'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? reply({ mtime: 15, papeis: [role('revisor', { sessao: 'keep-review' })], arbitro: null, aviso: 'proxima_sessao', erro: null }) : reply(url.endsWith('/orq') ? currentGroup : url.endsWith('/api/orquestracao/politica') ? currentPolicy : url.endsWith('/api/cotas') ? [] : { motores: {} }));
  await click(m.orqcfg_salvar()); const payload = JSON.parse(String(writes()[0][1].body)); expect(payload.mtime).toBe(14); expect(payload.papeis.map((item: Papel) => item.papel)).toEqual(['revisor']);
});

it('leitura pura abandonada por foco não segura leitura nova nem libera escrita posterior', async () => {
  const stale = deferred<Response>();
  fetcher.mockImplementation(async (url: string) => url.endsWith('/orq') ? stale.promise : reply(readData(url)));
  await render(); await act(async () => appState('background'));
  currentGroup = group([role('fresh-role')], { mtime: 14 });
  fetcher.mockImplementation(async (url: string) => reply(readData(url)));
  await act(async () => appState('active'));
  expect(groupReads()).toHaveLength(2); expect(button('fresh-role')).toBeTruthy();
  await click('fresh-role'); await input(m.orqcfg_sessao(), 'changed'); await click(m.native_close());
  const writing = deferred<Response>();
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? writing.promise : reply(readData(url)));
  await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(1);
  await act(async () => stale.resolve(reply(group([role('stale-role')]))));
  expect(button('stale-role')).toBeUndefined(); expect(button(m.orqcfg_salvando())?.disabled).toBe(true);
  await click(m.orqcfg_salvando()); expect(writes()).toHaveLength(1);
  await act(async () => writing.resolve(reply({ mtime: 15, papeis: [], arbitro: null, aviso: 'proxima_sessao', erro: null })));
  expect(button('fresh-role')).toBeTruthy();
});

it('prazo leitura 20s libera retry e ignora resposta antiga sem erro falso ao perder foco', async () => {
  vi.useFakeTimers(); const stale = deferred<Response>();
  fetcher.mockImplementation(async (url: string) => url.endsWith('/orq') ? stale.promise : reply(readData(url)));
  await render(); await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(container.textContent).toContain(m.orqcfg_read_timeout()); expect(button(m.orqcfg_recarregar())?.disabled).toBe(false);
  currentGroup = group([role('fresh-role')], { mtime: 14 }); fetcher.mockImplementation(async (url: string) => reply(readData(url)));
  await click(m.orqcfg_recarregar()); expect(button('fresh-role')).toBeTruthy();
  await act(async () => stale.resolve(reply(group([role('stale-role')])))); expect(button('stale-role')).toBeUndefined();
  const abandoned = deferred<Response>(); fetcher.mockImplementation(async (url: string) => url.endsWith('/orq') ? abandoned.promise : reply(readData(url)));
  await click(m.orqcfg_recarregar()); await act(async () => appState('background')); await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(container.textContent).not.toContain(m.orqcfg_read_timeout());
  await act(async () => abandoned.resolve(reply(currentGroup)));
});

it('prazo escrita 30s libera saída mas exige settle e GET posterior para voltar a editar', async () => {
  vi.useFakeTimers(); await render(); await click('executor'); await click(m.native_ctl_model_title()); await click('Sonnet'); await click(m.native_close());
  const pending = deferred<Response>();
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? pending.promise : reply(readData(url)));
  await click(m.orqcfg_salvar()); await act(async () => appState('background')); await act(async () => appState('active'));
  await act(async () => vi.advanceTimersByTimeAsync(29_999)); expect(button(m.orqcfg_salvando())?.disabled).toBe(true); expect(writes()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(container.textContent).toContain(m.orqcfg_write_pending());
  const action = { type: 'GO_BACK', source: 'pending-write' };
  await act(async () => navigation.prevent?.({ data: { action } })); expect(alerts.at(-1)?.title).toBe(m.orqcfg_unsaved_title()); await chooseAlert(m.comum_cancelar());
  await click(m.orqcfg_recarregar()); expect(button(m.orqcfg_novo_papel())?.disabled).toBe(true);
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.readOnly).toBe(true); await click(m.native_close());
  await click(m.orqcfg_salvar()); await click(m.orqcfg_comecar()); expect(writes()).toHaveLength(1);
  const racingRead = deferred<Response>(); const oldBase = currentGroup;
  fetcher.mockImplementation(async (url: string) => url.endsWith('/orq') ? racingRead.promise : reply(readData(url)));
  await click(m.orqcfg_recarregar()); const beforeSettle = groupReads().length;
  currentGroup = group([role('executor', { modelo: 'sonnet' })], { mtime: 11 });
  await act(async () => pending.resolve(reply({ mtime: 11, papeis: currentGroup.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null })));
  expect(groupReads()).toHaveLength(beforeSettle); expect(button(m.orqcfg_novo_papel())?.disabled).toBe(true); expect(navigation.prevented).toBe(true);
  await act(async () => racingRead.resolve(reply(oldBase))); expect(button(m.orqcfg_novo_papel())?.disabled).toBe(true);
  fetcher.mockImplementation(async (url: string) => reply(readData(url)));
  await click(m.orqcfg_recarregar()); expect(button(m.orqcfg_novo_papel())?.disabled).toBe(false); expect(navigation.prevented).toBe(false); expect(writes()).toHaveLength(1);
  expect(container.textContent).not.toContain(m.orqcfg_write_pending());
  await click('executor'); expect(button(m.native_ctl_model_title())?.getAttribute('aria-valuetext')).toBe('Sonnet');
  await input(m.orqcfg_sessao(), 'confirmed'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { const body = JSON.parse(String(options.body)); currentGroup = group(body.papeis, { mtime: 12 }); return reply({ mtime: 12, papeis: body.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null }); }
    return reply(readData(url));
  });
  const readsBeforeSave = groupReads().length;
  await click(m.orqcfg_salvar()); expect(writes()).toHaveLength(2); expect(JSON.parse(String(writes()[1][1].body)).papeis[0]).toMatchObject({ modelo: 'sonnet', sessao: 'confirmed' });
  expect(groupReads()).toHaveLength(readsBeforeSave + 1); expect(vi.getTimerCount()).toBe(0);
});

it('prazo remontagem conserva escrita em voo e só GET posterior ao término libera novas mudanças', async () => {
  vi.useFakeTimers(); await render(); await click('executor'); await input(m.orqcfg_sessao(), 'first-write'); await click(m.native_close());
  const pending = deferred<Response>();
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'POST' ? pending.promise : reply(readData(url)));
  await click(m.orqcfg_salvar()); await act(async () => vi.advanceTimersByTimeAsync(30_000));
  const action = { type: 'GO_BACK', source: 'expired-write' };
  await act(async () => navigation.prevent?.({ data: { action } })); await chooseAlert(m.orqcfg_descartar());
  expect(navigation.dispatch).toHaveBeenCalledWith(action);
  await act(async () => root.unmount()); root = createRoot(container);
  useServers.setState({ servers: [server, { ...server, id: 'c', baseUrl: 'http://c:8765', token: 'token-c' }] });
  useSessions.setState({ byServerRecord: { b: [live('origin'), live('other')], c: [live('origin', { serverId: 'c' })] } });
  for (const [otherName, otherServer] of [['other', 'b'], ['origin', 'c']]) {
    await render(otherName, otherServer);
    expect(button(m.orqcfg_novo_papel())?.disabled).toBe(false); expect(button(m.orqcfg_comecar())?.disabled).toBe(false);
    await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.readOnly).toBe(false);
    await act(async () => root.unmount()); root = createRoot(container);
  }
  await render();
  expect(button(m.orqcfg_novo_papel())?.disabled).toBe(true);
  expect(container.textContent).toContain(m.orqcfg_write_pending());
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.readOnly).toBe(true);
  await input(m.orqcfg_sessao(), 'forbidden'); await click(m.native_close()); await click(m.orqcfg_salvar()); await click(m.orqcfg_comecar());
  expect(writes()).toHaveLength(1); expect(navigation.prevented).toBe(false);
  const racingRead = deferred<Response>(); const oldBase = currentGroup;
  fetcher.mockImplementation(async (url: string) => url.endsWith('/orq') ? racingRead.promise : reply(readData(url)));
  await click(m.orqcfg_recarregar()); const readsBeforeSettle = groupReads().length;
  currentGroup = group([role('executor', { sessao: 'first-write' })], { mtime: 11 });
  await act(async () => pending.resolve(reply({ mtime: 11, papeis: currentGroup.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null })));
  expect(groupReads()).toHaveLength(readsBeforeSettle); expect(writes()).toHaveLength(1);
  await act(async () => racingRead.resolve(reply(oldBase)));
  expect(button(m.orqcfg_novo_papel())?.disabled).toBe(true);
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { const body = JSON.parse(String(options.body)); currentGroup = group(body.papeis, { mtime: 12 }); return reply({ mtime: 12, papeis: body.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null }); }
    return reply(readData(url));
  });
  await click(m.orqcfg_recarregar()); expect(button(m.orqcfg_novo_papel())?.disabled).toBe(false);
  expect(container.textContent).not.toContain(m.orqcfg_write_pending());
  await click('executor'); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${m.orqcfg_sessao()}"]`)?.value).toBe('first-write');
  await input(m.orqcfg_sessao(), 'second-write'); await click(m.native_close()); await click(m.orqcfg_salvar());
  expect(writes()).toHaveLength(2); expect(JSON.parse(String(writes()[1][1].body))).toMatchObject({ mtime: 11, papeis: [{ sessao: 'second-write' }] });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['start', 'remove'] as const)('prazo escrita %s não repete pedido nem aplica resposta tardia', async operation => {
  vi.useFakeTimers(); await render(); const pending = deferred<Response>();
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method && options.method !== 'GET' ? pending.promise : reply(readData(url)));
  if (operation === 'start') await click(m.orqcfg_comecar());
  else { await click('executor'); await click(m.comum_apagar()); await chooseAlert(m.comum_apagar()); }
  await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(container.textContent).toContain(m.orqcfg_write_pending());
  expect(navigation.prevented).toBe(false); await click(m.orqcfg_recarregar()); expect(button(m.orqcfg_comecar())?.disabled).toBe(true);
  const count = groupReads().length;
  await act(async () => pending.resolve(reply(operation === 'start' ? { ok: true, entregue: false, fase: 'planner', plano: '' } : { papeis: [], mtime: 11 })));
  expect(groupReads()).toHaveLength(count); expect(button('executor')).toBeTruthy(); expect(container.textContent).not.toContain(m.orqcfg_comecou_fila());
  await click(m.orqcfg_recarregar()); expect(button(m.orqcfg_comecar())?.disabled).toBe(false); expect(writes()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});

it.each(['read', 'write'] as const)('prazo %s limpa timer ao desmontar e ignora término posterior', async operation => {
  vi.useFakeTimers(); const pending = deferred<Response>();
  if (operation === 'write') { await render(); await click('executor'); await input(m.orqcfg_sessao(), 'changed'); await click(m.native_close()); }
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => (operation === 'write' ? options?.method === 'POST' : url.endsWith('/orq')) ? pending.promise : reply(readData(url)));
  if (operation === 'write') await click(m.orqcfg_salvar()); else await render();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  const calls = fetcher.mock.calls.length;
  await act(async () => root.unmount()); expect(vi.getTimerCount()).toBe(0);
  root = createRoot(container);
  await act(async () => pending.resolve(reply(operation === 'read' ? currentGroup : { mtime: 11, papeis: [], arbitro: null, aviso: 'proxima_sessao', erro: null })));
  expect(container.textContent).toBe(''); expect(fetcher).toHaveBeenCalledTimes(calls);
});

it('layout mantém controles dentro da lista com inset automático e recuo Android do cabeçalho', async () => {
  await render(); const list = container.querySelector('[data-list-inset="automatic"]');
  expect(list?.contains(button(m.orqcfg_recarregar())!)).toBe(true); expect(list?.getAttribute('data-list-top')).toBe('64');
});

it('layout estados iniciais recuam abaixo do cabeçalho transparente', async () => {
  const inset = () => expect((container.firstElementChild as HTMLElement).style.paddingTop).toBe('64px');
  useServers.setState({ ready: false }); await render(); expect(container.textContent).toContain(m.orqcfg_carregando()); inset();
  await act(async () => useServers.setState({ ready: true, servers: [{ ...server, invite: true }] }));
  expect(container.textContent).toContain(m.lista_acesso_recusado()); inset();
  await act(async () => useServers.setState({ servers: [] })); expect(container.textContent).toContain(m.chat_servidor_removido()); inset();
  await act(async () => { useServers.setState({ servers: [server] }); useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'missing' })] } }); });
  expect(container.textContent).toContain(m.erro_sessao_orq()); inset(); expect(fetcher).not.toHaveBeenCalled();
});

it('identidade usa servidor explícito, quatro estados e retry sem trocar para o ativo', async () => {
  const pending = deferred<Response>(); fetcher.mockImplementationOnce(() => pending.promise);
  await render(); expect(container.textContent).toContain(m.orqcfg_carregando());
  await act(async () => pending.resolve(reply(currentGroup)));
  expect(container.textContent).toContain('executor');
  expect(container.textContent).toContain(m.orqcfg_fase_planner());
  expect(groupReads()[0][0]).toBe('http://b:8765/api/sessions/origin/orq');
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('http://b:8765/'))).toBe(true);
  fetcher.mockImplementation(async (url: string) => { if (url.endsWith('/orq')) throw new Error('read-failed'); return reply(readData(url)); });
  await click(m.orqcfg_recarregar()); expect(container.textContent).toContain('read-failed'); expect(container.textContent).toContain('executor');
  currentGroup = group([]); fetcher.mockImplementation(async (url: string) => reply(readData(url)));
  await click(m.orq_panel_retry()); expect(container.textContent).toContain(m.orqcfg_sem_papeis());
});

it.each(['null', 'omitted'] as const)('identidade transcript %s permite ler e gravar pelo árbitro real', async transcript => {
  const { jsonl: _jsonl, ...withoutTranscript } = live('arbiter-b');
  const target = transcript === 'null' ? { ...withoutTranscript, jsonl: null } : withoutTranscript;
  useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'arbiter-b' }), target] } });
  await render();
  expect(groupReads().map(([url]) => url)).toEqual(['http://b:8765/api/sessions/arbiter-b/orq']);
  expect(button('executor')).toBeTruthy();
  await click('executor'); await input(m.orqcfg_sessao(), 'changed'); await click(m.native_close());
  fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      currentGroup = group([role('executor', { sessao: 'changed' })], { mtime: 11 });
      return reply({ mtime: 11, papeis: currentGroup.papeis, arbitro: null, aviso: 'proxima_sessao', erro: null });
    }
    return reply(readData(url));
  });
  await click(m.orqcfg_salvar());
  expect(writes().map(([url]) => url)).toEqual(['http://b:8765/api/sessions/arbiter-b/orq/papeis']);
  expect(navigation.prevented).toBe(false);
});

it('identidade bloqueia convite e removido, espera ready e não chama sintético sem árbitro presente', async () => {
  useServers.setState({ ready: false }); useSessions.setState({ byServerRecord: { b: [] } }); await render(); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => useServers.setState({ ready: true })); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => useServers.setState({ ready: true, servers: [{ ...server, invite: true }] }));
  expect(container.textContent).toContain(m.lista_acesso_recusado()); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => useServers.setState({ servers: [] })); expect(container.textContent).toContain(m.chat_servidor_removido());
  await act(async () => { useServers.setState({ servers: [server] }); useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'arbiter-b' })] } }); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'arbiter-b' }), live('arbiter-b')] } }));
  expect(groupReads().map(([url]) => url)).toEqual(['http://b:8765/api/sessions/arbiter-b/orq']);
});

it('identidade pausa foco e AppState e descarta leitura anterior durante sucessão', async () => {
  const stale = deferred<Response>();
  useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'old' }), live('old')] } });
  fetcher.mockImplementation(async (url: string) => url.endsWith('/old/orq') ? stale.promise : reply(url.endsWith('/orq') ? group([role('new-role')]) : readData(url)));
  await render(); expect(retain).toHaveBeenCalledOnce();
  await act(async () => useSessions.setState({ byServerRecord: { b: [live('origin', { provider: 'orq', orq_arbiter: 'new' }), live('new')] } }));
  expect(container.textContent).toContain('new-role');
  await act(async () => stale.resolve(reply(group([role('old-role')])))); expect(container.textContent).not.toContain('old-role');
  const count = fetcher.mock.calls.length;
  navigation.focused = false; await render(); expect(release).toHaveBeenCalled();
  await click(m.orqcfg_recarregar()); expect(fetcher).toHaveBeenCalledTimes(count);
  navigation.focused = true; await render();
  await act(async () => appState('background')); const paused = fetcher.mock.calls.length;
  await click(m.orqcfg_recarregar()); expect(fetcher).toHaveBeenCalledTimes(paused);
});
