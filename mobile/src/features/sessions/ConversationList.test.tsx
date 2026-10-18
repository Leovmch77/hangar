// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import * as m from '../../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  servers: [{ id: 'casa', label: 'Casa', baseUrl: 'http://x', token: 't' }],
  rows: [
    { serverId: 'casa', name: 'sem-terminal', state: 'idle', last_activity: 9, headless: true },
    { serverId: 'casa', name: 'com-terminal', state: 'idle', last_activity: 8, headless: false },
  ],
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../stores/sessions', () => ({
  useSessions: Object.assign((pick: (s: unknown) => unknown) => pick({ rows: state.rows, byServer: [] }), {
    getState: () => ({ byServer: [] }),
  }),
}));
vi.mock('../../stores/servers', () => ({
  useServers: Object.assign((pick: (s: unknown) => unknown) => pick(state), { getState: () => state }),
}));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getArchiveRecentForServer: async () => [],
}));

import { ConversationList } from './ConversationList';

it('conversas vivas mostram o sinal e anunciam sessão sem terminal', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ConversationList, { header: createElement('div'), onClose: () => {} })));
    const headless = host.querySelector('button[aria-label^="sem-terminal,"]');
    const signal = headless?.querySelector(`[role="image"][aria-label="${m.criar_modo_exec_headless()}"]`);
    expect(signal).not.toBeNull();
    expect(headless?.getAttribute('aria-label')).toContain(m.criar_modo_exec_headless());
    expect(signal?.previousElementSibling?.textContent).toBe('sem-terminal');
    const title = signal?.previousElementSibling as HTMLElement;
    expect(title.style.flexGrow).not.toBe('1');
    expect(title.style.flexShrink).toBe('1');
    expect(host.querySelector('button[aria-label^="com-terminal,"] [role="image"]')).toBeNull();
  } finally { act(() => root.unmount()); }
});
