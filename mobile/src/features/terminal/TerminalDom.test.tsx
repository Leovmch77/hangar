// @vitest-environment happy-dom
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebViewProps } from 'react-native-webview';
import * as m from '../../paraglide/messages';
import TerminalDom, { type TerminalDomHandle, type TerminalDomProps } from './TerminalDom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const boundary = vi.hoisted(() => ({ props: null as WebViewProps | null, scripts: [] as string[] }));
vi.mock('react-native-webview', async () => {
  const { useImperativeHandle } = await import('react');
  return { default: (props: WebViewProps & { ref?: React.Ref<unknown> }) => {
    boundary.props = props;
    useImperativeHandle(props.ref, () => ({ injectJavaScript: (script: string) => boundary.scripts.push(script) }));
    return null;
  } };
});

let root: Root;
let host: HTMLDivElement;
const ref = createRef<TerminalDomHandle>();
const props = (): TerminalDomProps => ({ ref, foreground: '#ededed', cursor: '#7799ff', fontSize: 13, connected: false,
  onReady: vi.fn(async () => {}), onResize: vi.fn(async () => {}), onData: vi.fn(async () => {}), onError: vi.fn(async () => {}) });
const render = async (p: TerminalDomProps) => {
  await act(async () => root.render(<TerminalDom {...p} />));
  expect(boundary.props).not.toBeNull();
};
const event = (message: unknown) => ({ nativeEvent: { data: typeof message === 'string' ? message : JSON.stringify(message) } } as any);
const message = (value: unknown) => act(async () => boundary.props?.onMessage?.(event(value)));
const commands = () => boundary.scripts.map(script => {
  let command: unknown;
  runInNewContext(script, { window: { __hangarTerminalReceive: (value: unknown) => { command = value; } } });
  return JSON.parse(JSON.stringify(command));
});
const ready = async () => { await message({ type: 'loaded' }); await message({ type: 'ready', cols: 80, rows: 24 }); };
beforeEach(() => {
  boundary.props = null; boundary.scripts = [];
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('espera loaded para init e ready para callbacks, sem objeto Expo nem injeção inicial em quatro montagens', async () => {
  let source: WebViewProps['source'];
  for (let mount = 0; mount < 4; mount++) {
    const p = props();
    boundary.scripts = [];
    await render(p);
    expect(boundary.props).not.toBeNull();
    const webview = boundary.props!;
    expect(webview.source).toMatchObject({ html: expect.stringContaining('<!doctype html>') });
    expect(webview.source).not.toHaveProperty('baseUrl');
    if (source) expect(webview.source).toBe(source);
    source = webview.source;
    expect(webview.injectedJavaScriptObject).toBeUndefined();
    expect(webview.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
    expect(webview.injectedJavaScript).toBeUndefined();
    expect(boundary.scripts).toEqual([]);
    expect(p.onReady).not.toHaveBeenCalled();
    await message({ type: 'resize', cols: 90, rows: 30 });
    await message({ type: 'data', data: 'early', binary: false });
    expect(p.onResize).not.toHaveBeenCalled(); expect(p.onData).not.toHaveBeenCalled();
    ref.current?.write([65]);
    expect(boundary.scripts).toEqual([]);
    await message({ type: 'loaded' });
    expect(commands()).toEqual([{ type: 'init', foreground: '#ededed', cursor: '#7799ff', fontSize: 13, connected: false }]);
    expect(p.onReady).not.toHaveBeenCalled();
    await message({ type: 'ready', cols: 80, rows: 24 });
    await message({ type: 'ready', cols: 80, rows: 24 }); await message({ type: 'loaded' });
    expect(p.onReady).toHaveBeenCalledExactlyOnceWith(80, 24);
    expect(boundary.scripts).toHaveLength(1);
    const oldMessage = webview.onMessage!;
    const oldWrite = ref.current!.write;
    await act(async () => root.unmount());
    const before = boundary.scripts.length;
    await act(async () => { oldMessage(event({ type: 'ready', cols: 90, rows: 30 })); oldMessage(event({ type: 'error', kind: 'load', message: 'old' })); oldWrite([66]); });
    expect(p.onError).not.toHaveBeenCalled();
    expect(p.onReady).toHaveBeenCalledOnce();
    expect(boundary.scripts).toHaveLength(before);
    root = createRoot(host);
  }
});

it('escreve bytes em ordem e configura tema/fonte/conexão sem trocar documento e sem executar texto como JS', async () => {
  const p = props(); await render(p); await ready();
  const source = boundary.props!.source;
  await act(async () => { ref.current!.write([226, 130]); ref.current!.write([172]); });
  expect(commands().slice(1)).toEqual([{ type: 'write', bytes: [226, 130] }, { type: 'write', bytes: [172] }]);
  const foreground = '</script>  ";throw Error("injection")';
  await render({ ...p, connected: true, foreground, cursor: '#abcdef', fontSize: 15 });
  expect(boundary.props!.source).toBe(source);
  expect(commands().at(-1)).toEqual({ type: 'config', foreground, cursor: '#abcdef', fontSize: 15, connected: true });
  expect(boundary.scripts.at(-1)).not.toContain('</script>');
  await message({ type: 'data', data: 'ç\r', binary: false });
  await message({ type: 'data', data: 'ÿ', binary: true });
  await message({ type: 'resize', cols: 90, rows: 30 });
  expect(p.onData).toHaveBeenNthCalledWith(1, 'ç\r', false);
  expect(p.onData).toHaveBeenNthCalledWith(2, 'ÿ', true);
  expect(p.onResize).toHaveBeenLastCalledWith(90, 30);
  await render({ ...p, connected: false });
  await message({ type: 'data', data: 'offline', binary: false });
  expect(p.onData).toHaveBeenCalledTimes(2);
});

it('usa callbacks atuais e init com configuração mais recente enquanto a página carrega', async () => {
  const p = props(); const next = props(); await render(p);
  await render({ ...next, foreground: '#123456', connected: true });
  expect(boundary.scripts).toEqual([]);
  await ready();
  expect(commands()[0]).toEqual({ type: 'init', foreground: '#123456', cursor: '#7799ff', fontSize: 13, connected: true });
  expect(p.onReady).not.toHaveBeenCalled(); expect(next.onReady).toHaveBeenCalledOnce();
  await message({ type: 'data', data: 'current', binary: false });
  expect(p.onData).not.toHaveBeenCalled(); expect(next.onData).toHaveBeenCalledWith('current', false);
});

it('valida bytes e mensagens no limite e expõe erros do runtime e de callbacks', async () => {
  const p = props(); await render(p); await ready();
  const invalid = [null, 'ab', { bytes: [1] }, [256], [-1], [1.5], [1, '2'], [NaN], [Infinity]];
  await act(async () => { for (const value of invalid) ref.current!.write(value); });
  expect(commands()).toHaveLength(1);
  expect(p.onError).toHaveBeenCalledTimes(invalid.length);
  for (const value of ['{invalid', null, {}, { type: 'unknown' }, { type: 'ready', cols: 0, rows: 24 },
    { type: 'resize', cols: 501, rows: 24 }, { type: 'resize', cols: 80.5, rows: 24 },
    { type: 'data', data: 123, binary: false }, { type: 'data', data: 'abc', binary: 'yes' },
    { type: 'error', kind: 'load', message: {} }]) await message(value);
  expect(p.onError).toHaveBeenCalledTimes(invalid.length + 10);
  expect(p.onError).toHaveBeenCalledWith(m.mobile_terminal_output_error());
  await message({ type: 'error', kind: 'load', message: 'fixture-runtime-error' });
  expect(p.onError).toHaveBeenLastCalledWith(`${m.mobile_terminal_load_error()} fixture-runtime-error`);
  await message({ type: 'error', kind: 'output', message: 'fixture-write-error' });
  expect(p.onError).toHaveBeenLastCalledWith(`${m.mobile_terminal_output_error()} fixture-write-error`);
  const onResize = vi.fn(async () => { throw new Error('fixture-callback'); });
  await render({ ...p, onResize });
  await message({ type: 'resize', cols: 90, rows: 30 });
  expect(p.onError).toHaveBeenLastCalledWith('fixture-callback');
  expect(p.onResize).not.toHaveBeenCalled();
});

it('preserva proteções RNWV e impede source/onMessage/ref ou injeções externas de substituir a ponte', async () => {
  const onError = vi.fn(); const onRenderProcessGone = vi.fn(); const navigate = vi.fn(() => false);
  const p = props();
  await render({ ...p, webView: {
    source: { uri: 'https://outside.test' }, onMessage: vi.fn(), ref: createRef(),
    injectedJavaScriptObject: { secret: 'should-not-enter' }, injectedJavaScriptBeforeContentLoaded: 'throw 1', injectedJavaScript: 'throw 2',
    onError, onRenderProcessGone, onShouldStartLoadWithRequest: navigate,
    allowFileAccessFromFileURLs: false, allowUniversalAccessFromFileURLs: false,
  } as any });
  expect(boundary.props).not.toBeNull();
  expect(boundary.props!.source).toMatchObject({ html: expect.any(String) });
  expect(boundary.props!.injectedJavaScriptObject).toBeUndefined();
  expect(boundary.props!.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
  expect(boundary.props!.injectedJavaScript).toBeUndefined();
  expect(boundary.props!.allowFileAccessFromFileURLs).toBe(false);
  expect(boundary.props!.allowUniversalAccessFromFileURLs).toBe(false);
  expect(boundary.props!.onError).toBe(onError); expect(boundary.props!.onRenderProcessGone).toBe(onRenderProcessGone);
  expect(boundary.props!.onShouldStartLoadWithRequest).toBe(navigate);
  await ready(); expect(p.onReady).toHaveBeenCalledOnce();
});
