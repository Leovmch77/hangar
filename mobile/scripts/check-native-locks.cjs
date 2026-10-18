const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const rootPackages = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
const mobilePackages = JSON.parse(readFileSync(path.join(root, 'mobile/package-lock.json'), 'utf8')).packages;

function resolvePackage(packages, importer, name) {
  for (let directory = importer; ; directory = path.posix.dirname(directory)) {
    const candidate = path.posix.join(directory, 'node_modules', name);
    if (packages[candidate]) return candidate;
    if (directory === '.' || directory === '') return undefined;
  }
}

let checked = 0;
for (const [key, entry] of Object.entries(mobilePackages)) {
  if (!key.startsWith('node_modules/')) continue;
  const names = key.slice('node_modules/'.length).split('/node_modules/');
  let rootKey = 'mobile';
  for (const name of names) {
    rootKey = resolvePackage(rootPackages, rootKey, name);
    if (!rootKey) break;
  }
  const localDirectory = path.join(root, 'mobile', key);
  const directory = existsSync(localDirectory) ? localDirectory : rootKey && path.join(root, rootKey);
  if (!directory || !existsSync(directory)) {
    const otherPlatform = (entry.os && !entry.os.includes(process.platform)) || (entry.cpu && !entry.cpu.includes(process.arch));
    if (entry.optional && otherPlatform) continue;
    console.error(`${names.join(' > ')}: instalação incompleta; pacote indisponível para conferir os locks`);
    process.exitCode = 1;
    continue;
  }
  const native = ['expo-module.config.json', 'ios', 'android'].some((name) => existsSync(path.join(directory, name)))
    || readdirSync(directory).some((name) => name.endsWith('.podspec'));
  if (!native) continue;
  checked++;
  const rootVersion = rootKey && rootPackages[rootKey].version;
  if (rootVersion !== entry.version) {
    console.error(`${names.join(' > ')}: raiz=${rootVersion || 'ausente'}, mobile=${entry.version}`);
    process.exitCode = 1;
  }
}
if (!checked) {
  console.error('Nenhum pacote nativo instalado para conferir os locks. Instale as dependências do mobile.');
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log(`Paridade nativa conferida: ${checked} entradas dos locks.`);
}
