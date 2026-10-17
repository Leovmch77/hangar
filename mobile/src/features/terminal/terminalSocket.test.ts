import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { configureApi, decidirRota, esquecerRota, type Server } from '@hangar/core';
import { openTerminalSocket } from './terminalSocket';

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  failSend = false;
  closed = false;
  ignoreConnectingClose = false;
  closeCalls = 0;
  constructor(public url: string, public protocols?: string[], public options?: { headers: { Origin: string } }) { Socket.instances.push(this); }
  send(data: string | Uint8Array) {
    if (this.failSend) throw new Error('native-send-failed');
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
    if (this.ignoreConnectingClose && this.readyState === 0) return;
    this.closed = true;
    this.readyState = 3;
  }
  open() { this.readyState = 1; this.onopen?.(); }
  end(code: number, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
}

const server: Server = { id: 'term-srv', label: 'fixture-server', baseUrl: 'https://remote.test/prefix/', token: 'explicit +/&' };
const size = { cols: 80, rows: 24 };
function connect() {
  const output = vi.fn();
  const status = vi.fn();
  const before = Socket.instances.length;
  const terminal = openTerminalSocket(server, 'name /ç', size, { output, status });
  expect(Socket.instances).toHaveLength(before + 1);
  return { terminal, output, status, socket: Socket.instances.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  configureApi({
    getBaseUrl: () => 'https://wrong-active.test',
    getToken: () => 'wrong-active-token',
    onUnauthorized: vi.fn(),
    origin: null,
    createEventSource: () => ({ addEventListener() {}, removeEventListener() {}, close() {}, onerror: null, onopen: null, readyState: 0 }),
  });
  esquecerRota(server.id);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); esquecerRota(server.id); });

describe('native terminal socket', () => {
  it.each([
    { baseUrl: 'http://term.test:8765/prefix', lan: undefined, url: 'ws://term.test:8765/prefix/api/sessions/chat/term?token=explicit%20%2B%2F%26&cols=80&rows=24', origin: 'http://term.test:8765' },
    { baseUrl: 'https://term.test:8443/prefix', lan: undefined, url: 'wss://term.test:8443/prefix/api/sessions/chat/term?token=explicit%20%2B%2F%26&cols=80&rows=24', origin: 'https://term.test:8443' },
    { baseUrl: 'https://remote.test/prefix', lan: { id: 'term-lan', url: 'http://192.168.1.10:8765/local' }, url: 'ws://192.168.1.10:8765/local/api/sessions/chat/term?token=explicit%20%2B%2F%26&cols=80&rows=24', origin: 'http://192.168.1.10:8765' },
  ])('Origin HTTP da conexão efetiva do terminal: $origin', async ({ baseUrl, lan, url, origin }) => {
    const target = { ...server, baseUrl, lan };
    if (lan) {
      vi.stubGlobal('fetch', vi.fn(async (address: string) => {
        if (!address.includes('/prova?')) return new Promise(() => {});
        const challenge = new URL(address).searchParams.get('desafio')!;
        return { ok: true, json: async () => ({ identificador: 'term-lan', prova: createHmac('sha256', server.token).update(`${challenge}|term-lan`).digest('hex') }) };
      }));
      await decidirRota(target);
    }
    const terminal = openTerminalSocket(target, 'chat', size, { output: vi.fn(), status: vi.fn() });
    const socket = Socket.instances.at(-1)!;
    expect(socket.url).toBe(url);
    expect(socket.options).toEqual({ headers: { Origin: origin } });
    terminal.close();
  });

  it('usa prefixo e token do servidor explícito e respeita a rota local comprovada por baseOf', async () => {
    const { socket, terminal } = connect();
    expect(socket.url).toBe('wss://remote.test/prefix/api/sessions/name%20%2F%C3%A7/term?token=explicit%20%2B%2F%26&cols=80&rows=24');
    terminal.close();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/prova?')) {
        const challenge = new URL(url).searchParams.get('desafio')!;
        return { ok: true, json: async () => ({ identificador: 'fixture-id', prova: createHmac('sha256', server.token).update(`${challenge}|fixture-id`).digest('hex') }) };
      }
      return new Promise(() => {});
    }));
    await decidirRota({ ...server, lan: { id: 'fixture-id', url: 'http://192.168.1.10:8765/local' } });
    const local = connect();
    expect(local.socket.url).toBe('ws://192.168.1.10:8765/local/api/sessions/name%20%2F%C3%A7/term?token=explicit%20%2B%2F%26&cols=80&rows=24');
    local.terminal.close();
  });

  it('envia unicode e controles em binário, sem recodificar onBinary, e conserva bytes fracionados da saída', () => {
    const { terminal, socket, output, status } = connect();
    expect(status).toHaveBeenLastCalledWith({ state: 'connecting', error: '' });
    expect(socket.binaryType).toBe('arraybuffer');
    socket.open();
    expect(status).toHaveBeenLastCalledWith({ state: 'connected', error: '' });
    expect(terminal.send('ação\r\u0003\u001b[A')).toBe(true);
    expect([...socket.sent[0] as Uint8Array]).toEqual([97, 195, 167, 195, 163, 111, 13, 3, 27, 91, 65]);
    expect(terminal.send('\u0080ÿ', true)).toBe(true);
    expect([...socket.sent[1] as Uint8Array]).toEqual([128, 255]);
    socket.onmessage?.({ data: new Uint8Array([0xe2, 0x82]).buffer });
    socket.onmessage?.({ data: new Uint8Array([0xac, 0x1b, 0x5b]).buffer });
    expect(output.mock.calls).toEqual([[[226, 130]], [[172, 27, 91]]]);
    terminal.close();
  });

  it('coalesce resize por 150ms, limita grade e cancela o envio ao fechar', () => {
    const { terminal, socket } = connect();
    socket.open();
    terminal.resize(10, 1);
    vi.advanceTimersByTime(100);
    terminal.resize(900, 900);
    vi.advanceTimersByTime(149);
    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.sent).toEqual(['{"t":"resize","cols":500,"rows":200}']);
    terminal.resize(0, 0);
    vi.advanceTimersByTime(150);
    expect(socket.sent.at(-1)).toBe('{"t":"resize","cols":20,"rows":5}');
    terminal.resize(100, 40);
    terminal.close();
    vi.advanceTimersByTime(150);
    expect(socket.sent).toHaveLength(2);
    expect(socket.closed).toBe(true);
  });

  it('não guarda tecla antes de abrir; falha send fecha e impede todos os envios seguintes', () => {
    const early = connect();
    expect(early.terminal.send('not-sent')).toBe(false);
    expect(early.socket.sent).toEqual([]);
    expect(early.status.mock.calls.at(-1)?.[0].error).toBeTruthy();
    early.terminal.close();
    const { terminal, socket, status } = connect();
    socket.open();
    socket.failSend = true;
    expect(terminal.send('first')).toBe(false);
    expect(socket.closed).toBe(true);
    expect(status.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'disconnected', error: expect.any(String) });
    expect(status.mock.calls.at(-1)?.[0].error).not.toBe('');
    socket.failSend = false;
    expect(terminal.send('second')).toBe(false);
    terminal.resize(100, 40);
    vi.advanceTimersByTime(150);
    expect(socket.sent).toEqual([]);
  });

  it.each([[1000, 'outra conexao assumiu'], [1011, 'pty-failed'], [1013, 'bridge-failed'], [4410, 'terminal-unavailable']])('expõe reason %s sem reconectar automaticamente', (code, reason) => {
    const { terminal, socket, status } = connect();
    socket.open();
    socket.end(code, reason);
    expect(status).toHaveBeenLastCalledWith({ state: 'disconnected', error: reason });
    expect(terminal.send('not-sent')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(socket.sent).toEqual([]);
  });

  it('erro nativo inibe entrada mas preserva o motivo do close seguinte', () => {
    const { terminal, socket, status } = connect();
    socket.open();
    socket.onerror?.();
    expect(terminal.send('not-sent')).toBe(false);
    socket.end(1013, 'bridge-connection-failed');
    expect(status).toHaveBeenLastCalledWith({ state: 'disconnected', error: 'bridge-connection-failed' });
    expect(socket.sent).toEqual([]);
  });

  it('resize durante conexão conserva a grade mais recente para o onopen', () => {
    const { terminal, socket } = connect();
    terminal.resize(120, 40);
    vi.advanceTimersByTime(150);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual(['{"t":"resize","cols":120,"rows":40}']);
    terminal.close();
  });

  it.each(['close', 'error'])('fecha open tardio após %s mesmo quando Android ignorou close em CONNECTING', action => {
    const { terminal, socket, output, status } = connect();
    socket.ignoreConnectingClose = true;
    if (action === 'close') terminal.close(); else socket.onerror?.();
    expect(socket.closed).toBe(false);
    socket.open();
    expect(socket.closed).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(status.mock.calls.some(([value]) => value.state === 'connected')).toBe(false);
    socket.onmessage?.({ data: new Uint8Array([65]).buffer });
    expect(output).not.toHaveBeenCalled();
    expect(terminal.send('not-sent')).toBe(false);
  });

  it('handshake sem open falha em 20s e fecha open tardio sem reconexão automática', () => {
    const { terminal, socket, status } = connect();
    socket.ignoreConnectingClose = true;
    vi.advanceTimersByTime(19_999);
    expect(status).toHaveBeenLastCalledWith({ state: 'connecting', error: '' });
    vi.advanceTimersByTime(1);
    expect(status).toHaveBeenLastCalledWith({ state: 'disconnected', error: expect.any(String) });
    expect(status.mock.calls.at(-1)?.[0].error).toBeTruthy();
    expect(socket.closeCalls).toBe(1);
    expect(socket.closed).toBe(false);
    expect(terminal.send('not-sent')).toBe(false);
    socket.open();
    expect(socket.closed).toBe(true);
    expect(socket.closeCalls).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(status.mock.calls.some(([value]) => value.state === 'connected')).toBe(false);
  });

  it('open em tempo cancela prazo de handshake', () => {
    const { terminal, socket, status } = connect();
    socket.open();
    vi.advanceTimersByTime(20_000);
    expect(status).toHaveBeenLastCalledWith({ state: 'connected', error: '' });
    expect(socket.closed).toBe(false);
    terminal.close();
  });

  it('depois da primeira saída não vazia manda o par de resize direto, com a grade mais recente', () => {
    const { terminal, socket, output } = connect();
    const order: string[] = [];
    output.mockImplementation(() => order.push(`output:${socket.sent.length}`));
    socket.open();
    terminal.resize(120, 40);
    vi.advanceTimersByTime(150);
    expect(socket.sent).toEqual(['{"t":"resize","cols":120,"rows":40}']);
    terminal.resize(130, 50);
    socket.onmessage?.({ data: new ArrayBuffer(0) });
    expect(socket.sent).toHaveLength(1);
    socket.onmessage?.({ data: new Uint8Array([65]).buffer });
    expect(order).toEqual(['output:1', 'output:1']);
    expect(socket.sent.slice(1)).toEqual(['{"t":"resize","cols":129,"rows":50}', '{"t":"resize","cols":130,"rows":50}']);
    vi.advanceTimersByTime(150);
    expect(socket.sent).toHaveLength(3);
    socket.onmessage?.({ data: new Uint8Array([66]).buffer });
    expect(socket.sent).toHaveLength(3);
    terminal.resize(90, 30);
    vi.advanceTimersByTime(149);
    expect(socket.sent).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(socket.sent.at(-1)).toBe('{"t":"resize","cols":90,"rows":30}');
    terminal.close();
  });

  it('par de resize usa a grade inicial, limita cols 20 para 21 e não sai no onopen', () => {
    const output = vi.fn();
    const terminal = openTerminalSocket(server, 'x', { cols: 5, rows: 1 }, { output, status: vi.fn() });
    const socket = Socket.instances.at(-1)!;
    socket.open();
    expect(socket.sent).toEqual([]);
    socket.onmessage?.({ data: new Uint8Array([65]).buffer });
    expect(socket.sent).toEqual(['{"t":"resize","cols":21,"rows":5}', '{"t":"resize","cols":20,"rows":5}']);
    terminal.close();
  });

  it('par de resize não sai após close/erro e para no primeiro envio que falha', () => {
    const closed = connect();
    closed.socket.open();
    closed.terminal.close();
    closed.socket.onmessage?.({ data: new Uint8Array([65]).buffer });
    expect(closed.socket.sent).toEqual([]);
    const errored = connect();
    errored.socket.open();
    errored.socket.onerror?.();
    errored.socket.onmessage?.({ data: new Uint8Array([65]).buffer });
    expect(errored.socket.sent).toEqual([]);
    const failing = connect();
    failing.socket.open();
    let calls = 0;
    failing.socket.send = () => { calls++; throw new Error('native-send-failed'); };
    failing.socket.onmessage?.({ data: new Uint8Array([65]).buffer });
    expect(failing.output).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    expect(failing.socket.closed).toBe(true);
  });

  it('motivo ausente mostra desconexão sem inventar 403; callbacks antigos não escrevem após close', () => {
    const { terminal, socket, output, status } = connect();
    socket.open();
    const oldMessage = socket.onmessage!;
    const oldOpen = socket.onopen!;
    const oldError = socket.onerror!;
    socket.end(1006);
    const message = status.mock.calls.at(-1)?.[0].error;
    expect(message).toBeTruthy();
    expect(message).not.toMatch(/403|recusad|denied/i);
    terminal.close();
    const count = status.mock.calls.length;
    oldMessage({ data: new Uint8Array([65]).buffer });
    oldOpen();
    oldError();
    expect(output).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(count);
  });
});
