// scripts/hangar-preview é ESM e fala com o servidor local por HTTP — testável sem Electron,
// como subprocesso de verdade, contra um `subirServidor` real com controlador falso.
//
// spawnSync (síncrono) NÃO SERVE aqui: ele bloqueia o event loop do processo QUE ESTÁ RODANDO O
// TESTE, e é esse mesmo processo que hospeda o servidor HTTP real (`subirServidor`) que o CLI
// filho precisa acessar — child esperando resposta, pai bloqueado esperando o child terminar,
// nunca sai (medido: trava os 30s do teste). `spawn` assíncrono mantém o event loop do pai vivo
// pra atender a requisição do filho.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { subirServidor } = require('./preview_srv.cjs');
const { nomeSidecar } = require('./navegador.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'hangar-preview');
const CHAVE = 'srv::sessaoteste';

function homeComSidecar(dadosSrv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-preview-cli-'));
  const dir = path.join(home, '.hangar', 'nav');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_srv.json'), JSON.stringify(dadosSrv));
  fs.writeFileSync(path.join(dir, `${nomeSidecar(CHAVE)}.json`),
    JSON.stringify({ chave: CHAVE, url: 'http://x.test', targetId: null, ts: Date.now() }));
  return home;
}

function rodarCli(args, { entrada = null, home } = {}) {
  return new Promise((resolvePromise, reject) => {
    const filho = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } });
    let stdout = '';
    let stderr = '';
    filho.stdout.on('data', (d) => { stdout += d; });
    filho.stderr.on('data', (d) => { stderr += d; });
    filho.on('error', reject);
    filho.on('close', (status) => resolvePromise({ status, stdout, stderr }));
    if (entrada != null) filho.stdin.end(entrada); else filho.stdin.end();
  });
}

test('batch para na primeira linha que falha, sai com codigo 1 e nao roda o resto', async () => {
  const chamadas = [];
  const ctlFalso = {
    enfileirar: (fn) => fn(),
    avaliar: async (js) => {
      chamadas.push(js);
      return js === 'FAIL' ? 'erro: falhou de proposito' : `ok: ${js}`;
    },
  };
  const srv = await subirServidor({ controladorDe: () => ctlFalso, escrever: () => {} });
  const home = homeComSidecar({ porta: srv.porta, token: srv.token, pid: process.pid });

  const r = await rodarCli(['batch', '--sessao', 'sessaoteste'], { entrada: 'eval OK1\neval FAIL\neval OK2\n', home });
  srv.fechar();

  assert.equal(r.status, 1);
  assert.match(r.stdout, /ok: OK1/);
  assert.match(r.stdout, /erro: falhou de proposito/);
  assert.doesNotMatch(r.stdout, /OK2/);
  assert.deepEqual(chamadas, ['OK1', 'FAIL'], 'a terceira linha nunca roda');
  assert.match(r.stderr, /linha 2/, 'informa qual linha parou');
});

test('--aba vai no corpo do pedido e tab vira verbo tab-*', async () => {
  const pedidos = [];
  const srv = await subirServidor({
    controladorDe: (_c, aba) => ({ enfileirar: (fn) => fn(), avaliar: async () => { pedidos.push({ aba }); return 'http://x.test'; } }),
    escrever: () => {},
    abasDe: () => ({ ativa: 1, abas: [{ id: 1, url: 'http://x.test', titulo: 'X' }] }),
    abaTrocar: async (_c, id) => { pedidos.push({ trocou: id }); return { ok: true }; },
  });
  const home = homeComSidecar({ porta: srv.porta, token: srv.token, pid: process.pid });

  await rodarCli(['url', '--aba', '3', '--sessao', 'sessaoteste'], { home });
  const t = await rodarCli(['tab', '2', '--sessao', 'sessaoteste'], { home });
  srv.fechar();

  assert.deepEqual(pedidos[0], { aba: 3 }, '--aba chega no servidor');
  assert.deepEqual(pedidos[1], { trocou: 2 }, 'tab <id> vira tab-switch');
  assert.equal(t.status, 0);
});

// O `list` confere no CDP da 9223 quem está vivo, então o teste precisa de ALGUÉM respondendo ali.
// Sobe um falso; com a porta ocupada (app do usuário aberto) usa quem já responde, e só devolve
// null — para o teste pular — quando ninguém responde.
async function cdpParaOList() {
  const falso = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  const subiu = await new Promise((r) => {
    falso.once('error', () => r(false));
    falso.listen(9223, '127.0.0.1', () => r(true));
  });
  if (subiu) return () => falso.close();
  try { await (await fetch('http://127.0.0.1:9223/json/list')).json(); return () => {}; } catch { return null; }
}

test('list mostra a aba ativa e a contagem, e le sidecar antigo como uma aba', async (t) => {
  const parar = await cdpParaOList();
  if (!parar) return t.skip('a 9223 esta ocupada por quem nao responde /json/list: o `list` erraria por falta de CDP, nao pelo formato');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-preview-list-'));
  const dir = path.join(home, '.hangar', 'nav');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${nomeSidecar('srv::nova')}.json`), JSON.stringify({
    chave: 'srv::nova', url: 'http://dois.test', targetId: null, ativa: 2,
    abas: [{ id: 1, url: 'http://um.test', titulo: 'Um', targetId: null },
      { id: 2, url: 'http://dois.test', titulo: 'Dois', targetId: null }],
  }));
  fs.writeFileSync(path.join(dir, `${nomeSidecar('srv::velha')}.json`), JSON.stringify({
    chave: 'srv::velha', url: 'http://tres.test', targetId: null,
  }));

  const r = await rodarCli(['list'], { home });
  parar();
  assert.match(r.stdout, /srv::nova.*\(aba 2 de 2\)/);
  assert.doesNotMatch(r.stdout.split('\n').find((l) => l.includes('srv::velha')) || '', /aba/,
    'sidecar sem abas (shell antigo) sai como hoje');
});

test('sidecar com pid morto e recusado com a mesma mensagem do sidecar ausente', async () => {
  const pidMorto = 999999; // improvável de existir; se existir por acaso, o teste é inconclusivo
  const home = homeComSidecar({ porta: 1, token: 'x', pid: pidMorto });

  const r = await rodarCli(['url', '--sessao', 'sessaoteste'], { home });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nao esta no ar/);
});
