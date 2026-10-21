import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from './prefs';

const { memory } = vi.hoisted(() => ({ memory: new Map<string, string | boolean>() }));
vi.mock('./prefs', () => ({ prefs: {
  getString: (key: string) => {
    const value = memory.get(key);
    return typeof value === 'string' ? value : undefined;
  },
  getBoolean: (key: string) => {
    const value = memory.get(key);
    return typeof value === 'boolean' ? value : undefined;
  },
  set: (key: string, value: string | boolean) => { memory.set(key, value); },
} }));

describe('useTabletPrefs', () => {
  beforeEach(() => { memory.clear(); vi.resetModules(); });

  it('sem nada gravado: bottom e painel aberto', async () => {
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState()).toMatchObject({ placement: 'bottom', panelOpen: true });
  });

  it('valor desconhecido gravado cai em bottom', async () => {
    prefs.set('tablet.sessionsBar', 'meio');
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState().placement).toBe('bottom');
  });

  it.each(['left', 'rail', 'bottom', 'top'] as const)('restaura a posição %s e o painel fechado', async (placement) => {
    prefs.set('tablet.sessionsBar', placement);
    prefs.set('tablet.panelOpen', false);
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState()).toMatchObject({ placement, panelOpen: false });
  });

  it('setPlacement atualiza o estado e grava tablet.sessionsBar para a próxima abertura', async () => {
    const { useTabletPrefs } = await import('./tabletPrefs');
    useTabletPrefs.getState().setPlacement('rail');
    expect(useTabletPrefs.getState().placement).toBe('rail');
    expect(prefs.getString('tablet.sessionsBar')).toBe('rail');
    vi.resetModules();
    const reopened = await import('./tabletPrefs');
    expect(reopened.useTabletPrefs.getState().placement).toBe('rail');
  });

  it('togglePanel alterna o estado e grava tablet.panelOpen', async () => {
    const { useTabletPrefs } = await import('./tabletPrefs');
    useTabletPrefs.getState().togglePanel();
    expect(useTabletPrefs.getState().panelOpen).toBe(false);
    expect(prefs.getBoolean('tablet.panelOpen')).toBe(false);
    useTabletPrefs.getState().togglePanel();
    expect(useTabletPrefs.getState().panelOpen).toBe(true);
    expect(prefs.getBoolean('tablet.panelOpen')).toBe(true);
  });
});
