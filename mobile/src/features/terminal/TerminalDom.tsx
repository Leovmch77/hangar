import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import WebView, { type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import { terminalDocument } from './terminalDocument.generated';
import * as m from '../../paraglide/messages';

const source = { html: terminalDocument };

export interface TerminalDomHandle {
  write(bytes: unknown): void;
}

export interface TerminalDomProps {
  ref: Ref<TerminalDomHandle>;
  webView?: Omit<WebViewProps, 'source' | 'onMessage' | 'ref'>;
  foreground: string;
  cursor: string;
  fontSize: number;
  connected: boolean;
  onReady: (cols: number, rows: number) => Promise<void>;
  onResize: (cols: number, rows: number) => Promise<void>;
  onData: (data: string, binary: boolean) => Promise<void>;
  onError: (message: string) => Promise<void>;
}

export default function TerminalDom(props: TerminalDomProps) {
  const webview = useRef<WebView>(null);
  const phase = useRef<'loading' | 'loaded' | 'ready'>('loading');
  const alive = useRef(true);
  const current = useRef(props);
  current.current = props;
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const report = (error: unknown) => {
    if (alive.current) void current.current.onError(error instanceof Error ? error.message : String(error));
  };
  const invoke = (action: () => Promise<void>) => {
    try { void action().catch(report); } catch (error) { report(error); }
  };
  const send = (message: object) => {
    if (!alive.current) return;
    // JSON é dado, inclusive quando o tema contém separadores ou fechamento de script.
    const json = JSON.stringify(message).replace(/</g, '\\u003c')
      .replaceAll(String.fromCharCode(0x2028), '\\u2028').replaceAll(String.fromCharCode(0x2029), '\\u2029');
    try { webview.current?.injectJavaScript(`window.__hangarTerminalReceive(${json});true;`); } catch (error) { report(error); }
  };
  const configuration = () => {
    const p = current.current;
    return { foreground: p.foreground, cursor: p.cursor, fontSize: p.fontSize, connected: p.connected };
  };
  useImperativeHandle(props.ref, () => ({
    write(bytes: unknown) {
      if (!alive.current) return;
      if (!Array.isArray(bytes) || !bytes.every(byte => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        report(m.mobile_terminal_output_error());
        return;
      }
      if (phase.current === 'ready') send({ type: 'write', bytes });
    },
  }), []);
  useEffect(() => {
    if (phase.current !== 'loading') send({ type: 'config', ...configuration() });
  }, [props.foreground, props.cursor, props.fontSize, props.connected]);

  const onMessage = (event: WebViewMessageEvent) => {
    if (!alive.current) return;
    try {
      const raw = event.nativeEvent.data;
      if (typeof raw !== 'string') throw new Error();
      const message = JSON.parse(raw);
      if (!message || typeof message !== 'object') throw new Error();
      const dimensions = () => Number.isInteger(message.cols) && message.cols >= 20 && message.cols <= 500
        && Number.isInteger(message.rows) && message.rows >= 5 && message.rows <= 200;
      switch (message.type) {
        case 'loaded':
          if (phase.current !== 'loading') return;
          phase.current = 'loaded';
          send({ type: 'init', ...configuration() });
          break;
        case 'ready':
          if (!dimensions()) throw new Error();
          if (phase.current === 'ready') return;
          if (phase.current !== 'loaded') throw new Error();
          phase.current = 'ready';
          invoke(() => current.current.onReady(message.cols, message.rows));
          break;
        case 'resize':
          if (!dimensions()) throw new Error();
          if (phase.current === 'ready') invoke(() => current.current.onResize(message.cols, message.rows));
          break;
        case 'data':
          if (typeof message.data !== 'string' || typeof message.binary !== 'boolean') throw new Error();
          if (phase.current === 'ready' && current.current.connected) invoke(() => current.current.onData(message.data, message.binary));
          break;
        case 'error':
          if (typeof message.message !== 'string' || (message.kind !== 'load' && message.kind !== 'output')) throw new Error();
          report(`${message.kind === 'output' ? m.mobile_terminal_output_error() : m.mobile_terminal_load_error()} ${message.message}`);
          break;
        default: throw new Error();
      }
    } catch { report(m.mobile_terminal_output_error()); }
  };
  return <WebView {...props.webView} ref={webview} source={source} onMessage={onMessage}
    injectedJavaScript={undefined} injectedJavaScriptBeforeContentLoaded={undefined} injectedJavaScriptObject={undefined} />;
}
