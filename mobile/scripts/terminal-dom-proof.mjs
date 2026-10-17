import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import builder from './build-terminal-document.cjs';

// A página é real; só a fronteira nativa é simulada. Não prova RNWV, IME ou PTY.
function prepareNativeEnvironment() {
  const proof = window.__terminalDomProof = {
    status: 'pending', message: 'Aguardando loaded → init → ready (teto de 10 s).',
    messages: [], sequence: [], errors: [], dimensions: [], writeSent: false, accessibilityText: '',
  };
  const frame = document.querySelector('iframe');
  const output = document.getElementById('terminal-dom-proof');
  const page = frame.contentWindow;
  const doc = frame.contentDocument;
  doc.open();
  const render = () => {
    document.documentElement.dataset.proof = output.dataset.proof = proof.status;
    doc.documentElement?.setAttribute('data-proof', proof.status);
    const label = { pending: 'Aguardando', passed: 'Passou', failed: 'Falhou' }[proof.status];
    output.textContent = label + ': ' + proof.message;
  };
  const fail = error => {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    proof.errors.push(message);
    if (proof.status !== 'failed') proof.message = message;
    proof.status = 'failed';
    clearTimeout(deadline);
    observer.disconnect();
    render();
  };
  const inspectTerminal = () => {
    if (proof.status !== 'pending' || !proof.writeSent) return;
    proof.accessibilityText = doc.querySelector('.xterm-accessibility-tree')?.textContent ?? '';
    if (!proof.accessibilityText.includes('DOM-PTY-OK')) return;
    proof.status = 'passed';
    proof.message = 'loaded → init → ready, dimensões > 0 e DOM-PTY-OK na árvore acessível real.';
    clearTimeout(deadline);
    observer.disconnect();
    render();
  };
  const observer = new MutationObserver(inspectTerminal);
  observer.observe(doc, { childList: true, subtree: true, characterData: true });
  const deadline = setTimeout(() => fail('Prazo de 10 s esgotado sem prova completa.'), 10_000);
  page.addEventListener('error', event => fail(event.error || event.message || 'Erro JavaScript.'), true);
  page.addEventListener('unhandledrejection', event => fail(event.reason));
  const originalConsoleError = page.console.error;
  page.console.error = (...args) => {
    originalConsoleError.apply(page.console, args);
    fail(args.map(String).join(' '));
  };
  page.ReactNativeWebView = {
    postMessage(raw) {
      try {
        const message = JSON.parse(raw);
        proof.messages.push(message);
        proof.sequence.push(message.type);
        if (message.type === 'error') { fail(message.message); return; }
        if (message.type === 'loaded') {
          if (proof.sequence.length !== 1 || typeof page.__hangarTerminalReceive !== 'function') {
            fail('loaded sem receptor registrado ou fora de ordem.');
            return;
          }
          queueMicrotask(() => {
            if (proof.status !== 'pending') return;
            try {
              proof.sequence.push('init');
              page.__hangarTerminalReceive({ type: 'init', foreground: '#eeeeee', cursor: '#33ccff', fontSize: 14, connected: true });
            } catch (error) { fail(error); }
          });
        } else if (message.type === 'ready' || message.type === 'resize') {
          const rect = doc.querySelector('.terminal-host')?.getBoundingClientRect();
          const dimensions = { type: message.type, cols: message.cols, rows: message.rows, width: rect?.width, height: rect?.height };
          proof.dimensions.push(dimensions);
          if (![dimensions.cols, dimensions.rows, dimensions.width, dimensions.height].every(value => Number.isFinite(value) && value > 0)) {
            fail('Dimensões inválidas: ' + JSON.stringify(dimensions));
            return;
          }
          if (message.type === 'ready') {
            if (proof.sequence.join(',') !== 'loaded,init,ready') { fail('ready fora de ordem.'); return; }
            proof.writeSent = true;
            proof.sequence.push('write');
            page.__hangarTerminalReceive({ type: 'write', bytes: Array.from(new TextEncoder().encode('DOM-PTY-OK\r\n')) });
            inspectTerminal();
          }
        }
      } catch (error) { fail(error); }
    },
  };
  page.__terminalDomProof = proof;
  render();
  // O documento entra inteiro, sem substituir xterm, CSS ou runtime pela prova.
  doc.write(JSON.parse(document.getElementById('terminal-document').textContent));
  doc.close();
  window.addEventListener('pagehide', () => { clearTimeout(deadline); observer.disconnect(); }, { once: true });
}

export function createProofServer(html) {
  const proofHtml = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;width:100%;height:100%;background:#151515;color:#eee}iframe{width:100%;height:100%;border:0}pre{position:fixed;bottom:8px;right:8px;max-width:calc(100vw - 32px);max-height:30vh;overflow:auto;white-space:pre-wrap;margin:0;padding:8px;background:#151515;color:#eee;font:12px monospace;pointer-events:none}</style>
</head><body><iframe title="Terminal real"></iframe><pre id="terminal-dom-proof" role="status"></pre>
<script id="terminal-document" type="application/json">${JSON.stringify(html).replace(/</g, '\\u003c')}</script>
<script>(${prepareNativeEnvironment.toString()})();</script></body></html>`;
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'Método não permitido.');
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(request.url.split('?')[0]); } catch { send(400, 'Caminho inválido.'); return; }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
      send(403, 'Caminho não permitido.');
      return;
    }
    if (pathname === '/document') send(200, html, 'text/html; charset=utf-8');
    else if (pathname === '/ready') send(200, proofHtml, 'text/html; charset=utf-8');
    else send(404, 'Página não encontrada.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [portArgument = '8094', ...extra] = process.argv.slice(2);
  const port = Number(portArgument);
  if (extra.length || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Uso: node mobile/scripts/terminal-dom-proof.mjs [porta=8094]');
    process.exitCode = 1;
  } else {
    const server = createProofServer(builder.generateTerminalDocument());
    server.on('error', error => {
      console.error('Falha no servidor de prova:', error.message);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Prova: http://127.0.0.1:${port}/ready`);
      console.log(`HTML exato: http://127.0.0.1:${port}/document`);
      console.log('Inspeção: window.__terminalDomProof e [data-proof]. Recarregue quatro documentos.');
      console.log('Limite: não confirma RNWV nativo, IME ou PTY. Encerre com Ctrl+C.');
    });
  }
}
