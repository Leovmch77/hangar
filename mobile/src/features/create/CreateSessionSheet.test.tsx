// @vitest-environment happy-dom
import { act, createElement, StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  roots: vi.fn(), scan: vi.fn(), sessions: vi.fn(), configs: vi.fn(), engines: vi.fn(), save: vi.fn(),
  target: null as null | { id: string; label: string; baseUrl: string; token: string },
  accounts: vi.fn(),
  models: vi.fn(),
  prepare: vi.fn(),
  preparation: vi.fn(),
  create: vi.fn(),
  send: vi.fn(),
  archives: vi.fn(),
  resume: vi.fn(),
  replace: vi.fn(),
  alert: vi.fn(),
  dismiss: null as null | (() => void),
  pickerActive: 0,
  pickerPeak: 0,
  pickerHistory: [] as number[],
}));
const server = { id: 'server-b', label: 'Servidor B', baseUrl: 'https://b.local', token: 'token-b' };

vi.mock('expo-router', () => ({ useRouter: () => ({ replace: calls.replace }) }));
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return {
  ...actual,
  // O mock global só achata arrays; o estilo por função do Pressable precisa ser resolvido antes.
  Pressable: (props: { style?: unknown }) => (actual.Pressable as unknown as (p: object) => ReactNode)({
    ...props, style: typeof props.style === 'function' ? props.style({ pressed: false }) : props.style,
  }),
  Alert: { alert: calls.alert },
  TextInput: (props: { value?: string; accessibilityLabel?: string; onChangeText?: (value: string) => void }) => createElement('textarea', {
    value: props.value,
    'aria-label': props.accessibilityLabel,
    onInput: (event: { currentTarget: { value: string } }) => props.onChangeText?.(event.currentTarget.value),
  }),
  };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ open = false, children, onDismiss }: { open?: boolean; children: ReactNode; onDismiss?: () => void }) => {
  const [retained, setRetained] = useState(open);
  const callback = useRef(onDismiss);
  const pending = useRef<null | (() => void)>(null);
  callback.current = onDismiss;
  const queueDismiss = useCallback(() => {
    if (pending.current) return;
    const dismiss = () => {
      pending.current = null;
      if (calls.dismiss === dismiss) calls.dismiss = null;
      setRetained(false);
      callback.current?.();
    };
    pending.current = dismiss;
    calls.dismiss = dismiss;
  }, []);
  useEffect(() => {
    if (open) setRetained(true);
    else if (retained) queueDismiss();
  }, [open, retained, queueDismiss]);
  useEffect(() => () => {
    if (calls.dismiss === pending.current) calls.dismiss = null;
    pending.current = null;
  }, []);
  return open || retained ? createElement('div', { 'data-testid': 'options-sheet', 'data-open': String(open) },
    children, createElement('button', { onClick: queueDismiss }, 'fechar-folha'),
  ) : null;
} }));
vi.mock('./CwdPicker', async (original) => {
  const { CwdPicker } = await original<typeof import('./CwdPicker')>();
  return { CwdPicker: (props: Parameters<typeof CwdPicker>[0]) => {
    useEffect(() => {
      calls.pickerActive++;
      calls.pickerPeak = Math.max(calls.pickerPeak, calls.pickerActive);
      calls.pickerHistory.push(calls.pickerActive);
      return () => { calls.pickerActive--; calls.pickerHistory.push(calls.pickerActive); };
    }, []);
    return createElement('div', { 'data-testid': 'cwd-picker' }, createElement(CwdPicker, props));
  } };
});
vi.mock('../../stores/servers', () => ({
  useServers: Object.assign(
    (selector: (state: { active: () => typeof server; servers: typeof server[] }) => unknown) => selector({ active: () => calls.target ?? server, servers: [server] }),
    { getState: () => ({ servers: [server], active: () => server }) },
  ),
}));
vi.mock('../../stores/prefs', () => ({ prefs: {
  getString: (key: string) => localStorage.getItem(key) ?? undefined,
  set: (key: string, value: string) => { calls.save(key, value); localStorage.setItem(key, value); },
  remove: (key: string) => localStorage.removeItem(key),
} }));
vi.mock('./ProviderPicker', () => ({ ProviderPicker: ({ onChange }: { onChange: (provider: string) => void }) => createElement('div', null,
  createElement('button', { onClick: () => onChange('codex') }, 'Codex'),
  createElement('button', { onClick: () => onChange('claude') }, 'Claude'),
) }));
vi.mock('./CodexContextControl', () => ({ CodexContextControl: () => null }));
vi.mock('@react-native-menu/menu', () => ({
  MenuView: ({ actions, onPressAction, children }: { actions: { id: string; title: string }[]; onPressAction: (event: { nativeEvent: { event: string } }) => void; children: ReactNode }) => createElement('div', null,
    children,
    ...actions.map((action) => createElement('button', { key: action.id, onClick: () => onPressAction({ nativeEvent: { event: action.id } }) }, action.title)),
  ),
}));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  listClaudeConfigsForServer: calls.configs,
  getRootsForServer: calls.roots, scanDirForServer: calls.scan, fetchSessionsForServer: calls.sessions,
  probeServerResponse: vi.fn().mockImplementation(async () => new Response('[]')),
  getEnginesForServer: calls.engines,
  modelOptions: vi.fn().mockResolvedValue({ models: [], reduced: false }),
  getSessions: vi.fn().mockResolvedValue([]),
  getCodexAccountsForServer: calls.accounts,
  modelOptionsForServer: calls.models,
  prepareCodexAccountForServer: calls.prepare,
  getCodexPreparationForServer: calls.preparation,
  createSessionForServer: calls.create,
  sendInputForServer: calls.send,
  getArchivePorCwd: calls.archives,
  resumeArchivedConversation: calls.resume,
}));
vi.mock('../../paraglide/messages', () => ({
  codex_ui_account: () => 'codex_ui_account', codex_ui_login_error: () => 'codex_ui_login_error',
  codex_ui_prepare_error: () => 'codex_ui_prepare_error', codex_ui_unknown: () => 'codex_ui_unknown',
  codex_ui_abrindo_sessao: () => 'codex_ui_abrindo_sessao',
  criar_subagente: () => 'criar_subagente', criar_subagente_padrao: () => 'criar_subagente_padrao',
  criar_subagente_ajuda: () => 'criar_subagente_ajuda',
  composer_esforco: () => 'composer_esforco', composer_modelo: () => 'composer_modelo',
  comum_carregando: () => 'comum_carregando', comum_conta_claude: () => 'comum_conta_claude',
  comum_motor: () => 'comum_motor', comum_nome: () => 'comum_nome', comum_provider: () => 'comum_provider', nova_conversa_opcoes_fechar: () => 'nova_conversa_opcoes_fechar',
  contas_nao_conectada: () => 'contas_nao_conectada', cota_conta_parada: () => 'cota_conta_parada',
  cota_precisa_entrar: () => 'cota_precisa_entrar', cota_sem_cota: () => 'cota_sem_cota',
  criar_abre_padrao: ({ erro }: { erro: string }) => `criar_abre_padrao:${erro}`, criar_avancado: () => 'criar_avancado',
  criar_caminho_placeholder: () => 'criar_caminho_placeholder', criar_claude_sua_conta: () => 'criar_claude_sua_conta',
  criar_conta_aria: () => 'criar_conta_aria', criar_criando: () => 'criar_criando', criar_ja_existe: () => 'criar_ja_existe',
  criar_lista_reduzida: () => 'criar_lista_reduzida', criar_modelos_erro: () => 'criar_modelos_erro',
  criar_nome_placeholder: () => 'criar_nome_placeholder', criar_outra_pasta: () => 'criar_outra_pasta',
  criar_padrao: () => 'criar_padrao', criar_permissao: () => 'criar_permissao', criar_permissao_padrao: () => 'criar_permissao_padrao',
  criar_raciocinio: () => 'criar_raciocinio', criar_retomar: () => 'criar_retomar', criar_retomar_acao: () => 'criar_retomar_acao',
  criar_retomar_escolha: () => 'criar_retomar_escolha', criar_sessao_erro: () => 'criar_sessao_erro', criar_usar: () => 'criar_usar',
  criar_verificando: () => 'criar_verificando', criar_sessao: () => 'criar_sessao', sessao_nova: () => 'sessao_nova',
  switcher_atual: () => 'switcher_atual',
  criar_projeto_indisponivel: () => 'projeto_indisponivel', criar_projeto_salvar_erro: () => 'projeto_salvar_erro',
  criar_motores_erro: () => 'motores_erro', servidor_nao_existe: () => 'servidor_nao_existe',
  arquivo_carregando: () => 'carregando', arquivo_carregar_raizes_erro: () => 'raizes_erro',
  arquivo_sem_raizes: () => 'sem_raizes', arquivo_buscar_pasta: () => 'buscar_pasta',
  arquivo_sem_subpastas: () => 'sem_subpastas', arquivo_sem_resultados: () => 'sem_resultados',
  arquivo_usar_pasta: () => 'usar_pasta', arquivo_abrir: ({ nome }: { nome: string }) => `abrir:${nome}`,
  arquivo_ler_falhou: () => 'ler_falhou', arquivo_pasta_nao_encontrada: () => 'pasta_nao_encontrada',
  arquivo_sem_permissao: () => 'sem_permissao', arquivo_ilegivel: () => 'ilegivel',
  arquivo_raiz_nao_liberada: () => 'raiz_nao_liberada', arquivo_caminho_invalido: () => 'caminho_invalido',
  nova_conversa_placeholder: () => 'nova_conversa_placeholder', nova_conversa_enviar: () => 'nova_conversa_enviar',
  nova_conversa_opcoes: () => 'nova_conversa_opcoes', nova_conversa_sem_destino: () => 'nova_conversa_sem_destino',
  nova_conversa_destino_hint: () => 'nova_conversa_destino_hint', nova_conversa_config_hint: () => 'nova_conversa_config_hint',
  nova_conversa_guardada: () => 'nova_conversa_guardada', nova_conversa_abrir: () => 'nova_conversa_abrir',
  nova_conversa_reenviar: () => 'nova_conversa_reenviar', nova_conversa_conferir: () => 'nova_conversa_conferir',
  nova_conversa_adotar: () => 'nova_conversa_adotar', nova_conversa_descartar: () => 'nova_conversa_descartar',
  nova_conversa_nome_automatico: () => 'nova_conversa_nome_automatico',
  nova_conversa_retomada_selecionada: () => 'nova_conversa_retomada_selecionada',
  nova_conversa_criacao_incerta: () => 'nova_conversa_criacao_incerta', nova_conversa_envio_incerto: () => 'nova_conversa_envio_incerto',
  nova_conversa_salvar_erro: () => 'nova_conversa_salvar_erro', nova_conversa_servidor_ausente: () => 'nova_conversa_servidor_ausente',
  nova_conversa_resultado_salvar_erro: () => 'nova_conversa_resultado_salvar_erro',
  nova_conversa_envio_recusado: ({ erro }: { erro: string }) => `nova_conversa_envio_recusado:${erro}`,
}));

import { CreateSessionSheet } from './CreateSessionSheet';
import { _resetNewConversationForTests } from '../../stores/newConversation';

const connected = { id: 'work', credential_id: 'codex:/work', name: 'Trabalho', home: '/work', is_default: false, auth: { method: 'oauth', status: 'connected', email: 'work@example.com', plan: 'Plus' }, sync: { status: 'ready', trust_pending: false, issues: [] } };
const defaultAccount = { id: 'default', credential_id: 'codex:/default', name: 'Padrão', home: '/default', is_default: true, auth: { method: 'oauth', status: 'connected', email: 'default@example.com', plan: 'Plus' }, sync: { status: 'ready', trust_pending: false, issues: [] } };
const archived = { project: '-repo', cwd: '/repo', session_id: 'sid-1', mtime: 1, preview: 'continuação', ultima: 'última mensagem', live: false, config_dir: null, conta: 'Trabalho', provider: 'codex', codex_account: 'work', codex_home: '/work' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CreateSessionSheet Codex', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    calls.dismiss = null;
    calls.pickerActive = 0;
    calls.pickerPeak = 0;
    calls.pickerHistory = [];
    calls.target = null;
    calls.save.mockReset();
    calls.roots.mockReset().mockResolvedValue([{ name: 'Repo', path: '/repo' }]);
    calls.scan.mockReset().mockResolvedValue({ entries: [] });
    calls.sessions.mockReset().mockResolvedValue([]);
    calls.configs.mockReset().mockResolvedValue([]);
    calls.engines.mockReset().mockResolvedValue({ motores: {} });
    calls.accounts.mockReset().mockResolvedValue([connected]);
    calls.models.mockReset().mockResolvedValue({ models: [], reduced: false });
    calls.prepare.mockReset().mockResolvedValue({ status: 'ready', trust_pending: false, issues: [] });
    calls.preparation.mockReset();
    calls.create.mockReset().mockResolvedValue({ name: 'nova', state: 'idle' });
    calls.send.mockReset().mockResolvedValue(undefined);
    calls.archives.mockReset().mockResolvedValue([]);
    calls.resume.mockReset().mockResolvedValue({ name: 'retomada', state: 'idle' });
    calls.replace.mockReset();
    calls.alert.mockReset();
    localStorage.clear();
    _resetNewConversationForTests();
  });

  const button = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text);

  function type(container: HTMLElement, text: string) {
    const input = container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function send(container: HTMLElement, text = 'oi') {
    await act(async () => type(container, text));
    await act(async () => button(container, 'nova_conversa_enviar')!.click());
    for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
  }

  async function flushDismiss() {
    expect(calls.dismiss).toBeTruthy();
    await act(async () => calls.dismiss!());
  }

  async function renderSheet(strict = false) {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(strict ? createElement(StrictMode, null, createElement(CreateSessionSheet)) : createElement(CreateSessionSheet)));
    await act(async () => Promise.resolve());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'nova_conversa_opcoes')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Codex')!.click());
    await act(async () => Promise.resolve());
    return { container, root };
  }

  it('abre os resumos e conserva destino, seleções e texto ao fechar a folha', async () => {
    calls.accounts.mockResolvedValue([defaultAccount, connected]);
    calls.models.mockResolvedValue({ models: [{ id: 'sol', name: 'Sol', efforts: ['low', 'high'] }], reduced: false });
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    await act(async () => type(container, 'primeira mensagem'));
    expect(container.textContent).toContain('/repo');
    await act(async () => button(container, 'Servidor B · /repo')!.click());
    calls.scan.mockResolvedValue({ entries: [{ name: 'Child', path: '/repo/child', is_git: true, has_claude_md: false }] });
    await act(async () => button(container, 'criar_outra_pasta')!.click());
    await act(async () => button(container, 'Repo')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Child'))!.click());
    await act(async () => button(container, 'fechar-folha')!.click());
    await flushDismiss();
    await act(async () => button(container, 'Claude · criar_padrao')!.click());
    await act(async () => button(container, 'Codex')!.click());
    await act(async () => button(container, 'Trabalho')!.click());
    await act(async () => button(container, 'Sol')!.click());
    await act(async () => button(container, 'high')!.click());
    await act(async () => button(container, 'fechar-folha')!.click());
    await flushDismiss();
    expect(container.textContent).toContain('Servidor B · /repo/child');
    expect(container.textContent).toContain('Codex · Sol · high');
    expect((container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement).value).toBe('primeira mensagem');
    await act(async () => button(container, 'nova_conversa_enviar')!.click());
    for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({
      cwd: '/repo/child', provider: 'codex', codex_account: 'work', model: 'sol', effort: 'high',
    }));
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.send).toHaveBeenCalledWith(server, 'nova', 'primeira mensagem');
    expect(calls.send).toHaveBeenCalledTimes(1);
    expect(calls.replace).toHaveBeenCalledWith('/s/server-b/nova');
    root.unmount();
  });

  it('autoseleciona a primeira raiz utilizável sem abrir a folha e grava só depois do scan', async () => {
    const roots = deferred<{ name: string; path: string }[]>();
    const scan = deferred<{ entries: [] }>();
    calls.roots.mockReturnValue(roots.promise);
    calls.scan.mockImplementation(async (_server, _root, path) => path === '/missing' ? { entries: [], error: 'not_found' } : scan.promise);
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    await act(async () => type(container, 'primeira mensagem'));
    expect(container.querySelector('[data-testid="options-sheet"]')).toBeNull();
    expect(calls.pickerActive).toBe(1);
    expect(container.textContent).toContain('carregando');
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(true);
    await act(async () => roots.resolve([{ name: 'Missing', path: '/missing' }, { name: 'Repo', path: '/repo' }]));
    expect(calls.scan).toHaveBeenCalledWith(server, '/missing', '/missing', expect.any(AbortSignal));
    expect(calls.scan).toHaveBeenCalledWith(server, '/repo', '/repo', expect.any(AbortSignal));
    expect(localStorage.getItem('create.project.v1:server-b')).toBeNull();
    await act(async () => scan.resolve({ entries: [] }));
    expect(button(container, 'Servidor B · /repo')).toBeTruthy();
    expect((container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement).value).toBe('primeira mensagem');
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(false);
    expect(localStorage.getItem('create.project.v1:server-b')).toBe('{"root":"/repo","cwd":"/repo"}');
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.send).not.toHaveBeenCalled();
    expect(calls.pickerPeak).toBe(1);
    expect(calls.pickerActive).toBe(0);
    root.unmount();
  });

  it.each([
    ['gesto', false], ['controlado', false], ['gesto', true], ['controlado', true],
  ] as const)('fecha por %s com picked=%s sem dois pickers durante callback tardio', async (closing, picked) => {
    if (!picked) calls.roots.mockReturnValue(new Promise(() => {}));
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    await act(async () => type(container, 'texto conservado'));
    expect(calls.pickerActive).toBe(picked ? 0 : 1);
    const initialSignal = calls.roots.mock.calls[0][1] as AbortSignal;
    if (!picked) expect(initialSignal.aborted).toBe(false);
    await act(async () => button(container, 'nova_conversa_opcoes')!.click());
    const sheet = container.querySelector('[data-testid="options-sheet"]')!;
    expect(sheet).toBeTruthy();
    expect(sheet.querySelectorAll('[data-testid="cwd-picker"]').length).toBe(picked ? 0 : 1);
    const sheetSignal = !picked ? calls.roots.mock.calls.at(-1)![1] as AbortSignal : null;
    if (sheetSignal) {
      expect(initialSignal.aborted).toBe(true);
      expect(sheetSignal.aborted).toBe(false);
    }
    if (picked) expect(button(container, 'criar_outra_pasta')).toBeTruthy();
    await act(async () => button(container, closing === 'gesto' ? 'fechar-folha' : 'nova_conversa_opcoes_fechar')!.click());
    expect(calls.dismiss).toBeTruthy();
    expect(container.querySelector('[data-testid="options-sheet"]')).toBe(sheet);
    expect(sheet.getAttribute('data-open')).toBe(closing === 'gesto' ? 'true' : 'false');
    expect(calls.pickerActive).toBe(picked ? 0 : 1);
    expect(calls.pickerPeak).toBe(1);
    if (sheetSignal) expect(sheetSignal.aborted).toBe(closing === 'controlado');
    if (closing === 'controlado') {
      expect(sheet.querySelector('[data-testid="cwd-picker"]')).toBeNull();
      expect(button(sheet as HTMLElement, 'criar_outra_pasta')).toBeUndefined();
      if (picked) expect(button(container, 'Servidor B · /repo')).toBeTruthy();
      else expect(container.querySelectorAll('[data-testid="cwd-picker"]').length).toBe(1);
    } else if (!picked) {
      expect(sheet.querySelector('[data-testid="cwd-picker"]')).toBeTruthy();
    }
    await flushDismiss();
    expect(container.querySelector('[data-testid="options-sheet"]')).toBeNull();
    expect(calls.pickerActive).toBe(picked ? 0 : 1);
    if (sheetSignal) expect(sheetSignal.aborted).toBe(true);
    expect(calls.pickerHistory.every((active) => active <= 1)).toBe(true);
    expect((container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement).value).toBe('texto conservado');
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.send).not.toHaveBeenCalled();
    root.unmount();
    expect(calls.pickerActive).toBe(0);
    expect(calls.dismiss).toBeNull();
  });

  it.each(['raizes', 'scan', 'preferencia', 'catalogo', 'modelos'] as const)('mantém erro de %s e texto editável no principal fechado sem POST', async (failure) => {
    const message = failure === 'raizes' ? '401: unauthorized'
      : failure === 'scan' ? 'sem_permissao'
      : failure === 'preferencia' ? 'projeto_indisponivel'
      : failure === 'catalogo' ? 'catalogo_recusado' : 'modelos_recusados';
    if (failure === 'raizes') calls.roots.mockRejectedValue(new Error(message));
    if (failure === 'scan') calls.scan.mockResolvedValue({ entries: [], error: 'permission_denied' });
    if (failure === 'preferencia') {
      localStorage.setItem('create.project.v1:server-b', '{"root":"/repo","cwd":"/repo/deleted"}');
      calls.scan.mockResolvedValue({ entries: [], error: 'not_found' });
    }
    if (failure === 'catalogo' || failure === 'modelos') {
      calls.scan.mockReturnValue(new Promise(() => {}));
      if (failure === 'catalogo') calls.configs.mockRejectedValue(new Error(message));
      else calls.models.mockRejectedValue(new Error(message));
    }
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    await act(async () => type(container, 'antes da folha'));
    expect(container.textContent).toContain(message);
    expect(container.querySelector('[data-testid="options-sheet"]')).toBeNull();
    await act(async () => button(container, 'nova_conversa_opcoes')!.click());
    await act(async () => button(container, 'nova_conversa_opcoes_fechar')!.click());
    await flushDismiss();
    await act(async () => type(container, 'depois da folha'));
    expect(container.textContent).toContain(message);
    expect((container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement).value).toBe('depois da folha');
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(true);
    await act(async () => button(container, 'nova_conversa_enviar')!.click());
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.send).not.toHaveBeenCalled();
    root.unmount();
  });

  it('mantém erro da conta no principal após gesto tardio e bloqueia envio sem apagar texto', async () => {
    calls.accounts.mockRejectedValue(new Error('conta_recusada'));
    const { container, root } = await renderSheet();
    await act(async () => type(container, 'texto da conta'));
    await act(async () => button(container, 'fechar-folha')!.click());
    await flushDismiss();
    expect(container.textContent).toContain('conta_recusada');
    expect(button(container, 'Servidor B · /repo')).toBeTruthy();
    await act(async () => type(container, 'texto corrigido'));
    expect((container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement).value).toBe('texto corrigido');
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(true);
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.send).not.toHaveBeenCalled();
    root.unmount();
  });

  it('confere preferência Windows sem reconstruir o caminho', async () => {
    const path = 'C:\\work\\repo';
    localStorage.setItem('create.project.v1:server-b', JSON.stringify({ root: 'C:\\work', cwd: path }));
    calls.roots.mockResolvedValue([{ name: 'Work', path: 'C:\\work' }]);
    const { container, root } = await renderSheet();
    expect(container.textContent).toContain(path);
    expect(calls.scan).toHaveBeenCalledWith(server, 'C:\\work', path, expect.any(AbortSignal));
    root.unmount();
  });

  it('valida a subpasta escolhida e restaura ao reabrir', async () => {
    const { container, root } = await renderSheet();
    calls.scan.mockResolvedValue({ entries: [{ name: 'Child', path: '/repo/child', is_git: true, has_claude_md: false }] });
    await act(async () => button(container, 'criar_outra_pasta')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Repo')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Child'))!.click());
    expect(container.textContent).toContain('/repo/child');
    expect(localStorage.getItem('create.project.v1:server-b')).toBe('{"root":"/repo","cwd":"/repo/child"}');
    root.unmount();
    const reopened = await renderSheet();
    expect(reopened.container.textContent).toContain('/repo/child');
    reopened.root.unmount();
  });

  it('cria Claude no destino explícito do projeto', async () => {
    const { container, root } = await renderSheet();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Claude')!.click());
    await act(async () => {
      const field = container.querySelector('textarea[aria-label="comum_nome"]') as HTMLTextAreaElement;
      field.value = 'meu-nome';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await send(container);
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ provider: 'claude', cwd: '/repo', name: 'meu-nome' }));
    expect(calls.send).toHaveBeenCalledWith(server, 'nova', 'oi');
    expect(calls.replace).toHaveBeenCalledWith('/s/server-b/nova');
    root.unmount();
  });

  it('mostra preferência indisponível sem substituir a pasta', async () => {
    localStorage.setItem('create.project.v1:server-b', '{"root":"/repo","cwd":"/repo/deleted"}');
    calls.scan.mockResolvedValue({ entries: [], error: 'not_found' });
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    expect(container.textContent).toContain('projeto_indisponivel');
    expect(container.textContent).toContain('criar_avancado');
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.save).not.toHaveBeenCalled();
    root.unmount();
  });

  it('preserva erro de autenticação legível no seletor', async () => {
    calls.roots.mockRejectedValue(new Error('401: unauthorized'));
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    expect(container.textContent).toContain('401: unauthorized');
    expect(container.textContent).toContain('criar_avancado');
    root.unmount();
  });

  it('descarta scan, contas Claude e modelos tardios ao mudar de máquina', async () => {
    const scan = deferred<{ entries: [] }>(); const models = deferred<{ models: { id: string; name: string }[]; reduced: boolean }>();
    const configs = deferred<{ path: string; label: string; active: boolean }[]>();
    calls.configs.mockReturnValueOnce(configs.promise);
    calls.scan.mockReturnValueOnce(scan.promise); calls.models.mockReturnValueOnce(models.promise);
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    calls.target = { id: 'server-c', label: 'Servidor C', baseUrl: 'https://c.local', token: 'token-c' };
    calls.roots.mockResolvedValue([{ name: 'Other', path: '/other' }]);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    await act(async () => button(container, 'nova_conversa_opcoes')!.click());
    await act(async () => { scan.resolve({ entries: [] }); configs.resolve([{ path: '/old', label: 'Conta antiga', active: true }]); models.resolve({ models: [{ id: 'old', name: 'Modelo antigo' }], reduced: false }); });
    expect(container.textContent).toContain('/other');
    expect(container.textContent).not.toContain('/repo');
    expect(container.textContent).not.toContain('Modelo antigo');
    expect(calls.models).not.toHaveBeenCalledWith(calls.target, 'claude', null, '/old', null, expect.any(AbortSignal));
    expect(localStorage.getItem('create.project.v1:server-b')).toBeNull();
    root.unmount();
  });

  it('informa falha ao salvar preferência sem impedir seleção válida', async () => {
    calls.save.mockImplementation(() => { throw new Error('storage failed'); });
    const { container, root } = await renderSheet();
    expect(container.textContent).toContain('projeto_salvar_erro');
    expect(container.textContent).toContain('/repo');
    root.unmount();
  });

  it('seleciona conta do servidor e envia a conta no create', async () => {
    const { container, root } = await renderSheet();
    await act(async () => Promise.resolve());
    await send(container);
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ provider: 'codex', codex_account: 'work' }));
    root.unmount();
  });

  it('abre a sessão sem esperar a sincronização da conta na tela', async () => {
    calls.prepare.mockReturnValue(new Promise(() => {}));
    const { container, root } = await renderSheet();
    await send(container);
    expect(calls.replace).toHaveBeenCalledWith('/s/server-b/nova');
    root.unmount();
  });

  it('cria normalmente sob StrictMode após o ciclo de efeitos', async () => {
    const { container, root } = await renderSheet(true);
    await send(container);
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ provider: 'codex', codex_account: 'work' }));
    expect(calls.replace).toHaveBeenCalled();
    root.unmount();
  });

  it('envia esforço Codex do modelo escolhido e limpa esforço incompatível', async () => {
    calls.models.mockResolvedValue({ models: [
      { id: 'sol', name: 'Sol', efforts: ['low', 'high'] },
      { id: 'mini', name: 'Mini', efforts: ['low'] },
    ], reduced: false });
    const { container, root } = await renderSheet();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Sol')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'high')!.click());
    await send(container);
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ model: 'sol', effort: 'high', codex_account: 'work' }));
    calls.create.mockClear();
    await act(async () => button(container, 'nova_conversa_descartar')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Mini')!.click());
    await send(container);
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ model: 'mini', effort: null, codex_account: 'work' }));
    root.unmount();
  });

  it('retoma conversa Codex com a identidade do ArchiveEntry', async () => {
    calls.archives.mockResolvedValue([archived]);
    const { container, root } = await renderSheet();
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('última mensagem');
    const option = [...container.querySelectorAll('button')].find((button) => button.textContent === 'última mensagem');
    expect(option).toBeTruthy();
    await act(async () => option!.click());
    const resume = [...container.querySelectorAll('button')].find((button) => button.textContent === 'criar_retomar_acao');
    expect(resume).toBeTruthy();
    await act(async () => resume!.click());
    expect(calls.resume).toHaveBeenCalledWith('-repo', 'sid-1', null, null, 'codex', 'work', server);
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.create).not.toHaveBeenCalled();
    root.unmount();
  });

  it('não navega se desmontar depois que o create fica pendente', async () => {
    const pending = deferred<{ name: string; state: 'idle' }>();
    calls.create.mockReturnValue(pending.promise);
    const { container, root } = await renderSheet();
    await send(container);
    root.unmount();
    await act(async () => pending.resolve({ name: 'nova', state: 'idle' }));
    for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
    expect(calls.replace).not.toHaveBeenCalled();
    expect(calls.send).toHaveBeenCalledWith(server, 'nova', 'oi');
  });

  it('libera a retomada ao trocar de conta e descarta a operação antiga', async () => {
    calls.accounts.mockResolvedValue([connected, defaultAccount]);
    calls.archives.mockResolvedValue([archived]);
    const pending = deferred<{ name: string; state: 'idle' }>();
    calls.resume.mockReturnValue(pending.promise);
    const { container, root } = await renderSheet();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Trabalho')!.click());
    await act(async () => Promise.resolve());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'última mensagem')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'criar_retomar_acao')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Padrão')!.click());
    await act(async () => type(container, 'oi'));
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(false);
    await act(async () => pending.resolve({ name: 'retomada', state: 'idle' }));
    expect(calls.replace).not.toHaveBeenCalled();
    root.unmount();
  });

  it('não navega se desmontar enquanto a retomada está pendente', async () => {
    calls.archives.mockResolvedValue([archived]);
    const pending = deferred<{ name: string; state: 'idle' }>();
    calls.resume.mockReturnValue(pending.promise);
    const { container, root } = await renderSheet();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'última mensagem')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'criar_retomar_acao')!.click());
    root.unmount();
    await act(async () => pending.resolve({ name: 'retomada', state: 'idle' }));
    expect(calls.replace).not.toHaveBeenCalled();
  });
  it('mostra o campo e aceita texto enquanto as raízes carregam, sem enviar sem destino', async () => {
    calls.roots.mockReturnValue(new Promise(() => {}));
    const container = document.createElement('div'); const root = createRoot(container);
    await act(async () => root.render(createElement(CreateSessionSheet)));
    await act(async () => type(container, 'primeira'));
    expect((container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement).value).toBe('primeira');
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(true);
    expect(container.textContent).toContain('nova_conversa_sem_destino');
    expect(container.textContent).toContain('Servidor B');
    root.unmount();
  });

  it('reabre tentativa gravada em criação como incerta, sem novo POST', async () => {
    localStorage.setItem('create.attempt.v1:server-b', JSON.stringify({
      id: 'a1', serverId: 'server-b', text: 'guardada', phase: 'creating', sessionName: null,
      body: { name: 'repo-a1', cwd: '/repo', provider: 'claude' },
    }));
    const { container, root } = await renderSheet();
    expect(container.textContent).toContain('nova_conversa_guardada');
    expect(container.textContent).toContain('nova_conversa_criacao_incerta');
    expect(button(container, 'nova_conversa_conferir')).toBeTruthy();
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(true);
    expect(calls.create).not.toHaveBeenCalled();
    root.unmount();
  });

  it('mensagem já entregue não volta ao campo ao reabrir, nem depois de descartar', async () => {
    localStorage.setItem('create.attempt.v1:server-b', JSON.stringify({
      id: 'a2', serverId: 'server-b', text: 'entregue', phase: 'sent', sessionName: 'nova',
      body: { name: 'repo-a2', cwd: '/repo', provider: 'claude' },
    }));
    const { container, root } = await renderSheet();
    const input = container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect(container.textContent).toContain('nova_conversa_guardada');
    expect(button(container, 'nova_conversa_abrir')).toBeTruthy();
    await act(async () => button(container, 'nova_conversa_descartar')!.click());
    expect(input.value).toBe('');
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(true);
    expect(calls.create).not.toHaveBeenCalled();
    root.unmount();
  });

  it('toque duplo em Enviar dispara um único create', async () => {
    const pending = deferred<{ name: string; state: 'idle' }>();
    calls.create.mockReturnValue(pending.promise);
    const { container, root } = await renderSheet();
    await act(async () => type(container, 'oi'));
    const enviar = button(container, 'nova_conversa_enviar')!;
    await act(async () => { enviar.click(); enviar.click(); });
    await act(async () => pending.resolve({ name: 'nova', state: 'idle' }));
    for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.send).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('cwd recusado mantém o texto editável com o motivo e não navega', async () => {
    calls.create.mockRejectedValueOnce(Object.assign(new Error('400: diretório não existe'), { status: 400 }));
    const { container, root } = await renderSheet();
    await send(container);
    const input = container.querySelector('textarea[aria-label="nova_conversa_placeholder"]') as HTMLTextAreaElement;
    expect(input.value).toBe('oi');
    expect(container.textContent).toContain('400: diretório não existe');
    expect(button(container, 'nova_conversa_enviar')!.disabled).toBe(false);
    expect(calls.replace).not.toHaveBeenCalled();
    expect(calls.send).not.toHaveBeenCalled();
    root.unmount();
  });

  it('create OK e input recusado abre a mesma sessão e não cria de novo', async () => {
    calls.send.mockRejectedValueOnce(Object.assign(new Error('recusado'), { status: 400 }));
    const { container, root } = await renderSheet();
    await send(container);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.replace).toHaveBeenCalledWith('/s/server-b/nova');
    await act(async () => button(container, 'nova_conversa_reenviar')!.click());
    for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.send).toHaveBeenCalledTimes(2);
    expect(calls.send).toHaveBeenLastCalledWith(server, 'nova', 'oi');
    root.unmount();
  });
});
