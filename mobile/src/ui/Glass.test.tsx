// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Glass } from './Glass';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
  const native = await importOriginal<typeof import('react-native')>();
  return { ...native, Platform: { ...native.Platform, OS: 'ios' } };
});
vi.mock('react-native-unistyles', async (importOriginal) => {
  const unistyles = await importOriginal<typeof import('react-native-unistyles')>();
  return { ...unistyles, StyleSheet: {
    ...unistyles.StyleSheet,
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)),
    absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  } };
});
vi.mock('expo-blur', () => ({ BlurView: () => null }));
const material = vi.hoisted(() => ({ style: {} as ViewStyle }));
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => true,
  GlassView: ({ style }: { style: StyleProp<ViewStyle> }) => {
    material.style = StyleSheet.flatten<ViewStyle>(style);
    return null;
  },
}));

let root: Root | undefined;
afterEach(() => { if (root) act(() => root?.unmount()); root = undefined; });

async function render(style?: StyleProp<ViewStyle>) {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root!.render(createElement(Glass, { variant: 'chrome', style }, createElement('span', null, 'conteudo'))));
  return container.firstElementChild as HTMLElement;
}

describe('curvatura do material Glass', () => {
  it.each([
    { name: 'padrão', style: undefined, corners: [11, 11, 11, 11] },
    { name: 'composer', style: { borderRadius: 22 }, corners: [21, 21, 21, 21] },
    { name: 'nova-conversa', style: { borderRadius: 26 }, corners: [25, 25, 25, 25] },
    { name: 'fila', style: { borderRadius: 0, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomWidth: 0 }, corners: [15, 15, 0, 0] },
    { name: 'cabeçalho', style: { borderRadius: 0, borderWidth: 0 }, corners: [0, 0, 0, 0] },
    { name: 'gaveta', style: { borderRadius: 0, borderWidth: 0, borderRightWidth: 0.5 }, corners: [0, 0, 0, 0] },
    { name: 'sem-borda', style: { borderRadius: 18, borderWidth: 0 }, corners: [18, 18, 18, 18] },
  ])('desenha $name com os raios da área interna, sem mover o material', async ({ style, corners }) => {
    await render(style);
    expect([
      material.style.borderTopLeftRadius, material.style.borderTopRightRadius,
      material.style.borderBottomRightRadius, material.style.borderBottomLeftRadius,
    ]).toEqual(corners);
    expect(material.style).toMatchObject({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('mantém a borda do recipiente e passa a curva escolhida ao material', async () => {
    const box = await render([{ borderRadius: 22 }, { borderColor: 'red', borderCurve: 'continuous' }]);
    expect(box.style.borderWidth).toBe('1px');
    expect(box.style.borderColor).toBe('red');
    expect(box.style.borderRadius).toBe('22px');
    expect(box.textContent).toBe('conteudo');
    expect(material.style.borderCurve).toBe('continuous');
  });
});
