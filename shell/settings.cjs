// URL escolhida e geometria da janela, num JSON só dentro do userData do Electron.
// Sem dependência nova (electron-window-state faz isto e mais nada que a gente use).
const fs = require('fs');
const path = require('path');

function arquivo(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

function ler(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(arquivo(userDataDir), 'utf8'));
  } catch {
    // Ausente ou ilegível: começa do zero. Não é erro — é a primeira execução.
    return {};
  }
}

function gravar(userDataDir, dados) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(arquivo(userDataDir), JSON.stringify(dados, null, 2));
  } catch {
    // Disco cheio / permissão: perder a geometria não pode derrubar o app.
  }
}

function urlSemConfig(url) {
  try {
    const u = new URL(url);
    const q = u.hash.indexOf('?');
    if (q < 0) return url;
    const params = new URLSearchParams(u.hash.slice(q + 1));
    if (!params.has('config')) return url;
    params.delete('config');
    params.delete('srv');
    const restantes = params.toString();
    u.hash = u.hash.slice(0, q) + (restantes ? `?${restantes}` : '');
    return u.toString();
  } catch {
    return url;
  }
}

function urlInicial(url) {
  try {
    const u = new URL(urlSemConfig(url));
    u.hash = '#/';
    return u.toString();
  } catch {
    return url;
  }
}

module.exports = { ler, gravar, urlSemConfig, urlInicial };
