// Junta vários prints numa grade só. O modelo reduz toda imagem a um teto fixo de pixels, então N
// prints separados custam N imagens de contexto e a folha custa uma — em troca de resolução.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Acima disso cada tela fica pequena demais pra ler texto depois da redução do modelo.
const MAX_POR_FOLHA = 6;
// Lado maior que o modelo recebe; gravar maior só gasta disco e deixa o rótulo desproporcional.
const TETO = 2000;
const CELULA_MAX = 1280;

function colunas(n) {
  return n <= 2 ? n : n <= 4 ? 2 : 3;
}

function lotes(arqs, max = MAX_POR_FOLHA) {
  const out = [];
  for (let i = 0; i < arqs.length; i += max) out.push(arqs.slice(i, i + max));
  return out;
}

// Célula = tamanho do primeiro print, reduzido pra caber em CELULA_MAX; os outros se ajustam a ela.
function celula(w, h) {
  const k = Math.min(1, CELULA_MAX / w, CELULA_MAX / h);
  return [Math.round(w * k), Math.round(h * k)];
}

function argsMagick(arqs, { inicio = 1, cel, fonte, saida }) {
  const [w, h] = cel;
  const cols = colunas(arqs.length);
  const linhas = Math.ceil(arqs.length / cols);
  // Rótulo com ~18px DEPOIS da redução final, qualquer que seja o número de colunas.
  const escala = Math.min(1, TETO / Math.max(cols * (w + 12), linhas * (h + 12)));
  const pt = String(Math.round(18 / escala));
  const args = [];
  for (let r = 0; r < arqs.length; r += cols) {
    args.push('(');
    arqs.slice(r, r + cols).forEach((arq, i) => {
      args.push('(', arq, '-resize', `${w}x${h}`, '-background', '#1b1b1f', '-gravity', 'center',
        '-extent', `${w}x${h}`);
      if (fonte) args.push('-font', fonte);
      args.push('-gravity', 'NorthWest', '-pointsize', pt, '-fill', '#ffffff', '-undercolor', '#000000cc',
        '-annotate', '+10+10', ` ${inicio + r + i}  ${path.basename(arq)} `,
        '-bordercolor', '#0b0b0d', '-border', '6', ')');
    });
    args.push('-background', '#0b0b0d', '+append', ')');
  }
  args.push('-background', '#0b0b0d', '-gravity', 'NorthWest', '-append', '-resize', `${TETO}x${TETO}>`, saida);
  return args;
}

// Sem fontconfig configurado o magick do Linux falha no -annotate ("unable to read font (null)").
function acharFonte() {
  try {
    return execFileSync('fc-match', ['-f', '%{file}', 'sans:bold'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function magick(args, opts) {
  try {
    return execFileSync('magick', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('magick não encontrado — instale o ImageMagick 7');
    throw new Error(`magick falhou: ${String(err.stderr || err.message).trim()}`);
  }
}

function carimbo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// Devolve o caminho de cada folha gerada (uma a cada MAX_POR_FOLHA prints).
function montar(arqs, { dir, prefixo = 'folha' }) {
  if (!arqs.length) throw new Error('nenhuma imagem pra juntar');
  for (const a of arqs) if (!fs.existsSync(a)) throw new Error(`não existe: ${a}`);
  fs.mkdirSync(dir, { recursive: true });
  const [w, h] = magick(['identify', '-format', '%w %h', `${arqs[0]}[0]`]).trim().split(' ').map(Number);
  const cel = celula(w, h);
  const fonte = acharFonte();
  const base = `${prefixo}-${carimbo()}`;
  const grupos = lotes(arqs);
  return grupos.map((grupo, k) => {
    const saida = path.resolve(dir, grupos.length > 1 ? `${base}-${k + 1}.png` : `${base}.png`);
    magick(argsMagick(grupo, { inicio: k * MAX_POR_FOLHA + 1, cel, fonte, saida }));
    return saida;
  });
}

module.exports = { MAX_POR_FOLHA, colunas, lotes, celula, argsMagick, montar };
