/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Server } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ readGroupIdentity: vi.fn() }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...api }));

import { useIdentities } from './identities';

let root: Root | null = null;
let seen: ReturnType<typeof useIdentities> | null = null;
function Probe({ servers }: { servers: Server[] }) {
  seen = useIdentities(servers);
  return null;
}
async function mount(servers: Server[]) {
  const el = document.createElement('div');
  root = createRoot(el);
  await act(async () => { root!.render(React.createElement(Probe, { servers })); });
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const server = (id: string) => ({ id, label: id, baseUrl: `http://${id}`, token: 't' }) as Server;

afterEach(() => { act(() => root?.unmount()); root = null; api.readGroupIdentity.mockReset(); vi.useRealTimers(); });

describe('useIdentities', () => {
  it('falha relê sozinha depois de 30 s e para quando tudo foi lido', async () => {
    vi.useFakeTimers();
    api.readGroupIdentity.mockRejectedValueOnce(new Error('rede')).mockResolvedValue('casa');
    await mount([server('retry-a')]);
    await settle();
    expect(seen!.identities.has('retry-a')).toBe(false);
    expect(seen!.loading.has('retry-a')).toBe(false);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await settle();
    expect(seen!.identities.get('retry-a')).toBe('casa');
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(api.readGroupIdentity).toHaveBeenCalledTimes(2);
  });

  it('identificador vazio é falha e é relido no mesmo intervalo', async () => {
    vi.useFakeTimers();
    api.readGroupIdentity.mockRejectedValueOnce(Object.assign(new Error('machine_identity_empty'), { name: 'vazio' })).mockResolvedValue('lab');
    await mount([server('empty-b')]);
    await settle();
    expect(seen!.loading.has('empty-b')).toBe(false);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await settle();
    expect(seen!.identities.get('empty-b')).toBe('lab');
  });

  it('desmontada, não relê', async () => {
    vi.useFakeTimers();
    api.readGroupIdentity.mockRejectedValue(new Error('rede'));
    await mount([server('gone-c')]);
    await settle();
    act(() => root!.unmount());
    root = null;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(api.readGroupIdentity).toHaveBeenCalledTimes(1);
  });
});
