import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('sessionOrganization', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });
  it('nasce em sessions e persiste conversations', async () => {
    const { sessionOrganization } = await import('./sessionOrganization.svelte');
    expect(sessionOrganization.mode).toBe('sessions');
    sessionOrganization.mode = 'conversations';
    expect(localStorage.getItem('cp_session_org')).toBe('conversations');
    sessionOrganization.mode = 'sessions';
    expect(localStorage.getItem('cp_session_org')).toBeNull();
  });
});
