import { beforeEach, describe, expect, it, vi } from 'vitest';

const srv = { id: 'pc', label: 'PC', baseUrl: 'http://pc:8765', token: 't' };
const core = vi.hoisted(() => ({
  createSessionForServer: vi.fn(), sendInputForServer: vi.fn(), fetchSessionsForServer: vi.fn(),
  getCodexAccountsForServer: vi.fn(), getFolderBranchesForServer: vi.fn(), getRootsForServer: vi.fn(),
  listClaudeConfigs: vi.fn(), getClaudeAccountSuggestion: vi.fn(), getProviders: vi.fn(), modelOptions: vi.fn(),
}));
vi.mock('@hangar/core', async (orig) => ({ ...(await orig<object>()), ...core }));
vi.mock('./auth', () => ({ listOwnServers: () => [srv], selectServer: vi.fn(() => true), getActiveId: () => 'pc' }));

import { createNewChatDraft, isNotRepo } from './newChatDraft.svelte';

function never() { return new Promise(() => {}); }

// vitest roda em node, sem localStorage.
function fakeStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

describe('NewChatDraft.send', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('localStorage', fakeStorage({ 'cp_newchat_cwd:pc': '/home/u/proj' }));
    for (const fn of [core.getProviders, core.getRootsForServer, core.listClaudeConfigs, core.getFolderBranchesForServer])
      fn.mockImplementation(never);
  });

  it('cria com o nome desempatado e envia no nome devolvido pelo backend', async () => {
    core.fetchSessionsForServer.mockResolvedValue([{ name: 'proj' }]);
    core.createSessionForServer.mockResolvedValue({ name: 'proj-3' });
    core.sendInputForServer.mockResolvedValue(undefined);
    const draft = createNewChatDraft();
    draft.init();

    const r = await draft.send('oi');

    expect(core.createSessionForServer).toHaveBeenCalledWith(srv, expect.objectContaining({
      name: 'proj-2', cwd: '/home/u/proj', provider: 'claude' }));
    expect(core.sendInputForServer).toHaveBeenCalledWith(srv, 'proj-3', 'oi');
    expect(r).toEqual({ serverId: 'pc', name: 'proj-3' });
  });

  it('envio que falha depois de criar: tentar de novo reenvia na mesma sessão', async () => {
    core.fetchSessionsForServer.mockResolvedValue([]);
    core.createSessionForServer.mockResolvedValue({ name: 'proj' });
    core.sendInputForServer.mockRejectedValueOnce(new Error('500: caiu')).mockResolvedValueOnce(undefined);
    const draft = createNewChatDraft();
    draft.init();

    await expect(draft.send('oi')).rejects.toThrow('caiu');
    expect(draft.note?.text).toBe('500: caiu');
    await draft.send('oi');

    expect(core.createSessionForServer).toHaveBeenCalledTimes(1);
    expect(core.sendInputForServer).toHaveBeenLastCalledWith(srv, 'proj', 'oi');
  });

  it('sem pasta não cria nada', async () => {
    localStorage.removeItem('cp_newchat_cwd:pc');
    const draft = createNewChatDraft();
    draft.init();
    await expect(draft.send('oi')).rejects.toThrow();
    expect(core.createSessionForServer).not.toHaveBeenCalled();
  });
});

describe('isNotRepo', () => {
  it('404 e 409 "not a git repository" não são falha; outro 409 é', () => {
    expect(isNotRepo(Object.assign(new Error('404: x'), { status: 404 }))).toBe(true);
    expect(isNotRepo(Object.assign(new Error('409: fatal: not a git repository'), { status: 409 }))).toBe(true);
    expect(isNotRepo(Object.assign(new Error('409: outra coisa'), { status: 409 }))).toBe(false);
    expect(isNotRepo(new Error('rede'))).toBe(false);
  });
});
