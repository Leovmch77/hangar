import { baseOf, type Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

export function openTerminalSocket(server: Server, name: string, size: { cols: number; rows: number }, callbacks: {
  output: (bytes: number[]) => void;
  status: (status: { state: 'connecting' | 'connected' | 'disconnected'; error: string }) => void;
}) {
  let socket: WebSocket | undefined;
  let alive = true;
  let errored = false;
  let pendingSize: { cols: number; rows: number } | undefined;
  let latestSize: { cols: number; rows: number } | undefined;
  let nudged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  const limit = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
  const grid = (cols: number, rows: number) => ({ cols: limit(cols, 20, 500), rows: limit(rows, 5, 200) });
  const close = () => {
    alive = false;
    clearTimeout(timer);
    clearTimeout(openingTimer);
    socket?.close();
  };
  const fail = (error: string) => {
    if (!alive) return;
    close();
    callbacks.status({ state: 'disconnected', error });
  };
  callbacks.status({ state: 'connecting', error: '' });
  try {
    const base = baseOf(server).replace(/\/+$/, '').replace(/^http/, 'ws');
    const initial = grid(size.cols, size.rows);
    latestSize = initial;
    socket = new WebSocket(`${base}/api/sessions/${encodeURIComponent(name)}/term?token=${encodeURIComponent(server.token)}&cols=${initial.cols}&rows=${initial.rows}`);
    socket.binaryType = 'arraybuffer';
    openingTimer = setTimeout(() => fail(m.mobile_terminal_connect_timeout()), 20_000);
    socket.onopen = () => {
      clearTimeout(openingTimer);
      if (!alive || errored) {
        // O Android ignora close enquanto o socket ainda não entrou no registro nativo.
        socket?.close();
        return;
      }
      callbacks.status({ state: 'connected', error: '' });
      if (pendingSize) {
        clearTimeout(timer);
        sendFrame(JSON.stringify({ t: 'resize', ...pendingSize }));
        pendingSize = undefined;
      }
    };
    socket.onmessage = event => {
      if (!alive || errored) return;
      if (!(event.data instanceof ArrayBuffer)) {
        fail(m.mobile_terminal_output_error());
        return;
      }
      callbacks.output(Array.from(new Uint8Array(event.data)));
      // O PTY nasce antes do attach e só escuta resize depois; trocar a largura força o TUI a redesenhar.
      if (nudged || event.data.byteLength === 0 || !alive || errored || !latestSize) return;
      nudged = true;
      clearTimeout(timer);
      pendingSize = undefined;
      const { cols, rows } = latestSize;
      if (sendFrame(JSON.stringify({ t: 'resize', cols: cols === 20 ? 21 : cols - 1, rows }))) {
        sendFrame(JSON.stringify({ t: 'resize', cols, rows }));
      }
    };
    socket.onclose = event => {
      clearTimeout(openingTimer);
      if (!alive) return;
      alive = false;
      clearTimeout(timer);
      callbacks.status({ state: 'disconnected', error: event.reason || m.native_term_disconnected() });
    };
    socket.onerror = () => {
      if (!alive) return;
      errored = true;
      clearTimeout(timer);
      clearTimeout(openingTimer);
      // O close seguinte pode trazer a causa que o evento de erro não informa.
      callbacks.status({ state: 'disconnected', error: m.native_term_disconnected() });
    };
  } catch {
    fail(m.native_term_disconnected());
  }
  const sendFrame = (data: string | Uint8Array) => {
    if (!alive || errored) return false;
    if (socket?.readyState !== 1) {
      callbacks.status({ state: 'connecting', error: m.native_term_disconnected() });
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch {
      fail(m.mobile_terminal_send_error());
      return false;
    }
  };
  return {
    send: (data: string, binary = false) => sendFrame(binary
      ? Uint8Array.from(data, character => character.charCodeAt(0))
      : new TextEncoder().encode(data)),
    resize: (cols: number, rows: number) => {
      clearTimeout(timer);
      if (!alive || errored) return;
      pendingSize = grid(cols, rows);
      latestSize = pendingSize;
      timer = setTimeout(() => {
        if (socket?.readyState !== 1 || !pendingSize) return;
        sendFrame(JSON.stringify({ t: 'resize', ...pendingSize }));
        pendingSize = undefined;
      }, 150);
    },
    close,
  };
}
