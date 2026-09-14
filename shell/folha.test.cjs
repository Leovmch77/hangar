const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const folha = require('./folha.cjs');

test('colunas e lotes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(folha.colunas), [1, 2, 2, 2, 3, 3]);
  assert.deepEqual(folha.lotes([1, 2, 3, 4, 5, 6, 7]).map((l) => l.length), [6, 1]);
});

test('célula nunca amplia e cabe no teto', () => {
  assert.deepEqual(folha.celula(390, 844), [390, 844]);
  assert.deepEqual(folha.celula(2560, 1600), [1280, 800]);
});

test('rótulos numeram a partir do início do lote', () => {
  const args = folha.argsMagick(['/x/a.png', '/x/b.png'], { inicio: 7, cel: [100, 50], fonte: null, saida: '/x/o.png' });
  const rotulos = args.flatMap((a, i) => (a === '-annotate' ? [args[i + 2]] : []));
  assert.deepEqual(rotulos, [' 7  a.png ', ' 8  b.png ']);
  assert.equal(args.at(-1), '/x/o.png');
});

let temMagick = true;
try { execFileSync('magick', ['-version'], { stdio: 'ignore' }); } catch { temMagick = false; }

test('montar gera uma folha por lote de 6', { skip: !temMagick && 'sem magick' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folha-test-'));
  const imgs = Array.from({ length: 7 }, (_, i) => {
    const p = path.join(dir, `p${i}.png`);
    execFileSync('magick', ['-size', '320x200', 'xc:#336699', p]);
    return p;
  });
  const saidas = folha.montar(imgs, { dir });
  assert.equal(saidas.length, 2);
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', saidas[0]], { encoding: 'utf8' }).split(' ').map(Number);
  assert.ok(w > 320 * 3 && h > 200 * 2, `folha 3x2 esperada, veio ${w}x${h}`);
  assert.throws(() => folha.montar([path.join(dir, 'nada.png')], { dir }), /não existe/);
  fs.rmSync(dir, { recursive: true, force: true });
});
