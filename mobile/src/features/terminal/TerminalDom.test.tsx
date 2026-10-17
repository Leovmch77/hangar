// @vitest-environment happy-dom
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DOMImperativeFactory } from 'expo/dom';
import TerminalDom, { type TerminalDomHandle, type TerminalDomProps } from './TerminalDom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const xterm = vi.hoisted(() => ({ instances: [] as any[], observe: vi.fn(), disconnect: vi.fn(), resize: undefined as (() => void) | undefined }));
vi.mock('expo/dom', async () => {
  const { useImperativeHandle } = await import('react');
  return { useDOMImperativeHandle: useImperativeHandle };
});
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24;
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    open = vi.fn(); dispose = vi.fn(); write = vi.fn(); focus = vi.fn();
    resize = vi.fn((cols: number, rows: number) => { this.cols = cols; this.rows = rows; });
    data?: (data: string) => void;
    binary?: (data: string) => void;
    offData = vi.fn(); offBinary = vi.fn();
    constructor(public options: Record<string, any>) { xterm.instances.push(this); }
    loadAddon = vi.fn((addon: any) => { addon.term = this; });
    onData = (fn: (data: string) => void) => { this.data = fn; return { dispose: this.offData }; };
    onBinary = (fn: (data: string) => void) => { this.binary = fn; return { dispose: this.offBinary }; };
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  term: any;
  fit = vi.fn();
  proposeDimensions = () => ({ cols: 8, rows: 2 });
  dispose = vi.fn();
} }));

let root: Root;
let host: HTMLDivElement;
const ref = createRef<TerminalDomHandle>();
const props = (): TerminalDomProps => ({ ref, foreground: '#ededed', cursor: '#7799ff', fontSize: 13, connected: false,
  onReady: vi.fn(async () => {}), onResize: vi.fn(async () => {}), onData: vi.fn(async () => {}), onError: vi.fn(async () => {}) });
beforeEach(() => {
  xterm.instances = [];
  xterm.observe.mockClear(); xterm.disconnect.mockClear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { xterm.resize = callback; }
    observe = xterm.observe; disconnect = xterm.disconnect;
  });
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('monta xterm acessível e transparente, cala OSC de cor, ajusta grade limitada e limpa recursos', async () => {
  const p = props();
  await act(async () => root.render(<TerminalDom {...p} />));
  expect(xterm.instances).toHaveLength(1);
  const term = xterm.instances[0];
  expect(term.options).toMatchObject({ allowTransparency: true, theme: { background: 'rgba(0, 0, 0, 0)', foreground: '#ededed', cursor: '#7799ff' },
    fontFamily: 'monospace', fontSize: 13, convertEol: false, screenReaderMode: true, disableStdin: true });
  expect(term.parser.registerOscHandler.mock.calls.map(([osc]: [number]) => osc)).toEqual([4, 10, 11, 12, 52]);
  for (const [, handler] of term.parser.registerOscHandler.mock.calls) expect(handler('query')).toBe(true);
  expect(term.resize).toHaveBeenLastCalledWith(20, 5);
  expect(p.onReady).toHaveBeenCalledWith(20, 5);
  await act(async () => xterm.resize?.());
  expect(p.onResize).toHaveBeenLastCalledWith(20, 5);
  expect(xterm.observe).toHaveBeenCalledOnce();
  term.options.linkHandler.activate({}, 'https://remote.test');
  expect(term.options.linkHandler.allowNonHttpProtocols).not.toBe(true);
  await act(async () => root.unmount());
  expect(xterm.disconnect).toHaveBeenCalledOnce();
  expect(term.dispose).toHaveBeenCalledOnce();
  expect(term.offData).toHaveBeenCalledOnce();
  expect(term.offBinary).toHaveBeenCalledOnce();
  root = createRoot(host);
});

it('recusa valores que não são uma matriz de bytes na ponte DOM', async () => {
  const p = props();
  await act(async () => root.render(<TerminalDom {...p} />));
  const bridge: DOMImperativeFactory = ref.current!;
  const invalid = [null, 'ab', { bytes: [1] }, [256], [-1], [1.5], [1, '2'], [NaN], [Infinity]];
  await act(async () => { for (const value of invalid) bridge.write(value); });
  expect(xterm.instances[0].write).not.toHaveBeenCalled();
  expect(p.onError).toHaveBeenCalledTimes(invalid.length);
});

it('escreve bytes em ordem, distingue onBinary e aplica tema/conexão sem recriar o terminal', async () => {
  const p = props();
  await act(async () => root.render(<TerminalDom {...p} />));
  expect(xterm.instances).toHaveLength(1);
  const term = xterm.instances[0];
  await act(async () => {
    ref.current?.write([226, 130]); ref.current?.write([172]);
    term.data('early-input'); term.binary('ÿ');
  });
  expect(term.write.mock.calls.map(([bytes]: [Uint8Array]) => [...bytes])).toEqual([[226, 130], [172]]);
  expect(p.onData).not.toHaveBeenCalled();
  await act(async () => root.render(<TerminalDom {...p} connected foreground="#010203" cursor="#abcdef" fontSize={15} />));
  expect(xterm.instances).toHaveLength(1);
  expect(term.options.theme).toEqual({ background: 'rgba(0, 0, 0, 0)', foreground: '#010203', cursor: '#abcdef' });
  expect(term.options.fontSize).toBe(15);
  expect(term.options.disableStdin).toBe(false);
  await act(async () => { term.data('ç\r'); term.binary('ÿ'); });
  expect(p.onData).toHaveBeenNthCalledWith(1, 'ç\r', false);
  expect(p.onData).toHaveBeenNthCalledWith(2, 'ÿ', true);
});
