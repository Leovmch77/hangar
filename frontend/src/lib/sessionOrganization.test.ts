import { beforeEach, describe, expect, it, vi } from 'vitest';

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

describe('sessionOrganization', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });
  it('nasce em sessions e persiste conversations', async () => {
    const localStorage = fakeStorage();
    vi.stubGlobal('localStorage', localStorage);
    const { sessionOrganization } = await import('./sessionOrganization.svelte');
    expect(sessionOrganization.mode).toBe('sessions');
    sessionOrganization.mode = 'conversations';
    expect(localStorage.getItem('cp_session_org')).toBe('conversations');
    sessionOrganization.mode = 'sessions';
    expect(localStorage.getItem('cp_session_org')).toBeNull();
  });
});
