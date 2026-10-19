// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { TextInputProps, TextProps, ViewProps } from 'react-native';
import { ComposerDock, ComposerInput, ComposerViewport } from './ComposerField';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const native = vi.hoisted(() => ({
  input: null as TextInputProps | null,
  measure: null as TextProps | null,
  viewport: null as ViewProps | null,
  dock: null as ViewProps | null,
  renders: 0,
  width: 390, height: 844,
}));
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return { ...actual,
    StyleSheet: { ...actual.StyleSheet, flatten: (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) },
    useWindowDimensions: () => ({ width: native.width, height: native.height, scale: 3, fontScale: 1 }),
    TextInput: (props: TextInputProps) => {
      native.renders++;
      native.input = props;
      return createElement('textarea', { value: props.value, readOnly: true,
        style: Object.assign({}, ...([props.style] as unknown[]).flat(Infinity).filter(Boolean)) });
    },
    Text: (props: TextProps) => { native.measure = props; return null; },
    View: (props: ViewProps) => {
      if (props.testID === 'composer-viewport') native.viewport = props;
      if (props.testID === 'chat-dock') native.dock = props;
      return createElement('div', null, props.children);
    },
  };
});
vi.mock('@react-native-menu/menu', () => ({ MenuView: () => null }));
vi.mock('../ui/Glass', () => ({ Glass: () => null }));
vi.mock('../ui/RecordingWave', () => ({ RecordingWave: () => null }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));

let root: Root;
const render = (value: string, recording = false) => act(() => root.render(createElement(ComposerInput, {
  value, recording, rms: { value: 0 } as never, onCancelRecording: () => {},
})));
function mount(value: string, viewport = false) {
  native.measure = null;
  native.width = 390; native.height = 844;
  const container = document.createElement('div');
  root = createRoot(container);
  if (viewport) act(() => root.render(createElement(ComposerViewport, null, createElement(ComposerInput, {
    value, recording: false, rms: { value: 0 } as never, onCancelRecording: () => {},
  }))));
  else render(value);
  return container.querySelector('textarea')!;
}
function measure(height: number) {
  expect(native.measure?.onLayout).toBeTypeOf('function');
  act(() => native.measure!.onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 342, height } } } as never));
}
afterEach(() => act(() => root.unmount()));

it('texto programático cresce mesmo sem novo evento de tamanho do campo nativo', () => {
  const input = mount('curto');
  measure(40);
  render('Texto ditado longo\n'.repeat(10));
  measure(256);
  expect(input.style.height).toBe('256px');
  expect(native.input?.scrollEnabled).toBe(true);
  const renders = native.renders;
  // Um evento atrasado do input não desfaz a medida nem acrescenta uma renderização.
  act(() => native.input!.onContentSizeChange!({ nativeEvent: { contentSize: { width: 342, height: 40 } } } as never));
  expect(input.style.height).toBe('256px');
  expect(native.renders).toBe(renders);
  render('curto');
  measure(40);
  expect(input.style.height).toBe('40px');
});

it('limita texto longo a 40% da janela, recalcula na rotação e conserva o mesmo campo', () => {
  const input = mount('linha\n'.repeat(30));
  measure(736);
  expect(input.style.height).toBe('337.6px');
  native.width = 844; native.height = 390;
  render('linha\n'.repeat(30));
  expect(input.style.height).toBe('156px');
  expect(input.parentElement?.querySelector('textarea')).toBe(input);
});

it('mede também a linha vazia final e restaura a altura após gravar, sem remontar', () => {
  const input = mount('linha\n');
  expect(native.measure?.children).toBe('linha\n\u200b');
  measure(64);
  render('linha\n', true);
  expect(input.style.height).toBe('0px');
  render('linha\n');
  expect(input.style.height).toBe('64px');
  expect(native.input?.editable).toBe(true);
});

it('o espaço real abaixo do cabeçalho reduz o campo com o teclado aberto', () => {
  const input = mount('linha\n'.repeat(30), true);
  measure(736);
  act(() => native.viewport!.onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 364 } } } as never));
  expect(parseFloat(input.style.height)).toBeCloseTo(218.4);
  act(() => native.viewport!.onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } } as never));
  expect(input.style.height).toBe('337.6px');
  expect(input.parentElement?.querySelector('textarea')).toBe(input);
});

it.each([0, 24])('medida transitória de %s mantém o campo com pelo menos 40 pontos', (height) => {
  const input = mount('linha\n'.repeat(30), true);
  measure(736);
  act(() => native.viewport!.onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } } as never));
  expect(input.style.height).toBe('40px');
});

it('espelho mede com a mesma fonte, tamanho e entrelinha personalizados do campo', () => {
  const input = mount('texto');
  act(() => root.render(createElement(ComposerInput, {
    value: 'texto', mono: true, style: { fontFamily: 'custom-font', fontSize: 22, lineHeight: 30 },
    recording: false, rms: { value: 0 } as never, onCancelRecording: () => {},
  })));
  const style = Object.assign({}, ...([native.measure!.style] as unknown[]).flat(Infinity).filter(Boolean));
  expect(style.fontFamily).toBe(input.style.fontFamily);
  expect(style.fontSize).toBe(22);
  expect(style.lineHeight).toBe(30);
});

it('dock reserva 96 pontos da área útil para a conversa, mesmo com fila e anexos', () => {
  mount('texto');
  act(() => root.render(createElement(ComposerViewport, null, createElement(ComposerDock, null, 'fila-anexos'))));
  act(() => native.viewport!.onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 364 } } } as never));
  const style = Object.assign({}, ...([native.dock!.style] as unknown[]).flat(Infinity).filter(Boolean));
  expect(style.maxHeight).toBe(268);
});

it.each([0, 24])('dock e campo preservam altura visível durante medida transitória de %s', (height) => {
  mount('texto');
  act(() => root.render(createElement(ComposerViewport, null, createElement(ComposerDock, null,
    createElement(ComposerInput, { value: 'linha\n'.repeat(30), recording: false,
      rms: { value: 0 } as never, onCancelRecording: () => {} })))));
  measure(736);
  act(() => native.viewport!.onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } } as never));
  const style = Object.assign({}, ...([native.dock!.style] as unknown[]).flat(Infinity).filter(Boolean));
  expect(style.maxHeight).toBe(96);
  const inputStyle = Object.assign({}, ...([native.input!.style] as unknown[]).flat(Infinity).filter(Boolean));
  expect(inputStyle.height).toBe(40);
});
