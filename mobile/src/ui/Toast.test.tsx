// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import type { ViewProps } from 'react-native';
import type { ToasterProps } from 'sonner-native';
import * as safeArea from 'react-native-safe-area-context';
import { toast, Toaster } from './Toast';

const boundary = vi.hoisted(() => ({
  toasters: [] as ToasterProps[], views: [] as ViewProps[],
  warning: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('sonner-native', () => ({
  toast: boundary.warning,
  Toaster: (props: ToasterProps) => { boundary.toasters.push(props); return null; },
}));
vi.mock('react-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-native')>(),
  View: (props: ViewProps) => {
    boundary.views.push(props);
    return createElement('div', null, props.children);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('canal passivo fica abaixo do cabeçalho sem captar toques e preserva o toaster padrão', () => {
  const insets = vi.spyOn(safeArea, 'useSafeAreaInsets').mockReturnValue({ top: 44, bottom: 34, left: 0, right: 0 });
  const standardProps: ToasterProps = {
    position: 'bottom-center', offset: 18, duration: 8_000, visibleToasts: 4,
    enableStacking: true, closeButton: true, theme: 'dark', style: { opacity: 0.8 },
  };
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(createElement(Toaster, standardProps)));
    expect(boundary.toasters).toHaveLength(2);
    expect(boundary.toasters[0]).toEqual(standardProps);
    const passive = boundary.toasters[1];
    const message = `automatic-warning.test: ${'detalhes '.repeat(50)}`;
    toast.passive(message);
    expect(boundary.warning).toHaveBeenLastCalledWith(message, { duration: 3_000, toasterId: passive.id });
    expect(passive.id).toBe('passive');
    expect(passive).toMatchObject({ position: 'top-center', offset: 108, visibleToasts: 1, enableStacking: false });
    expect(passive.closeButton).not.toBe(true);
    expect(passive.ToastWrapper).toBeTypeOf('function');

    act(() => root.render(createElement(passive.ToastWrapper!, { toastId: 'fixture', children: message })));
    expect(boundary.views).toHaveLength(1);
    expect(boundary.views[0]).toMatchObject({ pointerEvents: 'none', collapsable: false, style: { width: '100%' }, children: message });

    insets.mockReturnValue({ top: 20, bottom: 0, left: 0, right: 0 });
    act(() => root.render(createElement(Toaster, standardProps)));
    expect(boundary.toasters[2]).toEqual(standardProps);
    expect(boundary.toasters[3].offset).toBe(84);
    expect(boundary.toasters[3].ToastWrapper).toBe(passive.ToastWrapper);

    toast.aviso(message);
    expect(boundary.warning).toHaveBeenLastCalledWith(message, { duration: 12_000 });
    toast.ok(message);
    expect(boundary.warning.success).toHaveBeenLastCalledWith(message);
    toast.erro(message);
    expect(boundary.warning.error).toHaveBeenLastCalledWith(message);
    toast.mod('fixture-detail', 'fixture-mod', 9_000);
    expect(boundary.warning).toHaveBeenLastCalledWith('fixture-mod', expect.objectContaining({ duration: 9_000, description: 'fixture-detail' }));
    expect(boundary.warning.mock.lastCall?.[1]).not.toHaveProperty('toasterId');
  } finally {
    act(() => root.unmount());
    insets.mockRestore();
  }
});
