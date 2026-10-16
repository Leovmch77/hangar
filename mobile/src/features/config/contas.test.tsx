// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  list: vi.fn(),
  credentials: vi.fn(),
  engines: vi.fn(),
  login: null as { server: unknown; accountId?: string } | null,
}));

const server = { id: 'server-b', label: 'Servidor B', baseUrl: 'https://b.local', token: 'token-b' };

vi.mock('../../stores/servers', () => ({
  useServers: (selector: (state: { active: () => typeof server; servers: typeof server[]; activeId: string }) => unknown) =>
    selector({ active: () => server, servers: [server], activeId: server.id }),
}));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getCodexAccountsForServer: calls.list,
  getCredentialsForServer: calls.credentials,
  getEnginesForServer: calls.engines,
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('../../ui/Sheet', () => ({
  Sheet: ({ children, open }: { children: ReactNode; open?: boolean }) => open === false ? null : createElement('div', null, children),
}));
vi.mock('./CodexContaLogin', () => ({
  CodexContaLogin: (props: { server: unknown; accountId?: string; onComplete: () => void }) => {
    calls.login = { server: props.server, accountId: props.accountId };
    return createElement('div', { 'data-testid': 'codex-login' }, props.accountId ?? 'new');
  },
}));
vi.mock('./Pagina', () => ({ Pagina: ({ children }: { children: ReactNode }) => createElement('main', null, children) }));
vi.mock('./SettingsRow', () => ({
  SettingsRow: ({ title, description, children }: { title: string; description?: string; children?: ReactNode }) =>
    createElement('section', null, createElement('strong', null, title), description ? createElement('span', null, description) : null, children),
}));
vi.mock('./SectionCard', () => ({
  SectionCard: ({ title, subtitle, extra, children }: { title?: string; subtitle?: string; extra?: ReactNode; children?: ReactNode }) =>
    createElement('article', null, title, subtitle ? createElement('small', null, subtitle) : null, extra, children),
}));
vi.mock('./InfoNotice', () => ({ InfoNotice: ({ text }: { text: string }) => createElement('p', null, text) }));
vi.mock('./PageHeader', () => {
  const Pill = ({ label, onPress }: { label: string; onPress: () => void }) => createElement('button', { onClick: onPress }, label);
  return {
    Pill,
    PageHeader: ({ title, actions }: { title: string; actions?: Array<{ label: string; onPress: () => void }> }) =>
      createElement('header', null, title, ...(actions ?? []).map((a) => createElement(Pill, { key: a.label, ...a }))),
  };
});
vi.mock('../../paraglide/messages', async original => ({
  ...await original<typeof import('../../paraglide/messages')>(),
  contas_modelos_titulo: () => 'Contas e modelos',
  contas_descricao: () => 'credenciais',
  contas_secao_claude_leg: () => 'leg assinaturas',
  contas_secao_modelos_leg: () => 'leg modelos',
  contas_secao_outros_leg: () => 'leg outras',
  contas_atualizar: () => 'Atualizar',
  contas_nova: () => '+ Nova conta',
  contas_entrar: () => 'Entrar',
  lista_remover: () => 'Remover',
  comum_apagar: () => 'Apagar',
  comum_cancelar: () => 'Cancelar',
  codex_account_delete_failed: () => 'Não foi possível apagar a conta Codex.',
  contas_tipo_chave: () => 'Chave de API',
  contas_secao_claude: () => 'Assinaturas',
  contas_secao_modelos: () => 'Modelos',
  contas_secao_outros: () => 'Outras chaves',
  comum_carregando: () => 'Carregando…',
  maquinas_titulo: () => 'Máquinas',
  maquinas_vazio: () => 'Nenhuma máquina',
  contas_email_plano: ({ email, max }: { email: string; max: string }) => `${email} · ${max}`,
  contas_nao_conectada: () => 'Não está conectada',
  codex_ui_unknown: () => 'Autenticação indisponível',
  codex_ui_account: () => 'Conta do Codex',
  novacred_codex_nome: () => 'Conta do ChatGPT (Codex)',
  login_fechar: () => 'Fechar',
  erro_desconhecido: () => 'Erro',
}));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (fn: any) => typeof fn === 'function' ? fn({ tokens: { border: { default: '#ccc' }, bg: { surface: '#eee' }, text: { primary: '#000', secondary: '#666', muted: '#999' }, accent: { base: '#00f' }, status: { error: '#f00', success: '#0a0' } }, base: { space: [0, 4, 8, 12, 16], text: { xs: 12, sm: 14, base: 16, lg: 18, xl: 20 }, radius: { md: 8, lg: 12 }, fontMono: 'monospace' } }) : fn } }));

import { motivoLoginIndisponivel, type Credencial } from '@hangar/core';
import Contas from '../../../app/config/contas';

describe('contas Codex', () => {
  beforeEach(() => {
    calls.list.mockReset();
    calls.credentials.mockReset();
    calls.engines.mockReset();
    calls.engines.mockResolvedValue({ motores: {}, arquivo_corrompido: false, arquivo_caminho: '' });
    calls.login = null;
    calls.list.mockResolvedValue([
      { id: 'default', credential_id: 'codex:/default', name: 'Padrão', home: '/default', is_default: true, auth: { method: 'oauth', status: 'connected', email: 'a@example.com', plan: 'Plus' }, sync: { status: 'ready', trust_pending: false, issues: [] } },
      { id: 'work', credential_id: 'codex:/work', name: 'Trabalho', home: '/work', is_default: false, auth: { method: 'oauth', status: 'disconnected', email: null, plan: null }, sync: { status: 'ready', trust_pending: false, issues: [] } },
    ]);
    calls.credentials.mockResolvedValue([
      { id: 'claude:/main', tipo: 'claude', auth_method: 'oauth', nome: 'Claude', nome_natural: 'Claude', ativa: true, usos: [], login: { estado: 'ok', loggedIn: true, email: 'claude@example.com', plano: 'Max' } },
      { id: 'codex:/work', tipo: 'codex', auth_method: 'oauth', codex_account: 'work', nome: 'Codex OAuth', nome_natural: 'Codex OAuth', ativa: true, usos: [] },
      { id: 'key:other', tipo: 'chave', auth_method: 'api_key', nome: 'API key', nome_natural: 'API key', ativa: true, usos: [] },
      { id: 'unknown', tipo: 'chave', auth_method: 'unknown', nome: 'Unknown', nome_natural: 'Unknown', ativa: true, usos: [] },
    ]);
  });

  it('lê e autentica no servidor ativo, mantendo a conta escolhida', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(Contas)));
    await act(async () => Promise.resolve());

    expect(calls.list).toHaveBeenCalledWith(server, expect.any(AbortSignal));
    expect(calls.credentials).toHaveBeenCalledWith(server, false, expect.any(AbortSignal));
    expect(container.textContent).toContain('Servidor B');
    expect((container.textContent?.match(/Trabalho/g) ?? []).length).toBe(1);
    expect(container.textContent).not.toContain('Codex OAuth');
    expect(container.textContent).toContain('Assinaturas');
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).toContain('API key');
    expect(container.textContent).toContain('Unknown');
    expect((container.textContent?.match(/API key/g) ?? []).length).toBe(1);
    expect((container.textContent?.match(/Unknown/g) ?? []).length).toBe(1);
    const work = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Entrar');
    expect(work).toBeTruthy();
    await act(async () => work!.click());
    expect(calls.login).toEqual({ server, accountId: 'work' });

    const novo = [...container.querySelectorAll('button')].find((button) => button.textContent === '+ Nova conta');
    await act(async () => novo!.click());
    expect(calls.login).toEqual({ server, accountId: undefined });
    root.unmount();
  });

  it('diz por que o login não foi conferido no lugar do indisponível genérico', async () => {
    const claude = { id: 'claude:/main', tipo: 'claude', auth_method: 'oauth', nome: 'Claude', nome_natural: 'Claude', ativa: true, usos: [],
      login: { estado: 'indisponivel', loggedIn: null, email: null, plano: null, motivo: 'cli-indisponivel' } } as Credencial;
    const codexConta = { id: 'codex:/work', tipo: 'codex', auth_method: 'oauth', codex_account: 'work', nome: 'Codex OAuth', nome_natural: 'Codex OAuth', ativa: false, usos: [],
      login: { estado: 'indisponivel', loggedIn: null, email: null, plano: null, motivo: 'prazo' } } as Credencial;
    const codexSolta = { id: 'codex:/solta', tipo: 'codex', auth_method: 'unknown', codex_account: 'solta', nome: 'Solta', nome_natural: 'Solta', ativa: false, usos: [],
      login: { estado: 'indisponivel', loggedIn: null, email: null, plano: null, motivo: 'leitura-falhou' } } as Credencial;
    calls.list.mockResolvedValue([
      { id: 'work', credential_id: 'codex:/work', name: 'Trabalho', home: '/work', is_default: true, auth: { method: 'oauth', status: 'unavailable', email: null, plan: null }, sync: { status: 'ready', trust_pending: false, issues: [] } },
    ]);
    calls.credentials.mockResolvedValue([claude, codexConta, codexSolta]);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(Contas)));
    await act(async () => Promise.resolve());

    const description = (title: string) => [...container.querySelectorAll('section')]
      .find((row) => row.querySelector('strong')?.textContent === title)?.querySelector('span')?.textContent;
    for (const row of [claude, codexConta, codexSolta]) expect(motivoLoginIndisponivel(row)).toBeTruthy();
    expect(description('Claude')).toContain(motivoLoginIndisponivel(claude));
    expect(description('Trabalho')).toBe(motivoLoginIndisponivel(codexConta));
    expect(description('Solta')).toBe(motivoLoginIndisponivel(codexSolta));
    root.unmount();
  });
});
