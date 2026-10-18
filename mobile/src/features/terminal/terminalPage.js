(() => {
  'use strict';
  let disposed = false;
  let terminal;
  let observer;
  let addon;
  let host;
  let connected = false;
  let ready = false;
  const subscriptions = [];
  const send = message => {
    if (!disposed) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  const report = (error, kind = 'load') => send({ type: 'error', kind,
    message: error && typeof error.message === 'string' ? error.message : String(error) });
  const validConfig = message => typeof message.foreground === 'string' && typeof message.cursor === 'string'
    && Number.isFinite(message.fontSize) && message.fontSize > 0 && typeof message.connected === 'boolean';
  const measure = () => {
    if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    const dimensions = addon.proposeDimensions();
    if (!Number.isFinite(dimensions?.cols) || !Number.isFinite(dimensions?.rows)
      || dimensions.cols < 20 || dimensions.rows < 5) return;
    const cols = Math.min(500, Math.floor(dimensions.cols));
    const rows = Math.min(200, Math.floor(dimensions.rows));
    terminal.resize(cols, rows);
    return { cols, rows };
  };
  const resize = () => {
    if (disposed) return;
    try {
      const dimensions = measure();
      if (!dimensions) return;
      const type = ready ? 'resize' : 'ready';
      ready = true;
      send({ type, ...dimensions });
    } catch (error) { report(error); }
  };
  const configure = message => {
    connected = message.connected;
    terminal.options.theme = { background: 'rgba(0, 0, 0, 0)', foreground: message.foreground, cursor: message.cursor };
    terminal.options.disableStdin = !connected;
    if (terminal.options.fontSize !== message.fontSize) {
      terminal.options.fontSize = message.fontSize;
      if (ready) resize();
    }
  };
  const receive = message => {
    if (disposed) return;
    try {
      if (!message || typeof message !== 'object') throw new Error('Protocolo inválido.');
      switch (message.type) {
        case 'init': {
          if (terminal) return;
          if (!validConfig(message)) throw new Error('Configuração inválida.');
          connected = message.connected;
          terminal = new window.Terminal({
            allowTransparency: true,
            theme: { background: 'rgba(0, 0, 0, 0)', foreground: message.foreground, cursor: message.cursor },
            fontFamily: 'monospace', fontSize: message.fontSize, convertEol: false,
            screenReaderMode: true, disableStdin: !connected,
            linkHandler: { activate() {} },
          });
          // O psmux trata respostas de cores como digitação; clipboard remoto também fica bloqueado.
          for (const osc of [4, 10, 11, 12, 52]) subscriptions.push(terminal.parser.registerOscHandler(osc, () => true));
          addon = new window.FitAddon.FitAddon();
          terminal.loadAddon(addon);
          host = document.getElementById('terminal');
          terminal.open(host);
          const input = (data, binary) => { if (!disposed && ready && connected) send({ type: 'data', data, binary }); };
          subscriptions.push(terminal.onData(data => input(data, false)), terminal.onBinary(data => input(data, true)));
          observer = new ResizeObserver(resize);
          observer.observe(host);
          resize();
          break;
        }
        case 'config':
          if (!terminal || !validConfig(message)) throw new Error('Configuração inválida.');
          configure(message);
          break;
        case 'write':
          if (!Array.isArray(message.bytes) || !message.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
            report('Matriz de bytes inválida.', 'output');
            return;
          }
          if (ready) {
            try { terminal.write(Uint8Array.from(message.bytes)); } catch (error) { report(error, 'output'); }
          }
          break;
        default: throw new Error('Protocolo inválido.');
      }
    } catch (error) { report(error); }
  };
  const onError = event => report(event.error || event.message || 'Erro JavaScript.');
  const onRejection = event => report(event.reason);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    ready = false;
    connected = false;
    delete window.__hangarTerminalReceive;
    observer?.disconnect();
    for (const subscription of subscriptions) subscription.dispose();
    terminal?.dispose();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('pagehide', cleanup);
    window.removeEventListener('unload', cleanup);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('unload', cleanup);
  window.__hangarTerminalReceive = receive;
  send({ type: 'loaded' });
})();
