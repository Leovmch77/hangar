import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@hangar/core';

const { memory, calls, failWrites } = vi.hoisted(() => ({
  memory: new Map<string, string>(),
  failWrites: { on: false },
  calls: {
    create: vi.fn(),
    sessions: vi.fn(),
    progress: vi.fn(),
  },
}));

vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => memory.get(key),
    set: (key: string, value: string) => {
      if (failWrites.on) throw new Error('disk full');
      memory.set(key, value);
    },
    remove: (key: string) => { memory.delete(key); },
  }),
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  createSessionForServer: calls.create,
  fetchSessionsForServer: calls.sessions,
  getCreationProgress: calls.progress,
}));

import { useServers } from './servers';
import {
  _resetNewConversationForTests, adoptCandidate, beginAttempt, discardAttempt, recoverAttempt,
  restoreAttempt, useNewConversation,
} from './newConversation';

const serverA = { id: 'server-a', label: 'A', baseUrl: 'http://a', token: 'secret-a' };
const serverB = { id: 'server-b', label: 'B', baseUrl: 'http://b', token: 'secret-b' };
const input = { body: { cwd: '/repo/mobile', provider: 'codex' as const }, text: 'oi' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const httpError = (status: number, message = `${status}: detalhe`) => Object.assign(new Error(message), { status });
const attempt = (serverId = 'server-a') => useNewConversation.getState().attempts[serverId];
const issue = (serverId = 'server-a') => useNewConversation.getState().issues[serverId];
const stored = (serverId = 'server-a') => JSON.parse(memory.get(`create.attempt.v1:${serverId}`)!);

describe('newConversation', () => {
  beforeEach(() => {
    memory.clear();
    failWrites.on = false;
    vi.clearAllMocks();
    _resetNewConversationForTests();
    useServers.setState({ servers: [serverA, serverB], activeId: 'server-b' });
    calls.sessions.mockResolvedValue([]);
    calls.progress.mockResolvedValue({ step: null, params: {} });
  });

  it('persiste body, destino, nome e texto antes do POST e nunca grava token', async () => {
    const create = deferred<SessionInfo>();
    calls.create.mockReturnValue(create.promise);
    void beginAttempt('server-a', input);
    await settle();

    expect(calls.create).toHaveBeenCalledOnce();
    const saved = stored();
    expect(saved).toMatchObject({ serverId: 'server-a', text: 'oi', phase: 'creating', sessionName: null });
    expect(saved.body).toMatchObject({ cwd: '/repo/mobile', provider: 'codex' });
    expect(saved.body.name).toMatch(/^mobile-[a-z0-9]{4}$/);
    expect(calls.create.mock.calls[0][0]).toBe(serverA);
    expect(calls.create.mock.calls[0][1]).toEqual(saved.body);
    expect(JSON.stringify([...memory.values()])).not.toContain('secret');
  });

  it('dois toques e remontagem durante a criação disparam um único POST', async () => {
    const create = deferred<SessionInfo>();
    calls.create.mockReturnValue(create.promise);
    const first = beginAttempt('server-a', input);
    const second = beginAttempt('server-a', { ...input, text: 'outro' });
    await settle();
    expect(restoreAttempt('server-a')?.phase).toBe('creating');
    void beginAttempt('server-a', input);
    await settle();
    expect(calls.create).toHaveBeenCalledOnce();

    create.resolve({ name: stored().body.name, state: 'idle' } as SessionInfo);
    await Promise.all([first, second]);
    expect(attempt()).toMatchObject({ phase: 'created', text: 'oi' });
    await beginAttempt('server-a', input);
    expect(calls.create).toHaveBeenCalledOnce();
  });

  it('evita nome já visível na lista sem depender dela para arbitrar', async () => {
    calls.create.mockImplementation(async (_s, body) => ({ name: body.name, state: 'idle' }));
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1);
    const firstName = `mobile-${`${(1).toString(36)}${(0.1).toString(36).slice(2, 8)}`.slice(-4)}`;
    calls.sessions.mockResolvedValue([{ name: firstName, state: 'idle' }]);
    await beginAttempt('server-a', input);
    expect(attempt()?.sessionName).not.toBe(firstName);
    now.mockRestore(); random.mockRestore();

    _resetNewConversationForTests(); memory.clear();
    calls.sessions.mockRejectedValue(new Error('offline'));
    await beginAttempt('server-a', input);
    expect(calls.create).toHaveBeenCalledTimes(2);
  });

  it('processo reaberto converte creating em create_unknown e não repete o POST', async () => {
    calls.create.mockReturnValue(new Promise(() => {}));
    void beginAttempt('server-a', input);
    await settle();
    const id = stored().id;
    _resetNewConversationForTests();

    await beginAttempt('server-a', input);
    expect(attempt()?.phase).toBe('create_unknown');
    expect(stored()).toMatchObject({ id, phase: 'create_unknown' });
    expect(issue()?.kind).toBe('unknown');
    expect(calls.create).toHaveBeenCalledOnce();
  });

  it('processo reaberto converte sending em send_unknown', () => {
    memory.set('create.attempt.v1:server-a', JSON.stringify({
      id: 'attempt-1', serverId: 'server-a', text: 'oi', phase: 'sending', sessionName: 'repo-mobile',
      body: { name: 'repo-mobile', cwd: '/repo' },
    }));
    expect(restoreAttempt('server-a')).toMatchObject({ phase: 'send_unknown', sessionName: 'repo-mobile', text: 'oi' });
  });

  it.each([
    ['timeout', new Error('A não respondeu em 8s — servidor fora do ar?')],
    ['rede', new TypeError('Network request failed')],
    ['5xx', httpError(502)],
    ['408', httpError(408)],
  ])('create sem resultado conclusivo (%s) fica incerto e não cria outra sessão', async (_label, cause) => {
    calls.create.mockRejectedValue(cause);
    await beginAttempt('server-a', input);
    expect(attempt()?.phase).toBe('create_unknown');
    expect(issue()?.kind).toBe('unknown');
    await beginAttempt('server-a', { ...input, text: 'de novo' });
    expect(calls.create).toHaveBeenCalledOnce();
    expect(attempt()?.text).toBe('oi');
  });

  it('409 mostra a causa e não ganha novo sufixo automaticamente', async () => {
    calls.create.mockRejectedValue(httpError(409, '409: modo de permissao so vale para claude'));
    await beginAttempt('server-a', input);
    const name = attempt()!.body.name;
    expect(attempt()?.phase).toBe('create_unknown');
    expect(issue()).toEqual({ kind: 'conflict', message: '409: modo de permissao so vale para claude' });
    await beginAttempt('server-a', input);
    expect(calls.create).toHaveBeenCalledOnce();
    expect(attempt()?.body.name).toBe(name);
  });

  it('recusa definitiva (cwd inválido) volta ao rascunho editável com o motivo do servidor', async () => {
    calls.create.mockRejectedValueOnce(httpError(400, '400: diretório não existe'));
    await beginAttempt('server-a', input);
    expect(attempt()).toMatchObject({ phase: 'draft', text: 'oi' });
    expect(issue()).toEqual({ kind: 'rejected', message: '400: diretório não existe' });

    calls.create.mockImplementation(async (_s, body) => ({ name: body.name, state: 'idle' }));
    await beginAttempt('server-a', { ...input, body: { ...input.body, cwd: '/repo/outro' } });
    expect(attempt()).toMatchObject({ phase: 'created' });
    expect(attempt()?.body.cwd).toBe('/repo/outro');
    expect(calls.create).toHaveBeenCalledTimes(2);
  });

  it('GET vazio não prova falha: recuperação só consulta e mantém a incerteza', async () => {
    calls.create.mockRejectedValue(httpError(503));
    await beginAttempt('server-a', input);
    calls.sessions.mockClear();

    await recoverAttempt('server-a');
    expect(calls.sessions).toHaveBeenCalledWith(serverA);
    expect(calls.progress).toHaveBeenCalledWith(attempt()!.body.name, serverA);
    expect(attempt()?.phase).toBe('create_unknown');
    expect(issue()?.kind).toBe('not_found');

    calls.progress.mockResolvedValue({ step: 'spawn', params: {} });
    await recoverAttempt('server-a');
    expect(issue()?.kind).toBe('in_progress');

    calls.sessions.mockRejectedValue(new Error('offline'));
    await recoverAttempt('server-a');
    expect(issue()?.kind).toBe('recover_failed');
    expect(calls.create).toHaveBeenCalledOnce();
  });

  it('candidata compatível só vira criada por ação explícita; incompatível é conflito', async () => {
    calls.create.mockRejectedValue(httpError(504));
    await beginAttempt('server-a', input);
    const name = attempt()!.body.name;

    calls.sessions.mockResolvedValue([{ name, cwd: '/outro', provider: 'codex', state: 'idle' }]);
    await recoverAttempt('server-a');
    expect(issue()?.kind).toBe('conflict');
    expect(adoptCandidate('server-a', attempt()!.id)).toBe(false);

    calls.sessions.mockResolvedValue([{ name, cwd: '/repo/mobile', provider: 'codex', state: 'idle' }]);
    await recoverAttempt('server-a');
    expect(issue()?.kind).toBe('candidate');
    expect(attempt()?.phase).toBe('create_unknown');
    expect(adoptCandidate('server-a', 'outra-tentativa')).toBe(false);
    expect(adoptCandidate('server-a', attempt()!.id)).toBe(true);
    expect(attempt()).toMatchObject({ phase: 'created', sessionName: name });
    expect(stored().phase).toBe('created');
  });

  it('destino fica congelado no servidor capturado; troca de máquina não recebe o resultado', async () => {
    const create = deferred<SessionInfo>();
    calls.create.mockReturnValue(create.promise);
    void beginAttempt('server-a', input);
    await settle();
    useServers.setState({ activeId: 'server-a' });
    useServers.setState({ activeId: 'server-b' });
    create.resolve({ name: stored().body.name, state: 'idle' } as SessionInfo);
    await settle();

    expect(attempt('server-a')?.phase).toBe('created');
    expect(attempt('server-b')).toBeUndefined();
    expect(memory.has('create.attempt.v1:server-b')).toBe(false);
  });

  it('resultado antigo não pisa na tentativa nova depois de descartar', async () => {
    calls.create.mockRejectedValueOnce(httpError(500));
    await beginAttempt('server-a', input);
    const old = attempt()!;
    discardAttempt('server-a', old.id);
    expect(memory.has('create.attempt.v1:server-a')).toBe(false);

    const create = deferred<SessionInfo>();
    calls.create.mockReturnValue(create.promise);
    void beginAttempt('server-a', { ...input, text: 'nova' });
    await settle();
    expect(adoptCandidate('server-a', old.id)).toBe(false);
    create.resolve({ name: stored().body.name, state: 'idle' } as SessionInfo);
    await settle();
    expect(attempt()).toMatchObject({ phase: 'created', text: 'nova' });
  });

  it('falha ao gravar no aparelho não dispara POST nem publica tentativa', async () => {
    failWrites.on = true;
    await beginAttempt('server-a', input);
    expect(calls.create).not.toHaveBeenCalled();
    expect(attempt()).toBeUndefined();
    expect(issue()?.kind).toBe('local');
  });

  it('tentativa gravada inválida é descartada com aviso', () => {
    memory.set('create.attempt.v1:server-a', '{"token":"secret"');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(restoreAttempt('server-a')).toBeNull();
    expect(warning).toHaveBeenCalledOnce();
    expect(String(warning.mock.calls[0][0])).not.toContain('secret');
    expect(memory.has('create.attempt.v1:server-a')).toBe(false);
  });
});
