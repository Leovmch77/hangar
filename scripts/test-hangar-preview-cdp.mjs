#!/usr/bin/env node
// `--cdp`: o CLI manda endereço e alvo ao app local, sem sessão nem sidecar, e nunca chama o CDP de fora sozinho.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'hangar-preview');
let home;
let server;
const pedidos = [];

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'hangar-preview-cdp-'));
  await mkdir(join(home, '.hangar', 'nav'), { recursive: true });
  server = createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      pedidos.push({ auth: req.headers.authorization, corpo: JSON.parse(corpo) });
      res.end('ok: "http://app.local/agenda"');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await writeFile(join(home, '.hangar', 'nav', '_srv.json'),
    JSON.stringify({ pid: process.pid, porta: server.address().port, token: 'tok' }));
});

after(async () => {
  server.close();
  await rm(home, { recursive: true, force: true });
});

function rodar(argv, extra = {}, casa = home) {
  const env = { ...process.env, HOME: casa, ...extra };
  for (const k of ['CP_SESSION_KEY', 'HANGAR_CANO_KEY', 'CP_SESSION_NAME', 'TMUX', 'TMUX_PANE']) delete env[k];
  if (!('HANGAR_PREVIEW_CDP' in extra)) delete env.HANGAR_PREVIEW_CDP;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...argv], { env });
    let saida = '';
    child.stdout.on('data', (c) => { saida += c; });
    child.stderr.on('data', (c) => { saida += c; });
    child.on('close', (codigo) => resolve({ codigo, saida }));
  });
}

test('--cdp e --alvo vão ao app local, sem sessão', async () => {
  pedidos.length = 0;
  const r = await rodar(['--cdp', 'http://127.0.0.1:9222', '--alvo', '/agenda', 'url']);
  assert.equal(r.codigo, 0, r.saida);
  assert.equal(r.saida.trim(), 'ok: "http://app.local/agenda"');
  assert.deepEqual(pedidos[0].corpo, { cdp: 'http://127.0.0.1:9222', alvo: '/agenda', verbo: 'url', args: [] });
  assert.equal(pedidos[0].auth, 'Bearer tok');
});

test('HANGAR_PREVIEW_CDP vale como --cdp', async () => {
  pedidos.length = 0;
  const r = await rodar(['snapshot'], { HANGAR_PREVIEW_CDP: 'http://127.0.0.1:9222' });
  assert.equal(r.codigo, 0, r.saida);
  assert.deepEqual(pedidos[0].corpo, { cdp: 'http://127.0.0.1:9222', verbo: 'snapshot', args: [] });
});

test('open e --alvo sozinho são recusados', async () => {
  assert.match((await rodar(['--cdp', 'http://127.0.0.1:9222', 'open', 'x'])).saida, /open nao vale com --cdp/);
  assert.match((await rodar(['--alvo', '/x', 'url'])).saida, /--alvo só vale com --cdp/);
});

test('app desktop fechado vira erro claro', async () => {
  const casa = await mkdtemp(join(tmpdir(), 'hangar-preview-cdp-fora-'));
  try {
    const r = await rodar(['--cdp', 'http://127.0.0.1:9222', 'url'], {}, casa);
    assert.equal(r.codigo, 1);
    assert.match(r.saida, /erro: --cdp roda dentro do app desktop/);
  } finally {
    await rm(casa, { recursive: true, force: true });
  }
});
