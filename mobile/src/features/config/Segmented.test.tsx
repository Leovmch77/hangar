// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Pressable, Text } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Segmented } from './Segmented';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Captura antes do mock DOM, que descarta numberOfLines.
vi.mock('react-native', async (original) => {
  const native = await original<typeof import('react-native')>();
  return { ...native, Text: vi.fn(native.Text), Pressable: vi.fn(native.Pressable) };
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => { await act(async () => root.unmount()); });

const flattenStyle = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

it('permite quebrar rótulos longos sem corte e selecionar a opção correta', async () => {
  const options = [
    { v: 'none', label: 'Sem organização' },
    { v: 'harness', label: 'Harness da conversa' },
    { v: 'external_api', label: 'API externa' },
  ];
  const onChange = vi.fn();
  await act(async () => root.render(createElement(Segmented, {
    options, value: 'none', onChange, label: 'Organização',
  })));

  const texts = vi.mocked(Text).mock.calls.map(([props]) => props);
  const buttons = vi.mocked(Pressable).mock.calls.map(([props]) => props);
  expect(texts.map((props) => props.children)).toEqual(options.map((option) => option.label));
  expect(texts.map((props) => props.numberOfLines ?? 0)).toEqual([0, 0, 0]);
  for (const props of texts) {
    const style = flattenStyle(props.style);
    expect(style.textAlign).toBe('center');
    expect(style.fontSize).toBe(15);
    expect(style.height).toBeUndefined();
    expect(style.maxHeight).toBeUndefined();
    expect(props.adjustsFontSizeToFit).not.toBe(true);
  }
  for (const props of buttons) {
    const raw = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
    const style = flattenStyle(raw);
    expect(style.height).toBeUndefined();
    expect(style.maxHeight).toBeUndefined();
    expect(style.minHeight).toBeGreaterThanOrEqual(36);
    expect(style.paddingVertical).toBeGreaterThanOrEqual(4);
    expect(style.paddingVertical).toBeLessThanOrEqual(10);
  }

  const longLabel = [...container.querySelectorAll('span')].find((el) => el.textContent === 'Harness da conversa')!;
  await act(async () => longLabel.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith('harness');
});
