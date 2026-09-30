// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { configureApi } from '@hangar/core';
import type { AggSession, ChatEvent } from '@hangar/core';
import { montarFeed } from './pairFeed';

const route = vi.hoisted(() => ({ server: 's1', name: 'a' }));
const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => route,
  useRouter: () => navigation,
}));
vi.mock('expo-secure-store', () => ({ setItemAsync: vi.fn(async () => {}), getItemAsync: vi.fn(async () => null) }));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  Alert: { alert: (_title: string, _message: unknown, buttons: { style?: string; onPress?: () => void }[]) => buttons.find((button) => button.style === 'destructive')?.onPress?.() },
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('article', { 'data-markdown': true }, markdown),
}));
// O formatador visual puxa módulos nativos do chat que não participam da leitura do par.
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({}) }));
vi.mock('../../paraglide/messages', () => Object.fromEntries(
  ('par_conversa_titulo par_sem_historico comum_carregando par_vazio_trocas par_parear_titulo par_passam_hint forward_nenhuma_viva par_parear_aria par_tarefa_placeholder par_pareando par_parear_nomes par_escolha_varias '
    + 'par_grupo_titulo par_membros_hint par_abrir_conversa_de par_adicionar_sessao par_vazio_fora_grupo par_adicionar_aria par_adicionando par_adicionar_nomes par_escolha_sessoes par_saindo par_sair_grupo '
    + 'forward_nao_listou par_contrato_falhou par_contrato_titulo par_falhou_pareamento par_falhou_saida comandos_confirmar comum_cancelar comum_confirmar compare_servidor_nao_encontrado comum_voltar')
    .split(' ').map((key) => [key, () => key]),
));

import PairSheet from '../../../app/s/[server]/[name]/pair';
import { useServers } from '../../stores/servers';
import { useSessions } from '../../stores/sessions';

const servers = [
  { id: 's1', label: 'A', baseUrl: 'http://a.local', token: 'token-a' },
  { id: 's2', label: 'B', baseUrl: 'http://b.local', token: 'token-b' },
];
const roots: ReturnType<typeof createRoot>[] = [];
let fetchMock: MockInstance<typeof fetch>;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function renderPair(element = createElement(PairSheet)) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(label))!;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  route.server = 's1'; route.name = 'a';
  navigation.back.mockClear(); navigation.push.mockClear();
  useServers.setState({ servers, activeId: 's2', ready: true });
  useSessions.setState({ rows: servers.map<AggSession>((server) => ({ name: 'a', state: 'idle', serverId: server.id, serverLabel: server.label, serverColor: '#00f', pair_peers: ['b'] })) });
  configureApi({
    getBaseUrl: () => useServers.getState().active()!.baseUrl,
    getToken: () => useServers.getState().active()!.token,
    onUnauthorized: () => {}, origin: null, createEventSource: () => { throw new Error('SSE inesperado'); },
  });
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).endsWith('/api/sessions')) return response([{ name: 'b', state: 'idle' }, { name: 'c', state: 'idle' }]);
    if (String(url).endsWith('/contract')) return response({ peers: ['b'], path: '/repo/contract.md', content: '# Contrato A' });
    return response([]);
  });
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  fetchMock.mockRestore();
});

function user(id: string, text: string, ts: number): ChatEvent {
  return { kind: 'user_msg', id, text, ts };
}

describe('montarFeed', () => {
  it('filtra recados de outros membros, ordena e mantém só os 40 mais recentes', () => {
    const historyA = Array.from({ length: 42 }, (_, i) => user(`a-${i}`, `[de: b] recado ${i}`, i + 1));
    historyA.push(user('self', '[de: a] não é recado de outro membro', 100));
    historyA.push({ kind: 'assistant_msg', id: 'assistant', text: '[de: b] não é user_msg', ts: 101 });

    const result = montarFeed(
      ['a', 'b'],
      [
        { ok: true, h: historyA },
        { ok: true, h: [user('b-1', 'mensagem normal', 2)] },
      ],
    );

    expect(result.failed).toEqual([]);
    expect(result.feed).toHaveLength(40);
    expect(result.feed[0]).toEqual({ from: 'b', to: 'a', text: 'recado 2', ts: 3 });
    expect(result.feed.at(-1)).toEqual({ from: 'b', to: 'a', text: 'recado 41', ts: 42 });
  });

  it('devolve os membros cujo histórico falhou sem tratar falha como conversa vazia', () => {
    const result = montarFeed(
      ['a', 'b', 'c'],
      [
        { ok: false, h: [] },
        { ok: true, h: [user('b-1', '[grupo: c] chegou', 20)] },
        { ok: false, h: [] },
      ],
    );

    expect(result.failed).toEqual(['a', 'c']);
    expect(result.feed).toEqual([{ from: 'c', to: 'b', text: 'chegou', ts: 20 }]);
  });
});

it('mantém GET e pareamento no servidor da rota quando outro está ativo', async () => {
  useSessions.setState({ rows: [] });
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? response({ ok: true, warning: null })
    : response([{ name: 'b', state: 'idle' }]));
  const { container } = await renderPair();
  await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  await act(async () => button(container, 'par_parear_nomes').click());
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    'http://a.local/api/sessions', 'http://a.local/api/sessions/a/pair',
  ]);
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer token-a' }, body: '{"peers":["b"],"task":"","replace_task":false}' });
  expect(navigation.back).toHaveBeenCalledOnce();
});

it('descarta lista, histórico e contrato tardios após trocar de rota', async () => {
  const pending = new Map<string, (value: Response) => void>();
  fetchMock.mockImplementation((url) => String(url).startsWith('http://a.local')
    ? new Promise<Response>((resolve) => { pending.set(String(url), resolve); })
    : Promise.resolve(String(url).endsWith('/api/sessions')
      ? response([{ name: 'b', state: 'idle' }])
      : String(url).endsWith('/contract')
        ? response({ peers: ['b'], path: '/b/contract.md', content: '# Contrato B' })
        : response([user('b', '[de: b] mensagem B', 2)])));
  const { container, root } = await renderPair();
  expect(container.textContent).toContain('comum_carregando');
  expect(container.textContent).not.toContain('par_vazio_trocas');
  useServers.setState({ activeId: 's1' });
  route.server = 's2';
  await act(async () => root.render(createElement(PairSheet)));
  expect(container.textContent).toContain('# Contrato B');
  expect(container.textContent).toContain('mensagem B');
  await act(async () => {
    for (const [url, resolve] of pending) resolve(url.endsWith('/contract')
      ? response({ peers: ['b'], path: '/a/contract.md', content: '# Contrato antigo' })
      : url.endsWith('/api/sessions') ? response([{ name: 'intruso', state: 'idle' }])
        : response([user('a', '[de: b] mensagem antiga', 1)]));
  });
  expect(container.textContent).not.toContain('Contrato antigo');
  expect(container.textContent).not.toContain('mensagem antiga');
  expect(container.textContent).not.toContain('intruso');
  expect(container.textContent).not.toContain('comum_carregando');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="par_abrir_conversa_de"]')!.click());
  expect(navigation.push).toHaveBeenLastCalledWith('/s/s2/b');
});

it('mostra erros de fonte e contrato sem afirmar que o histórico falho está vazio', async () => {
  fetchMock.mockImplementation(async () => response({ detail: 'fora do ar' }, 500));
  const { container } = await renderPair();
  expect(container.textContent).toContain('forward_nao_listou');
  expect(container.textContent).toContain('par_sem_historico');
  expect(container.textContent).toContain('par_contrato_falhou');
  expect(container.textContent).not.toContain('par_vazio_trocas');
  expect(container.textContent).not.toContain('comum_carregando');
});

it('mantém saída no servidor original e ignora confirmação tardia na nova rota', async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') return new Promise<Response>((resolve) => { finish = resolve; });
    if (String(url).endsWith('/api/sessions')) return response([{ name: 'b', state: 'idle' }]);
    if (String(url).endsWith('/contract')) return response({ peers: ['b'], path: '', content: '' });
    return response([]);
  });
  const { container, root } = await renderPair();
  await act(async () => button(container, 'par_sair_grupo').click());
  expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')).toEqual([
    'http://a.local/api/sessions/a/pair', expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ Authorization: 'Bearer token-a' }) }),
  ]);
  route.server = 's2';
  await act(async () => root.render(createElement(PairSheet)));
  await act(async () => finish(response({ ok: true, warning: null })));
  expect(navigation.back).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('par_saindo');
});

it('não usa o servidor ativo como substituto quando a rota aponta para um removido', async () => {
  route.server = 'removido';
  const { container } = await renderPair();
  expect(container.textContent).toContain('compare_servidor_nao_encontrado');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('não envia saída quando o diálogo antigo é confirmado depois de trocar de rota', async () => {
  let confirm: () => void = () => { throw new Error('confirmação não capturada'); };
  const alert = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    confirm = buttons!.find((candidate) => candidate.style === 'destructive')!.onPress!;
  });
  try {
    const { container, root } = await renderPair();
    await act(async () => button(container, 'par_sair_grupo').click());
    route.server = 's2';
    await act(async () => root.render(createElement(PairSheet)));
    await act(async () => confirm());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(navigation.back).not.toHaveBeenCalled();
  } finally {
    alert.mockRestore();
  }
});

it('finaliza carga de contrato ausente e mostra conversa vazia só após os GET', async () => {
  fetchMock.mockImplementation(async (url) => String(url).endsWith('/contract')
    ? response({ peers: ['b'], path: '', content: '' }) : response([]));
  const { container } = await renderPair();
  expect(container.textContent).toContain('par_vazio_trocas');
  expect(container.textContent).not.toContain('par_contrato_titulo');
  expect(container.textContent).not.toContain('comum_carregando');
});
