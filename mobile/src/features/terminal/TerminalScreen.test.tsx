// @vitest-environment happy-dom
import React, { act, useEffect, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '../../paraglide/messages';
import { TerminalScreen } from './TerminalScreen';
import TerminalRoute from '../../../app/s/[server]/[name]/terminal';
import type { TerminalDomProps } from './TerminalDom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const boundary = vi.hoisted(() => ({
  dom: null as TerminalDomProps | null,
  writes: [] as number[][],
  mounted: 0,
  order: [] as string[],
  servers: [{ id: 'chosen', label: 'fixture-server', baseUrl: 'https://chosen.test/prefix', token: 'chosen-secret' }],
  appState: 'active',
  focused: true,
  listeners: new Set<(state: string) => void>(),
  pane: vi.fn(),
  key: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useIsFocused: () => boundary.focused,
  useLocalSearchParams: () => ({ server: 'chosen', name: 'fixture', aviso: 'route-warning' }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children, automaticOffset }: { children: React.ReactNode; automaticOffset?: boolean }) => React.createElement('div', { 'data-automatic-offset': String(!!automaticOffset) }, children) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }) }));
vi.mock('./TerminalDom', () => ({ default: (props: TerminalDomProps) => {
  boundary.dom = props;
  useImperativeHandle(props.ref, () => ({
    write: (bytes: unknown) => {
      if (!Array.isArray(bytes) || !bytes.every(byte => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('invalid-byte-fixture');
      boundary.writes.push(bytes);
    },
  }));
  useEffect(() => {
    boundary.mounted++; boundary.order.push('dom-mount');
    return () => { boundary.mounted--; boundary.order.push('dom-unmount'); };
  }, []);
  return React.createElement('div', { 'data-terminal': true });
} }));
vi.mock('../../stores/servers', () => ({
  useServers: (select: (state: { servers: typeof boundary.servers; activeId: string }) => unknown) => select({ servers: boundary.servers, activeId: 'wrong-active' }),
}));
vi.mock('react-native', async (original) => {
  const native = await original<typeof import('react-native')>();
  return {
    ...native,
    AppState: {
      get currentState() { return boundary.appState; },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        boundary.listeners.add(listener);
        return { remove: () => boundary.listeners.delete(listener) };
      },
    },
    ScrollView: ({ children, style, contentContainerStyle }: React.ComponentProps<typeof native.ScrollView>) => React.createElement(native.View, { style },
      React.createElement(native.View, { style: contentContainerStyle }, children)),
    Text: ({ children, accessibilityRole }: { children: React.ReactNode; accessibilityRole?: string }) => React.createElement('span', { role: accessibilityRole }, children),
  };
});
vi.mock('@legendapp/list/react-native', () => ({ LegendList: () => React.createElement('div') }));
vi.mock('@hangar/core', async original => ({
  ...await original<typeof import('@hangar/core')>(),
  getPane: boundary.pane, sendKey: boundary.key,
}));

class Socket {
  static instances: Socket[] = [];
  readyState = 0; binaryType = '';
  onopen?: () => void;
  onmessage?: (event: { data: ArrayBuffer }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;
  sent: (string | Uint8Array)[] = [];
  fail = false;
  closed = false;
  constructor(public url: string) { Socket.instances.push(this); boundary.order.push('socket-open'); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.closed = true; this.readyState = 3; boundary.order.push('socket-close'); }
  send(bytes: string | Uint8Array) { if (this.fail) throw new Error('failed-send'); this.sent.push(bytes); }
  end(code: number, reason: string) { this.readyState = 3; this.onclose?.({ code, reason }); }
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket);
  Socket.instances = []; boundary.dom = null; boundary.mounted = 0; boundary.writes = []; boundary.order = [];
  boundary.appState = 'active'; boundary.listeners.clear();
  boundary.pane.mockReset().mockImplementation(async () => {
    boundary.order.push('pane');
    expect(Socket.instances.every(socket => socket.closed || socket.readyState === 3)).toBe(true);
    return { text: 'fixture-pane', scrollback: 0 };
  });
  boundary.key.mockReset();
  boundary.servers = [{ id: 'chosen', label: 'fixture-server', baseUrl: 'https://chosen.test/prefix', token: 'chosen-secret' }];
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = (focused = true, name = 'fixture') => act(async () => root.render(<TerminalScreen serverId="chosen" name={name} focused={focused} aviso="route-warning" />));
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (label: string) => act(async () => button(label).click());
const ready = () => act(async () => {
  expect(boundary.dom).not.toBeNull();
  await boundary.dom!.onReady(80, 24);
  expect(Socket.instances.length).toBeGreaterThan(0);
});
const state = (next: string) => act(async () => { boundary.appState = next; for (const listener of boundary.listeners) listener(next); });

describe('terminal screen with native WebSocket and DOM boundary', () => {
  it('folha do terminal usa offset automático do teclado', async () => {
    await act(async () => root.render(<TerminalRoute />));
    expect(host.querySelector('[data-automatic-offset]')?.getAttribute('data-automatic-offset')).toBe('true');
  });

  it('mantém conteúdo expansível e rodapé fora dele com inset inferior ao falhar e tentar novamente', async () => {
    const expectFooterLayout = (visible: Element) => {
      const row = button(m.term_seta_cima()).parentElement!;
      const footer = row.parentElement!;
      const content = footer.previousElementSibling as HTMLElement | null;
      expect(content?.style.flexGrow).toBe('1');
      expect(content?.contains(visible)).toBe(true);
      expect(content?.contains(footer)).toBe(false);
      expect(footer.style.flexGrow).toBe('0');
      expect(row.style.paddingBottom).toBe('42px');
    };
    await render();
    expect(host.textContent).toContain(m.native_term_connecting());
    expectFooterLayout(host.querySelector('[data-terminal]')!);

    await act(async () => boundary.dom!.onError('fixture-load-error'));
    expect(host.textContent).toContain('fixture-load-error');
    expect(boundary.mounted).toBe(0);
    expectFooterLayout(button(m.lista_tentar_novamente()));

    await click(m.lista_tentar_novamente());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(m.native_term_connecting());
    expectFooterLayout(host.querySelector('[data-terminal]')!);

    await ready();
    await act(async () => Socket.instances[0].open());
    expect(button(m.term_seta_cima()).disabled).toBe(false);
    expectFooterLayout(host.querySelector('[data-terminal]')!);
    await act(async () => Socket.instances[0].end(1013, 'fixture-disconnected'));
    expectFooterLayout(button(m.native_term_reconnect()));
  });

  it('usa documento local sem injeção inicial e conserva as proteções de navegação', async () => {
    await render();
    const config = boundary.dom!.webView;
    expect(config).toBeDefined();
    expect(config!.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
    expect(config!.injectedJavaScript).toBeUndefined();
    expect(config!.injectedJavaScriptObject).toBeUndefined();
    expect(config).toMatchObject({
      javaScriptCanOpenWindowsAutomatically: false,
      setSupportMultipleWindows: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
    });
    const navigate = (url: string) => config!.onShouldStartLoadWithRequest?.({ url } as any);
    expect(navigate('about:blank')).toBe(true);
    expect(navigate('about:blank#terminal')).toBe(true);
    for (const url of ['https://outside.test', 'javascript:alert(1)', 'data:text/html,hi',
      'file:///android_asset/www.bundle/terminal.html', 'http://192.168.1.2:8081/_expo/@dom/terminal',
      'about:blank?remote=1', 'about:srcdoc', 'not-a-url']) expect(navigate(url)).toBe(false);
  });

  it('rota usa terminal real e respeita foco sem iniciar o espelho', async () => {
    boundary.focused = true;
    await act(async () => root.render(<TerminalRoute />));
    expect(host.textContent).toContain(m.native_term_connecting());
    expect(boundary.mounted).toBe(1);
    expect(boundary.pane).not.toHaveBeenCalled();
    await ready();
    boundary.focused = false;
    await act(async () => root.render(<TerminalRoute />));
    expect(boundary.mounted).toBe(0);
    expect(Socket.instances[0].closed).toBe(true);
  });

  it('espera ready, mostra loading/aviso e só libera teclas em onopen; saída não re-renderiza DOM', async () => {
    await render();
    expect(host.textContent).toContain(m.native_term_connecting());
    expect(host.textContent).toContain('route-warning');
    expect(button(m.term_seta_cima())?.disabled).toBe(true);
    expect(Socket.instances).toHaveLength(0);
    expect(boundary.mounted).toBe(1);
    await ready();
    expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0];
    expect(socket.url).toContain('chosen.test/prefix/api/sessions/fixture/term?token=chosen-secret');
    expect(JSON.stringify(boundary.dom)).not.toContain('chosen-secret');
    expect(button(m.term_seta_cima()).disabled).toBe(true);
    await act(async () => socket.open());
    expect(button(m.term_seta_cima()).disabled).toBe(false);
    expect(host.textContent).not.toContain(m.native_term_connecting());
    const propsBefore = boundary.dom;
    await act(async () => {
      socket.onmessage?.({ data: new Uint8Array([226, 130]).buffer });
      socket.onmessage?.({ data: new Uint8Array([172]).buffer });
    });
    expect(boundary.writes).toEqual([[226, 130], [172]]);
    expect(boundary.dom).toBe(propsBefore);
    await click(m.term_seta_cima());
    expect([...(socket.sent.at(-1) as Uint8Array)]).toEqual([27, 91, 65]);
    await act(async () => boundary.dom?.onData('ç\u0003', false));
    expect([...(socket.sent.at(-1) as Uint8Array)]).toEqual([195, 167, 3]);
    expect(boundary.pane).not.toHaveBeenCalled();
  });

  it('takeover mostra motivo, desabilita teclas e só reconecta pelo botão', async () => {
    await render(); await ready();
    const old = Socket.instances[0];
    await act(async () => { old.open(); old.end(1000, 'outra conexao assumiu'); });
    expect(host.textContent).toContain('outra conexao assumiu');
    expect(button(m.term_seta_cima()).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(Socket.instances).toHaveLength(1);
    await click(m.native_term_reconnect());
    expect(boundary.mounted).toBe(1);
    await ready();
    expect(Socket.instances).toHaveLength(2);
    expect(old.closed).toBe(true);
  });

  it.each([[1000, 'outra conexao assumiu'], [1013, 'bridge-failed']])('preserva desconexão %s ao voltar de background e foco; só botão reabre', async (code, reason) => {
    await render(); await ready();
    const first = Socket.instances[0];
    await act(async () => { first.open(); first.end(code, reason); });
    await state('background');
    expect(boundary.mounted).toBe(0);
    await state('active');
    expect(boundary.mounted).toBe(0);
    expect(Socket.instances).toHaveLength(1);
    expect(host.textContent).toContain(reason);
    expect(button(m.native_term_reconnect())).not.toBeNull();
    await render(false);
    await render(true);
    expect(boundary.mounted).toBe(0);
    expect(Socket.instances).toHaveLength(1);
    expect(host.textContent).toContain(reason);
    await click(m.native_term_reconnect());
    expect(boundary.mounted).toBe(1);
    await ready();
    expect(Socket.instances).toHaveLength(2);
  });

  it('falha send fecha socket e mostra erro, sem fingir enviar tecla seguinte', async () => {
    await render(); await ready();
    const socket = Socket.instances[0];
    await act(async () => socket.open());
    socket.fail = true;
    await click(m.term_seta_cima());
    expect(socket.closed).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(button(m.term_seta_baixo()).disabled).toBe(true);
    await click(m.term_seta_baixo());
    expect(socket.sent).toEqual([]);
  });

  it('desmonta DOM e fecha PTY antes do poll do espelho; volta sem sobrepor polling e mostra 409 intacto', async () => {
    await render(); await ready();
    await act(async () => Socket.instances[0].open());
    boundary.pane.mockRejectedValueOnce(new Error('409 fixture-pane-conflict'));
    await click(m.mobile_terminal_mirror());
    expect(boundary.mounted).toBe(0);
    expect(Socket.instances[0].closed).toBe(true);
    expect(boundary.order.indexOf('socket-close')).toBeLessThan(boundary.order.indexOf('dom-unmount') + 2);
    expect(host.textContent).toContain('route-warning');
    expect(host.textContent).toContain('409 fixture-pane-conflict');
    const count = boundary.pane.mock.calls.length;
    await click(m.mobile_terminal_real());
    expect(boundary.mounted).toBe(1);
    await ready();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(boundary.pane).toHaveBeenCalledTimes(count);
    expect(Socket.instances).toHaveLength(2);
  });

  it('background/focus/sessão desmontam DOM, cancelam timer e descartam callbacks velhos; foreground reabre', async () => {
    await render(); await ready();
    const first = Socket.instances[0];
    await act(async () => first.open());
    const oldData = boundary.dom!.onData;
    const oldReady = boundary.dom!.onReady;
    const oldOutput = first.onmessage!;
    await act(async () => boundary.dom?.onResize(90, 30));
    await state('background');
    expect(first.closed).toBe(true);
    expect(boundary.mounted).toBe(0);
    await act(async () => { await oldData('old', false); await oldReady(70, 20); oldOutput({ data: new Uint8Array([65]).buffer }); });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(first.sent).toEqual([]);
    expect(boundary.writes).toEqual([]);
    expect(Socket.instances).toHaveLength(1);
    await state('active'); await ready();
    expect(Socket.instances).toHaveLength(2);
    await render(false);
    expect(Socket.instances[1].closed).toBe(true);
    expect(boundary.mounted).toBe(0);
    await render(); await ready();
    expect(Socket.instances).toHaveLength(3);
    await render(true, 'other-session');
    expect(Socket.instances[2].closed).toBe(true);
    await ready();
    expect(Socket.instances[3].url).toContain('/other-session/term?');
    await act(async () => root.unmount());
    expect(Socket.instances[3].closed).toBe(true);
    expect(boundary.listeners.size).toBe(0);
    root = createRoot(host);
  });

  it('erro de carga/processo DOM fecha socket, dá tentar novamente/espelho e bloqueia navegação remota', async () => {
    await render(); await ready();
    const dom = boundary.dom!.webView!;
    expect(dom.onShouldStartLoadWithRequest?.({ url: 'about:blank' } as any)).toBe(true);
    expect(dom.onShouldStartLoadWithRequest?.({ url: 'https://outside.test' } as any)).toBe(false);
    expect(dom.onShouldStartLoadWithRequest?.({ url: 'javascript:alert(1)' } as any)).toBe(false);
    await act(async () => dom.onRenderProcessGone?.({ nativeEvent: { didCrash: true } } as any));
    expect(Socket.instances[0].closed).toBe(true);
    expect(boundary.mounted).toBe(0);
    expect(host.textContent).toContain(m.mobile_terminal_load_error());
    expect(button(m.lista_tentar_novamente())).not.toBeNull();
    expect(button(m.mobile_terminal_mirror())).not.toBeNull();
    await click(m.lista_tentar_novamente()); await ready();
    expect(Socket.instances).toHaveLength(2);
    await act(async () => boundary.dom!.webView?.onError?.({ nativeEvent: { description: 'fixture-load-error' } } as any));
    expect(host.textContent).toContain('fixture-load-error');
    expect(Socket.instances[1].closed).toBe(true);
  });

  it('DOM sem ready encerra loading com erro e ignora a página que responde depois', async () => {
    await render();
    const lateReady = boundary.dom!.onReady;
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(host.textContent).toContain(m.mobile_terminal_load_error());
    expect(boundary.mounted).toBe(0);
    await act(async () => lateReady(80, 24));
    expect(Socket.instances).toHaveLength(0);
    await click(m.lista_tentar_novamente());
    await ready();
    await act(async () => Socket.instances[0].open());
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(host.textContent).not.toContain(m.mobile_terminal_load_error());
  });

  it('servidor ausente não monta DOM nem abre socket e mostra causa', async () => {
    boundary.servers = [];
    await render();
    expect(host.textContent).toContain(m.servidor_nao_existe());
    expect(boundary.mounted).toBe(0);
    expect(Socket.instances).toHaveLength(0);
  });
});
