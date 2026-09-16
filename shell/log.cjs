// Lançado pelo .desktop (ou pela tarefa no Windows) o Electron nasce com stdout/stderr em
// /dev/null: todo `console.error` do shell — inclusive os `[nav]` que dizem por que uma aba não
// congelou ou não descongelou — morria sem ninguém ler. Aqui cada linha vai TAMBÉM pro log
// privado do Hangar, no mesmo lugar do backend e do instalador.
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const TETO_BYTES = 4 * 1024 * 1024;

function dirLogs() {
  if (process.platform === 'win32') {
    const raiz = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(raiz, 'hangar', 'logs');
  }
  return path.join(os.homedir(), '.hangar', 'logs');
}

// Uma rotação só, na subida: passou do teto, o atual vira `.1` e o `.1` anterior some.
// ponytail: sem rotação em voo; se o shell viver semanas logando muito, revisar.
function instalar({ arquivo = path.join(dirLogs(), 'privado', 'shell.log'), console: con = console } = {}) {
  // Preso ANTES da troca lá embaixo: é por onde as falhas deste arquivo saem. Usar `con.error`
  // depois escreveria no stream que acabou de falhar, e a falha de escrita viraria laço.
  const erroOriginal = con.error.bind(con);
  let stream;
  try {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    let tamanho = 0;
    try { tamanho = fs.statSync(arquivo).size; } catch { /* ainda não existe */ }
    if (tamanho > TETO_BYTES) fs.renameSync(arquivo, `${arquivo}.1`);
    stream = fs.createWriteStream(arquivo, { flags: 'a', mode: 0o600 });
    stream.on('error', (e) => erroOriginal('[log] escrita no shell.log falhou:', e && e.message));
  } catch (e) {
    // Este arquivo existe pra que falha não passe calada — calar a falha DELE seria o pior caso:
    // o log persistente some inteiro e nada no mundo diz por quê.
    erroOriginal('[log] nao deu pra abrir o shell.log:', e && e.message);
    return null;   // disco/permissão: o console original segue valendo
  }
  for (const nivel of ['log', 'warn', 'error']) {
    const original = con[nivel].bind(con);
    con[nivel] = (...args) => {
      original(...args);
      stream.write(`${new Date().toISOString()} ${nivel} ${util.format(...args)}\n`);
    };
  }
  return arquivo;
}

module.exports = { instalar, dirLogs };
