'use dom';

import { useEffect, useRef, type Ref } from 'react';
import { useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from 'expo/dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import * as m from '../../paraglide/messages';

export interface TerminalDomHandle extends DOMImperativeFactory {
  write(bytes: unknown): void;
}

export interface TerminalDomProps {
  ref: Ref<TerminalDomHandle>;
  dom?: DOMProps;
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
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const current = useRef(props);
  current.current = props;
  const report = (error: unknown) => current.current.onError(error instanceof Error ? error.message : String(error));

  useDOMImperativeHandle(props.ref, () => ({
    write(bytes: unknown) {
      if (!Array.isArray(bytes) || !bytes.every(byte => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        void report(m.mobile_terminal_output_error());
        return;
      }
      try { terminal.current?.write(Uint8Array.from(bytes)); } catch (error) { void report(error); }
    },
  }), []);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    const subscriptions: { dispose(): void }[] = [];
    const invoke = (action: Promise<void>) => { void action.catch(error => { if (!disposed) void report(error); }); };
    try {
      const p = current.current;
      term = new Terminal({
        allowTransparency: true,
        theme: { background: 'rgba(0, 0, 0, 0)', foreground: p.foreground, cursor: p.cursor },
        fontFamily: 'monospace',
        fontSize: p.fontSize,
        convertEol: false,
        screenReaderMode: true,
        disableStdin: !p.connected,
        linkHandler: { activate() {} },
      });
      terminal.current = term;
      // O psmux trata respostas de cores como digitação; clipboard remoto também fica bloqueado.
      for (const osc of [4, 10, 11, 12, 52]) subscriptions.push(term.parser.registerOscHandler(osc, () => true));
      const addon = new FitAddon();
      term.loadAddon(addon);
      term.open(host.current!);
      const measure = () => {
        const dimensions = addon.proposeDimensions();
        const cols = Math.max(20, Math.min(500, Math.floor(dimensions?.cols ?? 80)));
        const rows = Math.max(5, Math.min(200, Math.floor(dimensions?.rows ?? 24)));
        term!.resize(cols, rows);
        return { cols, rows };
      };
      const dimensions = measure();
      fit.current = () => {
        if (disposed) return;
        try {
          const next = measure();
          invoke(current.current.onResize(next.cols, next.rows));
        } catch (error) { void report(error); }
      };
      subscriptions.push(term.onData(data => {
        if (!disposed && current.current.connected) invoke(current.current.onData(data, false));
      }), term.onBinary(data => {
        if (!disposed && current.current.connected) invoke(current.current.onData(data, true));
      }));
      observer = new ResizeObserver(() => fit.current?.());
      observer.observe(host.current!);
      invoke(current.current.onReady(dimensions.cols, dimensions.rows));
    } catch (error) { void report(error); }
    return () => {
      disposed = true;
      fit.current = null;
      terminal.current = null;
      observer?.disconnect();
      for (const subscription of subscriptions) subscription.dispose();
      term?.dispose();
    };
  }, []);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.theme = { background: 'rgba(0, 0, 0, 0)', foreground: props.foreground, cursor: props.cursor };
    term.options.disableStdin = !props.connected;
    if (term.options.fontSize !== props.fontSize) {
      term.options.fontSize = props.fontSize;
      fit.current?.();
    }
  }, [props.foreground, props.cursor, props.fontSize, props.connected]);

  return <div ref={host} className="terminal-host" />;
}
