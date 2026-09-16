const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { instalar } = require('./log.cjs');

function consoleFalso() {
  const linhas = [];
  return { linhas, log: (...a) => linhas.push(['log', a]), warn: (...a) => linhas.push(['warn', a]), error: (...a) => linhas.push(['error', a]) };
}

const esperarEscrita = () => new Promise((r) => setTimeout(r, 50));

test('console.error vai pro arquivo e continua indo pro console original', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-log-'));
  const arquivo = path.join(dir, 'privado', 'shell.log');
  const con = consoleFalso();
  assert.equal(instalar({ arquivo, console: con }), arquivo);
  con.error('[nav] aba nao foi para frozen:', 'Target closed');
  con.log('ok %d', 7);
  await esperarEscrita();
  const texto = fs.readFileSync(arquivo, 'utf8');
  assert.match(texto, /Z error \[nav\] aba nao foi para frozen: Target closed\n/);
  assert.match(texto, /Z log ok 7\n/);
  assert.equal(con.linhas.length, 2);
});

test('arquivo acima do teto vira .1 na subida', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-log-'));
  const arquivo = path.join(dir, 'shell.log');
  fs.writeFileSync(arquivo, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
  instalar({ arquivo, console: consoleFalso() });
  await esperarEscrita();
  assert.equal(fs.statSync(`${arquivo}.1`).size, 4 * 1024 * 1024 + 1);
  assert.equal(fs.statSync(arquivo).size, 0);
});

test('diretorio que nao pode ser criado nao derruba o shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-log-'));
  const bloqueio = path.join(dir, 'arquivo-e-nao-pasta');
  fs.writeFileSync(bloqueio, '');
  const con = consoleFalso();
  assert.equal(instalar({ arquivo: path.join(bloqueio, 'shell.log'), console: con }), null);
  // A falha APARECE: este arquivo existe pra que erro não passe calado, e perder o log persistente
  // inteiro em silêncio era o pior caso possível dele.
  assert.equal(con.linhas[0][0], 'error');
  assert.match(con.linhas[0][1][0], /nao deu pra abrir o shell\.log/);
  con.error('segue');
  assert.equal(con.linhas.length, 2);
});
