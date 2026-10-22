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

  it('começa com as duas ordens desligadas e restaura as escolhas independentes', async () => {
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState()).toMatchObject({ tabsWorkingFirst: false, tabsRecentFirst: false });
    useTabletPrefs.getState().setTabsWorkingFirst(true);
    useTabletPrefs.getState().setTabsRecentFirst(true);
    expect(memory.get('tablet.tabsWorkingFirst')).toBe(true);
    expect(memory.get('tablet.tabsRecentFirst')).toBe(true);
    useTabletPrefs.getState().setTabsWorkingFirst(false);
    vi.resetModules();
    const reopened = await import('./tabletPrefs');
    expect(reopened.useTabletPrefs.getState()).toMatchObject({ tabsWorkingFirst: false, tabsRecentFirst: true, placement: 'bottom' });
    reopened.useTabletPrefs.getState().setTabsRecentFirst(false);
    expect(memory.get('tablet.tabsRecentFirst')).toBe(false);
  });

  it('sem nada gravado: bottom, barra expandida e painel aberto', async () => {
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState()).toMatchObject({ placement: 'bottom', collapsed: false, panelOpen: true });
  });

  it('valor desconhecido gravado cai em bottom', async () => {
    prefs.set('tablet.sessionsBar', 'meio');
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState().placement).toBe('bottom');
  });

  it.each(['left', 'bottom', 'top'] as const)('restaura a posição %s e o painel fechado', async (placement) => {
    prefs.set('tablet.sessionsBar', placement);
    prefs.set('tablet.panelOpen', false);
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState()).toMatchObject({ placement, panelOpen: false });
  });

  it('setPlacement atualiza o estado e grava tablet.sessionsBar para a próxima abertura', async () => {
    const { useTabletPrefs } = await import('./tabletPrefs');
    useTabletPrefs.getState().setPlacement('top');
    expect(useTabletPrefs.getState().placement).toBe('top');
    expect(prefs.getString('tablet.sessionsBar')).toBe('top');
    vi.resetModules();
    const reopened = await import('./tabletPrefs');
    expect(reopened.useTabletPrefs.getState().placement).toBe('top');
  });

  it('migra rail para esquerda recolhida e permite expandir depois de reabrir', async () => {
    prefs.set('tablet.sessionsBar', 'rail');
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState()).toMatchObject({ placement: 'left', collapsed: true });
    expect(prefs.getString('tablet.sessionsBar')).toBe('left');
    expect(prefs.getBoolean('tablet.sessionsBarCollapsed')).toBe(true);
    useTabletPrefs.getState().toggleCollapsed();
    vi.resetModules();
    const reopened = await import('./tabletPrefs');
    expect(reopened.useTabletPrefs.getState()).toMatchObject({ placement: 'left', collapsed: false });
  });

  it.each(['left', 'bottom', 'top'] as const)('restaura e alterna recolhimento em %s sem mudar a posição', async placement => {
    prefs.set('tablet.sessionsBar', placement);
    prefs.set('tablet.sessionsBarCollapsed', true);
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState()).toMatchObject({ placement, collapsed: true });
    useTabletPrefs.getState().toggleCollapsed();
    expect(useTabletPrefs.getState()).toMatchObject({ placement, collapsed: false });
    expect(prefs.getBoolean('tablet.sessionsBarCollapsed')).toBe(false);
    useTabletPrefs.getState().toggleCollapsed();
    expect(prefs.getBoolean('tablet.sessionsBarCollapsed')).toBe(true);
    useTabletPrefs.getState().setPlacement(placement === 'left' ? 'top' : 'left');
    expect(useTabletPrefs.getState().collapsed).toBe(true);
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

  it('começa completo e restaura o modo compacto sem alterar a posição ou o recolhimento', async () => {
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState().tabsDetail).toBe('full');
    useTabletPrefs.getState().setTabsDetail('compact');
    expect(prefs.getString('tablet.tabsDetail')).toBe('compact');
    vi.resetModules();
    const reopened = await import('./tabletPrefs');
    expect(reopened.useTabletPrefs.getState()).toMatchObject({ tabsDetail: 'compact', placement: 'bottom', collapsed: false });
  });

  it.each(['compact', 'full'] as const)('preserva o detalhe %s gravado', async tabsDetail => {
    prefs.set('tablet.tabsDetail', tabsDetail);
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState().tabsDetail).toBe(tabsDetail);
  });

  it('detalhe desconhecido gravado cai em completo', async () => {
    prefs.set('tablet.tabsDetail', 'outro');
    const { useTabletPrefs } = await import('./tabletPrefs');
    expect(useTabletPrefs.getState().tabsDetail).toBe('full');
  });
});
