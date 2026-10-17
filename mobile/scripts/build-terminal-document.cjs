const { readFileSync, watch, writeFileSync } = require('node:fs');
const path = require('node:path');
const terminalDirectory = path.resolve(__dirname, '../src/features/terminal');

function generateTerminalDocument(terminal = terminalDirectory) {
  const read = file => readFileSync(file, 'utf8');
  const script = source => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;
  const libraries = ['@xterm/xterm', '@xterm/addon-fit'].map(name => {
    const main = require.resolve(name);
    const license = read(path.resolve(path.dirname(main), '../LICENSE')).trim();
    return script(`/*!\n${license}\n*/\n${read(main)}`);
  });
  const css = read(require.resolve('@xterm/xterm/css/xterm.css')) + '\n' + read(path.join(terminal, 'terminal.css'));
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<style>${css.replace(/<\/style/gi, '<\\/style')}</style>
</head><body><div id="terminal" class="terminal-host"></div>
${libraries.join('\n')}
${script(read(path.join(terminal, 'terminalPage.js')))}
</body></html>`;
  const output = path.join(terminal, 'terminalDocument.generated.ts');
  const content = `export const terminalDocument = ${JSON.stringify(html)};\n`;
  let previous;
  try { previous = read(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== content) writeFileSync(output, content);
  return html;
}

function watchTerminalDocument(terminal = terminalDirectory) {
  // Observar a pasta preserva os saves por troca de arquivo, sem observar o documento gerado.
  return watch(terminal, { persistent: false }, (_event, filename) => {
    if (filename === 'terminalPage.js' || filename === 'terminal.css') generateTerminalDocument(terminal);
  });
}

module.exports = { generateTerminalDocument, watchTerminalDocument };
if (require.main === module) generateTerminalDocument();
