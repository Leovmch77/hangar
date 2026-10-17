import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = () => readFileSync(new URL('./terminalPage.js', import.meta.url), 'utf8');
const config = { foreground: '#ededed', cursor: '#7799ff', fontSize: 13, connected: false };

function page(initialDimensions: { cols: number; rows: number } | undefined = { cols: 80, rows: 24 },
  host = { clientWidth: 640, clientHeight: 400 }) {
  const messages: any[] = [];
  const instances: any[] = [];
  const listeners = new Map<string, Function>();
  let resize: () => void = () => {};
  let dimensions: { cols: number; rows: number } | undefined = initialDimensions;
  const disconnect = vi.fn();
  const window: any = {
    ReactNativeWebView: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) },
    addEventListener: (name: string, callback: Function) => listeners.set(name, callback),
    removeEventListener: (name: string, callback: Function) => { if (listeners.get(name) === callback) listeners.delete(name); },
    Terminal: class {
      parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
      open = vi.fn(); dispose = vi.fn(); write = vi.fn();
      resize = vi.fn(); loadAddon = vi.fn();
      data!: (data: string) => void; binary!: (data: string) => void;
      offData = vi.fn(); offBinary = vi.fn();
      constructor(public options: any) { instances.push(this); }
      onData = (callback: (data: string) => void) => { this.data = callback; return { dispose: this.offData }; };
      onBinary = (callback: (data: string) => void) => { this.binary = callback; return { dispose: this.offBinary }; };
    },
    FitAddon: { FitAddon: class { proposeDimensions = () => dimensions; } },
  };
  runInNewContext(source(), {
    window, document: { getElementById: () => host }, Uint8Array,
    ResizeObserver: class {
      constructor(callback: () => void) { resize = callback; }
      observe = vi.fn(); disconnect = disconnect;
    },
  });
  return { window, messages, instances, listeners, disconnect, host,
    receive: (message: object) => window.__hangarTerminalReceive?.(message),
    resize: (next: typeof dimensions) => { dimensions = next; resize(); },
  };
}

it('registra receptor antes de loaded e só monta xterm após init, com OSC, acesso e grade protegidos', () => {
  const p = page();
  expect(p.messages).toEqual([{ type: 'loaded' }]);
  expect(typeof p.window.__hangarTerminalReceive).toBe('function');
  expect(p.instances).toHaveLength(0);
  p.receive({ type: 'init', ...config });
  expect(p.instances).toHaveLength(1);
  const term = p.instances[0];
  expect(term.options).toMatchObject({ allowTransparency: true, theme: { background: 'rgba(0, 0, 0, 0)', foreground: '#ededed', cursor: '#7799ff' },
    fontFamily: 'monospace', fontSize: 13, convertEol: false, screenReaderMode: true, disableStdin: true });
  expect(term.parser.registerOscHandler.mock.calls.map(([osc]: [number]) => osc)).toEqual([4, 10, 11, 12, 52]);
  for (const [, handler] of term.parser.registerOscHandler.mock.calls) expect(handler('query')).toBe(true);
  expect(term.resize).toHaveBeenLastCalledWith(80, 24);
  expect(p.messages.at(-1)).toEqual({ type: 'ready', cols: 80, rows: 24 });
  term.options.linkHandler.activate({}, 'https://remote.test');
  expect(term.options.linkHandler.allowNonHttpProtocols).not.toBe(true);
  p.resize({ cols: 999, rows: 999 });
  expect(p.messages.at(-1)).toEqual({ type: 'resize', cols: 500, rows: 200 });
  const count = p.messages.length;
  p.resize({ cols: NaN, rows: Infinity });
  expect(p.messages).toHaveLength(count);
  expect(term.resize).toHaveBeenCalledTimes(2);
  p.receive({ type: 'init', ...config });
  expect(p.instances).toHaveLength(1);
});

it('aguarda layout útil e proposta plausível para ready, sem inventar resize ao perder layout', () => {
  const p = page({ cols: 2, rows: 1 }, { clientWidth: 0, clientHeight: 0 });
  p.receive({ type: 'init', ...config, connected: true });
  const term = p.instances[0];
  expect(p.messages).toEqual([{ type: 'loaded' }]);
  expect(term.resize).not.toHaveBeenCalled();
  term.data('early'); term.binary('early');
  p.resize({ cols: 80, rows: 24 });
  p.host.clientWidth = 640;
  p.resize({ cols: 80, rows: 24 });
  p.host.clientHeight = 400;
  for (const dimensions of [undefined, { cols: NaN, rows: 24 }, { cols: 80, rows: Infinity },
    { cols: 19, rows: 5 }, { cols: 20, rows: 4 }, { cols: 2, rows: 1 }]) p.resize(dimensions);
  p.receive({ type: 'config', ...config, connected: true, foreground: '#010203', fontSize: 15 });
  expect(term.options.theme.foreground).toBe('#010203');
  expect(term.options.fontSize).toBe(15);
  expect(p.messages).toEqual([{ type: 'loaded' }]);
  expect(term.resize).not.toHaveBeenCalled();
  p.resize({ cols: 20, rows: 5 });
  expect(p.messages.at(-1)).toEqual({ type: 'ready', cols: 20, rows: 5 });
  expect(term.resize).toHaveBeenCalledExactlyOnceWith(20, 5);
  term.data('ready');
  expect(p.messages.filter(message => message.type === 'data')).toEqual([{ type: 'data', data: 'ready', binary: false }]);
  const count = p.messages.length;
  p.host.clientWidth = 0;
  p.resize({ cols: 80, rows: 24 });
  p.host.clientWidth = 640;
  p.host.clientHeight = 0;
  p.resize({ cols: 80, rows: 24 });
  p.host.clientHeight = 400;
  p.resize(undefined);
  p.resize({ cols: 2, rows: 1 });
  expect(p.messages).toHaveLength(count);
  expect(term.resize).toHaveBeenCalledTimes(1);
  p.resize({ cols: 90, rows: 30 });
  expect(p.messages.at(-1)).toEqual({ type: 'resize', cols: 90, rows: 30 });
  expect(p.messages.filter(message => message.type === 'ready')).toHaveLength(1);
});

it('tema recebido durante a espera não antecipa ready à notificação válida do observador', () => {
  const p = page({ cols: 80, rows: 24 }, { clientWidth: 0, clientHeight: 0 });
  p.receive({ type: 'init', ...config });
  p.host.clientWidth = 640;
  p.host.clientHeight = 400;
  p.receive({ type: 'config', ...config, connected: true, fontSize: 15 });
  expect(p.instances[0].options.fontSize).toBe(15);
  expect(p.messages).toEqual([{ type: 'loaded' }]);
  p.resize({ cols: 80, rows: 24 });
  expect(p.messages.at(-1)).toEqual({ type: 'ready', cols: 80, rows: 24 });
});

it('preserva bytes UTF8 fragmentados e distingue entrada binária, tema e conexão sem recriar xterm', () => {
  const p = page(); p.receive({ type: 'init', ...config });
  expect(p.instances).toHaveLength(1);
  const term = p.instances[0];
  const invalid = [null, 'ab', { bytes: [1] }, [256], [-1], [1.5], [1, '2'], [NaN], [Infinity]];
  for (const bytes of invalid) p.receive({ type: 'write', bytes });
  expect(term.write).not.toHaveBeenCalled();
  expect(p.messages.filter(message => message.type === 'error' && message.kind === 'output')).toHaveLength(invalid.length);
  p.receive({ type: 'write', bytes: [226, 130] }); p.receive({ type: 'write', bytes: [172] });
  expect(term.write.mock.calls.map(([bytes]: [Uint8Array]) => [...bytes])).toEqual([[226, 130], [172]]);
  term.data('early-input'); term.binary('ÿ');
  expect(p.messages.filter(message => message.type === 'data')).toEqual([]);
  p.receive({ type: 'config', ...config, connected: true, foreground: '#010203', cursor: '#abcdef', fontSize: 15 });
  expect(p.instances).toHaveLength(1);
  expect(term.options.theme).toEqual({ background: 'rgba(0, 0, 0, 0)', foreground: '#010203', cursor: '#abcdef' });
  expect(term.options.disableStdin).toBe(false);
  expect(term.options.fontSize).toBe(15);
  term.data('ç\r'); term.binary('ÿ');
  expect(p.messages.filter(message => message.type === 'data')).toEqual([
    { type: 'data', data: 'ç\r', binary: false }, { type: 'data', data: 'ÿ', binary: true },
  ]);
  p.receive({ type: 'config', ...config }); term.data('offline');
  expect(p.messages.filter(message => message.type === 'data')).toHaveLength(2);
});

it('expõe erro JS/rejeição/escrita e limpa recursos, receptor e callbacks antigos no pagehide/unload', () => {
  for (const event of ['pagehide', 'unload']) {
    const p = page(); p.receive({ type: 'init', ...config, connected: true });
    expect(p.instances).toHaveLength(1);
    const term = p.instances[0];
    p.listeners.get('error')?.({ message: 'fixture-js-error' });
    p.listeners.get('unhandledrejection')?.({ reason: new Error('fixture-rejection') });
    term.write.mockImplementationOnce(() => { throw new Error('fixture-write'); });
    p.receive({ type: 'write', bytes: [65] });
    expect(p.messages.filter(message => message.type === 'error').map(message => message.message))
      .toEqual(['fixture-js-error', 'fixture-rejection', 'fixture-write']);
    const receive = p.window.__hangarTerminalReceive;
    p.listeners.get(event)?.();
    expect(p.disconnect).toHaveBeenCalledOnce();
    expect(term.dispose).toHaveBeenCalledOnce();
    expect(term.offData).toHaveBeenCalledOnce(); expect(term.offBinary).toHaveBeenCalledOnce();
    for (const result of term.parser.registerOscHandler.mock.results) expect(result.value.dispose).toHaveBeenCalledOnce();
    expect(p.window.__hangarTerminalReceive).toBeUndefined();
    expect(p.listeners.size).toBe(0);
    const count = p.messages.length;
    term.data('old'); term.binary('old'); p.resize({ cols: 90, rows: 30 }); receive({ type: 'init', ...config });
    expect(p.messages).toHaveLength(count);
    expect(p.instances).toHaveLength(1);
  }
});

it('recusa protocolo/configuração inválidos sem montar terminal', () => {
  const p = page();
  for (const message of [null, {}, { type: 'unknown' }, { type: 'init', ...config, fontSize: NaN },
    { type: 'init', ...config, connected: 'yes' }, { type: 'config', ...config }]) p.receive(message as any);
  expect(p.messages.filter(message => message.type === 'error')).toHaveLength(6);
  expect(p.instances).toHaveLength(0);
});
