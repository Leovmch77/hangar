// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
const servers = vi.hoisted(() => ({ activeId: 's2', servers: [] as Server[] }));
vi.mock('@hangar/core', () => ({ getCodexPermissions: api.get, setCodexPermission: api.set }));
vi.mock('../../stores/servers', () => ({
  useServers: (select: (state: typeof servers) => unknown) => select(servers),
}));
vi.mock('../../paraglide/messages', () => ({
  comum_falha_aplicar: () => 'comum_falha_aplicar',
  servidor_nao_existe: () => 'servidor_nao_existe',
  chat_servidor_removido: () => 'chat_servidor_removido',
}));

import { useCodexApproval } from './codexApproval';

const catalog = {
  current: 'Ask for approval',
  modes: [
    { numero: 1, nome: 'Ask for approval', desc: 'Ask before running commands', cursor: true, atual: true },
    { numero: 2, nome: 'Full Access', desc: 'Run commands without approval', cursor: false, atual: false },
  ],
};
let approval: ReturnType<typeof useCodexApproval>;
const roots: Root[] = [];
function Harness(props: Parameters<typeof useCodexApproval>[0]) {
  approval = useCodexApproval(props);
  return createElement('div', null,
    createElement('output', { 'data-testid': 'error' }, approval.error),
    createElement('output', { 'data-testid': 'notice' }, approval.notice));
}
async function mount(serverId = 's1', headless = true) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(createElement(Harness, { serverId, name: 'fixture-codex', headless, enabled: true })); });
  return container;
}

beforeEach(() => {
  vi.resetAllMocks();
  servers.servers = [
    { id: 's1', label: 'A', baseUrl: 'https://a.test', token: 'token-a' },
    { id: 's2', label: 'B', baseUrl: 'https://b.test', token: 'token-b' },
  ];
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
});

describe('aprovação do Codex — falhas de leitura e confirmação', () => {
  it.each([
    { failure: new Error('leitura inicial falhou'), message: 'leitura inicial falhou' },
    { failure: null, message: 'comum_falha_aplicar' },
  ])('expõe a falha inicial em error: $message', async ({ failure, message }) => {
    api.get.mockRejectedValueOnce(failure);
    const container = await mount();

    expect(api.get).toHaveBeenCalledExactlyOnceWith('fixture-codex', servers.servers[0]);
    expect(approval.current).toBeNull();
    expect(approval.error).toBe(message);
    expect(container.querySelector('[data-testid="error"]')!.textContent).toBe(message);
  });

  it('não conserva o modo antigo após troca falhar e expõe também a falha da releitura', async () => {
    let rejectRead!: (error: Error) => void;
    const reread = new Promise((_, reject) => { rejectRead = reject; });
    api.get.mockResolvedValueOnce(catalog).mockReturnValueOnce(reread);
    api.set.mockRejectedValueOnce(new Error('troca falhou'));
    const container = await mount('s1', false);
    await act(async () => { await approval.load(); });
    expect(approval.current).toBe('Ask for approval');
    expect(approval.modes).toEqual(catalog.modes.map((mode) => ({ name: mode.nome, desc: mode.desc })));

    let selection!: Promise<boolean>;
    await act(async () => { selection = approval.select('Full Access'); });
    const currentWhileReading = approval.current;
    await act(async () => { rejectRead(new Error('releitura falhou')); await selection; });

    expect(api.set).toHaveBeenCalledExactlyOnceWith('fixture-codex', 'Full Access', servers.servers[0]);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(await selection).toBe(false);
    expect(currentWhileReading).toBeNull();
    expect(approval.current).toBeNull();
    expect(container.textContent).toContain('troca falhou');
    expect(container.textContent).toContain('releitura falhou');
    expect(approval.loading).toBe(false);
    expect(approval.applying).toBe(false);
  });

  it('uma nova load bem-sucedida confirma o modo e limpa o erro da leitura inicial', async () => {
    api.get.mockRejectedValueOnce(new Error('leitura inicial falhou')).mockResolvedValueOnce(catalog);
    const container = await mount();
    const initialError = approval.error;

    await act(async () => { await approval.load(); });

    expect(initialError).toBe('leitura inicial falhou');
    expect(approval.current).toBe('Ask for approval');
    expect(approval.error).toBeNull();
    expect(approval.notice).toBeNull();
    expect(container.textContent).toBe('');
    expect(approval.loading).toBe(false);
  });

  it('sem servidor mantém chat_servidor_removido após load e não chama a API', async () => {
    const container = await mount('removed');
    const initialError = approval.error;

    await act(async () => { await approval.load(); });

    expect(initialError).toBe('chat_servidor_removido');
    expect(approval.error).toBe('chat_servidor_removido');
    expect(container.querySelector('[data-testid="error"]')!.textContent).toBe('chat_servidor_removido');
    expect(approval.current).toBeNull();
    expect(approval.modes).toBeNull();
    expect(approval.loading).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
  });
});
