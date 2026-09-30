// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ReactNode } from 'react';
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
  archives: vi.fn(),
  resume: vi.fn(),
  replace: vi.fn(),
  alert: vi.fn(),
}));
const server = { id: 'server-b', label: 'Servidor B', baseUrl: 'https://b.local', token: 'token-b' };

vi.mock('expo-router', () => ({ useRouter: () => ({ replace: calls.replace }) }));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Alert: { alert: calls.alert },
}));
vi.mock('../../stores/servers', () => ({
  useServers: Object.assign(
    (selector: (state: { active: () => typeof server; servers: typeof server[] }) => unknown) => selector({ active: () => calls.target ?? server, servers: [server] }),
    { getState: () => ({ servers: [server], active: () => server }) },
  ),
}));
vi.mock('../../stores/prefs', () => ({ prefs: {
  getString: (key: string) => localStorage.getItem(key) ?? undefined,
  set: (key: string, value: string) => { calls.save(key, value); localStorage.setItem(key, value); },
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
  getArchivePorCwd: calls.archives,
  resumeArchivedConversation: calls.resume,
}));
vi.mock('../../paraglide/messages', () => ({
  codex_ui_account: () => 'codex_ui_account', codex_ui_login_error: () => 'codex_ui_login_error',
  codex_ui_prepare_error: () => 'codex_ui_prepare_error', codex_ui_unknown: () => 'codex_ui_unknown',
  codex_ui_abrindo_sessao: () => 'codex_ui_abrindo_sessao',
  composer_esforco: () => 'composer_esforco', composer_modelo: () => 'composer_modelo',
  comum_carregando: () => 'comum_carregando', comum_conta_claude: () => 'comum_conta_claude',
  comum_motor: () => 'comum_motor', comum_nome: () => 'comum_nome', comum_provider: () => 'comum_provider',
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
}));

import { CreateSessionSheet } from './CreateSessionSheet';

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
    calls.archives.mockReset().mockResolvedValue([]);
    calls.resume.mockReset().mockResolvedValue({ name: 'retomada', state: 'idle' });
    calls.replace.mockReset();
    calls.alert.mockReset();
    localStorage.clear();
  });

  async function renderSheet(strict = false) {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(strict ? createElement(StrictMode, null, createElement(CreateSessionSheet)) : createElement(CreateSessionSheet)));
    await act(async () => Promise.resolve());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Codex')!.click());
    await act(async () => Promise.resolve());
    return { container, root };
  }

  it('escolhe a primeira raiz utilizável e grava só depois do scan', async () => {
    calls.roots.mockResolvedValue([{ name: 'Missing', path: '/missing' }, { name: 'Repo', path: '/repo' }]);
    calls.scan.mockImplementation(async (_server, _root, path) => path === '/missing' ? { entries: [], error: 'not_found' } : { entries: [] });
    const { container, root } = await renderSheet();
    expect(container.textContent).toContain('/repo');
    expect(localStorage.getItem('create.project.v1:server-b')).toBe('{"root":"/repo","cwd":"/repo"}');
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
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'criar_outra_pasta')!.click());
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
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'sessao_nova')!.click());
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ provider: 'claude', cwd: '/repo' }));
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
    const create = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sessao_nova'));
    expect(create).toBeTruthy();
    await act(async () => create!.click());
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ provider: 'codex', codex_account: 'work' }));
    root.unmount();
  });

  it('abre a sessão sem esperar a sincronização da conta na tela', async () => {
    calls.prepare.mockReturnValue(new Promise(() => {}));
    const { container, root } = await renderSheet();
    const create = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sessao_nova'))!;
    await act(async () => create.click());
    expect(calls.replace).toHaveBeenCalledWith('/s/server-b/nova');
    root.unmount();
  });

  it('cria normalmente sob StrictMode após o ciclo de efeitos', async () => {
    const { container, root } = await renderSheet(true);
    const create = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sessao_nova'))!;
    await act(async () => create.click());
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
    const firstCreate = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sessao_nova'))!;
    await act(async () => firstCreate.click());
    expect(calls.create).toHaveBeenCalledWith(server, expect.objectContaining({ model: 'sol', effort: 'high', codex_account: 'work' }));
    calls.create.mockClear();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Mini')!.click());
    const create = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sessao_nova'))!;
    await act(async () => create.click());
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
    const create = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sessao_nova'))!;
    await act(async () => create.click());
    await act(async () => Promise.resolve());
    root.unmount();
    await act(async () => pending.resolve({ name: 'nova', state: 'idle' }));
    expect(calls.replace).not.toHaveBeenCalled();
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
    const create = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sessao_nova'))!;
    expect(create.disabled).toBe(false);
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
});
